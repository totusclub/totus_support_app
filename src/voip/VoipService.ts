/**
 * VoIP-движок Totus Support (WebRTC + CallKeep + PushKit/FCM + Socket.IO-сигнализация).
 *
 * Перенесён из totus_APP/src/modules/voip/VoipService.ts (клиентское приложение) без изменения
 * протокола: те же эндпоинты calling_api_v2 (/api/register-device, /api/calls*, /api/ice-servers),
 * те же события Socket.IO (registerDevice, offer, answer, ice-candidate, call-state) и тот же
 * формат VoIP-пушей. Отличия от оригинала: авторизация — agent-JWT (src/api/voipAuth.ts),
 * имена CallKeep/каналов — «Totus Support». Сигнальная часть совпадает с панелью агента
 * calling_v2/lib/webrtc-service.ts (порядок offer → answer → ICE, очередь ICE до remoteDescription,
 * HTTP-поллинг ответа как фолбэк).
 */
import {AppState, AppStateStatus, Platform, PermissionsAndroid} from 'react-native';
import VoipPushNotification from 'react-native-voip-push-notification';
import RNCallKeep, {IOptions} from 'react-native-callkeep';
import InCallManager from 'react-native-incall-manager';
import io from 'socket.io-client';
import NetInfo, {NetInfoState} from '@react-native-community/netinfo';
import messaging, {
  FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import {VOIP_BASE_URL} from '../config/server';
// agent-JWT (вход POST /api/web/login): Bearer в HTTP и токен в handshake Socket.io.
import {voipFetch, voipSocketAuth, setVoipAccessToken} from '../api/voipAuth';
import {
  createAnswerGate,
  decideOnResume,
  offerRetryDelayMs,
  OFFER_FETCH_MAX_ATTEMPTS,
  summarizeInitialCallKeepEvents,
} from './answerRecovery';
import {
  startAndroidCallForegroundService,
  stopAndroidCallForegroundService,
} from './AndroidCallForegroundService';
import {
  nativeStopVoipService,
  nativeUpdateConnectionStatus,
} from './NativeVoipOrchestrator';
import {
  ensureAndroidBatteryOptimizationHandled,
  maybePromptAndroidVoipPowerSetup,
} from './AndroidPowerManager';
// Sound is optional - TEMPORARILY DISABLED to prevent crashes
// Set to true when you have sound files properly set up
const ENABLE_SOUND_RINGTONES = true;
const USE_ANDROID_CALLKEEP_INCOMING_UI = false;

let Sound: any = null;
let SoundAvailable = false;

if (ENABLE_SOUND_RINGTONES) {
  try {
    const SoundModule = require('react-native-sound');
    Sound = SoundModule.default || SoundModule;
    // Verify Sound is actually usable
    if (Sound && typeof Sound === 'function' && Sound.MAIN_BUNDLE !== undefined) {
      SoundAvailable = true;
    } else {
      console.warn('react-native-sound not properly initialized - calls will work without custom ringtones');
      Sound = null;
    }
  } catch (e) {
    console.warn('react-native-sound not available - calls will work without custom ringtones:', e);
    Sound = null;
  }
} else {
  console.log('Sound ringtones disabled - calls will work normally, iOS CallKit handles system ringtone');
}
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  MediaStream,
  RTCAudioSession,
} from 'react-native-webrtc';

const BASE_URL = VOIP_BASE_URL;

const CALLKEEP_OPTIONS: IOptions = {
  ios: {
    appName: 'Totus Support',
    includesCallsInRecents: true,
    // voice-only calls
    supportsVideo: false,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
  },
  android: {
    alertTitle: 'Phone Accounts',
    alertDescription: 'Разрешите Totus Support управлять звонками',
    cancelButton: 'Cancel',
    okButton: 'OK',
    selfManaged: false,
    foregroundService: {
      channelId: 'totus-support-call-channel',
      channelName: 'Звонки Totus Support',
      notificationTitle: 'Totus Support — звонок',
      notificationIcon: 'ic_notification',
    },
    additionalPermissions: [
      'android.permission.READ_PHONE_STATE',
      'android.permission.RECORD_AUDIO',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.BLUETOOTH_CONNECT',
    ],
  },
};

function buildCallKeepSetupOptions(): IOptions {
  const androidOptions = (CALLKEEP_OPTIONS as any)?.android || {};
  const iosOptions = (CALLKEEP_OPTIONS as any)?.ios || {};
  return {
    ios: {
      appName: iosOptions?.appName || 'Totus Support',
      includesCallsInRecents:
        typeof iosOptions?.includesCallsInRecents === 'boolean'
          ? iosOptions.includesCallsInRecents
          : true,
      supportsVideo:
        typeof iosOptions?.supportsVideo === 'boolean'
          ? iosOptions.supportsVideo
          : false,
      maximumCallGroups: iosOptions?.maximumCallGroups || '1',
      maximumCallsPerCallGroup: iosOptions?.maximumCallsPerCallGroup || '1',
    },
    android: {
      alertTitle: androidOptions?.alertTitle || 'Phone Accounts',
      alertDescription:
        androidOptions?.alertDescription || 'Разрешите Totus Support управлять звонками',
      cancelButton: androidOptions?.cancelButton || 'Cancel',
      okButton: androidOptions?.okButton || 'OK',
      selfManaged: false,
      foregroundService: {
        channelId:
          androidOptions?.foregroundService?.channelId || 'totus-support-call-channel',
        channelName:
          androidOptions?.foregroundService?.channelName || 'Звонки Totus Support',
        notificationTitle:
          androidOptions?.foregroundService?.notificationTitle ||
          'Totus Support — звонок',
        notificationIcon:
          androidOptions?.foregroundService?.notificationIcon || 'ic_notification',
      },
      additionalPermissions: Array.isArray(androidOptions?.additionalPermissions)
        ? androidOptions.additionalPermissions
        : [
            'android.permission.READ_PHONE_STATE',
            'android.permission.RECORD_AUDIO',
            'android.permission.POST_NOTIFICATIONS',
            'android.permission.BLUETOOTH_CONNECT',
          ],
    },
  } as IOptions;
}

export function safeAndroidDisplayIncomingCall(
  callUUID: string,
  handle: string,
  callerName: string,
): void {
  if (Platform.OS !== 'android') {
    return;
  }

  const invokeDisplay = () =>
    RNCallKeep.displayIncomingCall(callUUID, handle, callerName, 'generic', true);

  try {
    invokeDisplay();
  } catch (e: any) {
    const errorMessage = String(e?.message || e || '');
    const likelyMissingSetup =
      errorMessage.includes('alertTitle') || errorMessage.includes('setSettings');
    telecomDebug('displayIncomingCall_first_attempt_failed', {
      callUUID,
      errorMessage: errorMessage || null,
      likelyMissingSetup,
    });
    if (!likelyMissingSetup) {
      throw e;
    }
    try {
      const options = buildCallKeepSetupOptions();
      RNCallKeep.setup(options);
      RNCallKeep.setAvailable(true);
      telecomDebug('displayIncomingCall_setup_retry_ready', {callUUID});
      invokeDisplay();
      telecomDebug('displayIncomingCall_setup_retry_success', {callUUID});
    } catch (retryError: any) {
      telecomDebug('displayIncomingCall_setup_retry_failed', {
        callUUID,
        errorMessage: String(retryError?.message || retryError || ''),
      });
      throw retryError;
    }
  }
}

function maybeCallKeepStartCall(
  callUUID: string,
  handle: string,
  displayName: string,
): void {
  if (Platform.OS === 'android') {
    console.log('Android: skip RNCallKeep.startCall (use custom UI only)');
    return;
  }
  RNCallKeep.startCall(callUUID, handle, displayName, 'number', false);
}

function maybeCallKeepSetCurrentCallActive(callUUID: string): void {
  if (Platform.OS === 'android') {
    return;
  }
  RNCallKeep.setCurrentCallActive(callUUID);
}

function maybeCallKeepAnswerIncomingCall(callUUID: string): void {
  if (Platform.OS === 'android') {
    console.log('Android: skip RNCallKeep.answerIncomingCall (custom incoming UI)');
    return;
  }
  RNCallKeep.answerIncomingCall(callUUID);
}

// Simple WebRTC voice-call state (single active call)
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let activeCallUUID: string | null = null;
let incomingCallUUID: string | null = null; // Track incoming call UUID before answer
let currentLoyaltyId: string | null = null; // Store loyalty_id from logged-in user
let currentDeviceId: string | null = null;
let socket: ReturnType<typeof io> | null = null;
let activeCallStartedAt: number | null = null;
let ringback: any | null = null;
let isRingbackPlaying = false;
let incomingRingtone: any | null = null;
let isIncomingRingtonePlaying = false;
let isVoipInitialized = false;
// Call state tracking for UI
type CallState = 'idle' | 'calling' | 'ringing' | 'answered' | 'ended' | 'rejected';
// Connection state tracking
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed';
let currentCallState: CallState = 'idle';
let connectionState: ConnectionState | null = null;
let callerName: string | null = null;
let isMuted = false;
let isSpeakerEnabled = false;
// Speaker mode: 'earpiece' (front) or 'loudspeaker' (back)
type SpeakerMode = 'earpiece' | 'loudspeaker';
let currentSpeakerMode: SpeakerMode = 'earpiece';
let lastSpeakerToggleMs = 0;
const SPEAKER_TOGGLE_DEBOUNCE_MS = 400;
// Track if answer has been processed to prevent duplicate setRemoteDescription calls
let answerProcessedForCall: string | null = null;
// Store pending answer action when app is opening from closed state
let pendingAnswerCallUUID: string | null = null;
// Flag to prevent infinite loop when answering programmatically
let isAnsweringProgrammatically = false;
let lastAcceptedCallUUID: string | null = null;
let lastAcceptedAtMs = 0;
let fcmTokenRefreshUnsubscribe: (() => void) | null = null;
const recentlyHandledIncomingCalls = new Map<string, number>();
const DUPLICATE_INCOMING_WINDOW_MS = 15000;
const incomingOfferByCallId = new Map<string, {type: string; sdp: string}>();
// One answer per call (see answerRecovery.ts): no second RTCPeerConnection for the same call.
const answerGate = createAnswerGate();
let voipResumeSubscription: {remove: () => void} | null = null;
// Network monitoring
let networkUnsubscribe: (() => void) | null = null;
let isNetworkMonitoring = false;
let lastNetworkState: NetInfoState | null = null;
let reconnectionTimeout: NodeJS.Timeout | null = null;
let appStateSubscription: {remove: () => void} | null = null;
let nativeConnectionStatusInterval: NodeJS.Timeout | null = null;
let isVoipInitializing = false;
let isCallTransitionLocked = false;
let activeCallLockUUID: string | null = null;
let inCallAudioEventRemovers: Array<() => void> = [];
let lastIceRestartAtMs = 0;
let isIceRestartInProgress = false;
const ICE_RESTART_COOLDOWN_MS = 2500;
const TELEMETRY_ENABLED = true;
let isIncomingDisplayWindowActive = false;
let isAndroidTelecomReady = false;
let telecomInitPromise: Promise<void> | null = null;
let lastTelecomAudit: {
  supportsConnectionService: boolean | null;
  hasPhoneAccount: boolean | null;
  phoneAccountEnabled: boolean | null;
  hasDefaultPhoneAccount: boolean | null;
  timestamp: number | null;
} = {
  supportsConnectionService: null,
  hasPhoneAccount: null,
  phoneAccountEnabled: null,
  hasDefaultPhoneAccount: null,
  timestamp: null,
};

function androidTelemetry(event: string, payload?: Record<string, any>): void {
  if (!TELEMETRY_ENABLED || Platform.OS !== 'android') {
    return;
  }
  try {
    if (!payload) {
      console.log(`[VOIP_ANDROID] ${event}`);
      return;
    }
    console.log(`[VOIP_ANDROID] ${event}`, payload);
  } catch (_) {}
}

function telecomDebug(event: string, payload?: Record<string, any>): void {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    if (!payload) {
      console.log(`[VOIP_TELECOM_ANDROID] ${event}`);
      return;
    }
    console.log(`[VOIP_TELECOM_ANDROID] ${event}`, payload);
  } catch (_) {}
}

async function runAndroidTelecomRegistrationAudit(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const callKeepAny = RNCallKeep as any;
  try {
    const supportsConnectionService = typeof callKeepAny?.supportConnectionService === 'function'
      ? await Promise.resolve(callKeepAny.supportConnectionService())
      : null;
    telecomDebug('supportConnectionService', {supportsConnectionService});
    lastTelecomAudit.supportsConnectionService = supportsConnectionService;

    telecomDebug('registerPhoneAccount_skipped_managed_by_setup');

    if (typeof callKeepAny?.registerAndroidEvents === 'function') {
      await Promise.resolve(callKeepAny.registerAndroidEvents());
      telecomDebug('registerAndroidEvents_success');
    } else {
      telecomDebug('registerAndroidEvents_not_exposed');
    }

    if (typeof callKeepAny?.hasPhoneAccount === 'function') {
      const hasPhoneAccount = await Promise.resolve(callKeepAny.hasPhoneAccount());
      telecomDebug('hasPhoneAccount', {hasPhoneAccount});
      lastTelecomAudit.hasPhoneAccount = hasPhoneAccount;
    }

    if (typeof callKeepAny?.checkPhoneAccountEnabled === 'function') {
      const phoneAccountEnabled = await Promise.resolve(callKeepAny.checkPhoneAccountEnabled());
      telecomDebug('phoneAccountEnabled', {phoneAccountEnabled});
      lastTelecomAudit.phoneAccountEnabled = phoneAccountEnabled;
      if (!phoneAccountEnabled) {
        telecomDebug('phoneAccount_disabled_warning');
      }
    }

    if (typeof callKeepAny?.hasDefaultPhoneAccount === 'function') {
      const hasDefaultPhoneAccount = await Promise.resolve(callKeepAny.hasDefaultPhoneAccount());
      telecomDebug('hasDefaultPhoneAccount', {hasDefaultPhoneAccount});
      lastTelecomAudit.hasDefaultPhoneAccount = hasDefaultPhoneAccount;
      if (!hasDefaultPhoneAccount) {
        telecomDebug('default_calling_account_not_set_warning');
      }
    } else {
      telecomDebug('hasDefaultPhoneAccount_not_exposed');
    }

    lastTelecomAudit.timestamp = Date.now();

    isAndroidTelecomReady = true;
  } catch (e: any) {
    telecomDebug('telecom_registration_error', {
      errorName: e?.name || 'Error',
      errorMessage: e?.message || String(e),
      isSecurityException: String(e?.message || '').includes('SecurityException'),
    });
    throw e;
  }
}

export async function ensureAndroidTelecomReady(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  if (isAndroidTelecomReady) {
    return;
  }
  if (telecomInitPromise) {
    await telecomInitPromise;
    return;
  }
  telecomInitPromise = (async () => {
    await runAndroidTelecomRegistrationAudit();
  })();
  try {
    await telecomInitPromise;
  } finally {
    telecomInitPromise = null;
  }
}

export function getAndroidTelecomAuditState(): {
  supportsConnectionService: boolean | null;
  hasPhoneAccount: boolean | null;
  phoneAccountEnabled: boolean | null;
  hasDefaultPhoneAccount: boolean | null;
  isReady: boolean;
  timestamp: number | null;
} {
  return {
    supportsConnectionService: lastTelecomAudit.supportsConnectionService,
    hasPhoneAccount: lastTelecomAudit.hasPhoneAccount,
    phoneAccountEnabled: lastTelecomAudit.phoneAccountEnabled,
    hasDefaultPhoneAccount: lastTelecomAudit.hasDefaultPhoneAccount,
    isReady: isAndroidTelecomReady,
    timestamp: lastTelecomAudit.timestamp,
  };
}

export async function runAndroidTelecomSystemAuditNow(): Promise<void> {
  await ensureAndroidTelecomReady();
  telecomDebug('telecom_audit_snapshot', getAndroidTelecomAuditState());
}

export function openAndroidCallingAccountSettings(): void {
  if (Platform.OS !== 'android') {
    return;
  }
  const callKeepAny = RNCallKeep as any;
  try {
    if (typeof callKeepAny?.hasDefaultPhoneAccount === 'function') {
      callKeepAny.hasDefaultPhoneAccount((enabled: boolean) => {
        telecomDebug('hasDefaultPhoneAccount_callback', {enabled});
      });
    }
    if (typeof callKeepAny?.openPhoneAccounts === 'function') {
      callKeepAny.openPhoneAccounts();
      telecomDebug('openPhoneAccounts_called');
    } else {
      telecomDebug('openPhoneAccounts_not_exposed');
    }
  } catch (e: any) {
    telecomDebug('openPhoneAccounts_error', {
      errorName: e?.name || 'Error',
      errorMessage: e?.message || String(e),
    });
  }
}

function tryAcquireCallLock(uuid: string, source: string): boolean {
  if (isCallTransitionLocked && activeCallLockUUID && activeCallLockUUID !== uuid) {
    androidTelemetry('call_lock_denied', {source});
    return false;
  }
  isCallTransitionLocked = true;
  activeCallLockUUID = uuid;
  return true;
}

function releaseCallLock(uuid?: string): void {
  if (!uuid || activeCallLockUUID === uuid) {
    isCallTransitionLocked = false;
    activeCallLockUUID = null;
  }
}

// Queue for ICE candidates received before remote description is set
let queuedIceCandidates: Array<{ callId: string; candidate: any; fromDeviceId: string }> = [];

// Process queued ICE candidates after remote description is set
async function processQueuedIceCandidates(callId: string) {
  if (!pc || !pc.remoteDescription) {
    return;
  }

  const candidatesToProcess = queuedIceCandidates.filter(c => c.callId === callId);
  if (candidatesToProcess.length === 0) {
    return;
  }

  console.log(`📞 Processing ${candidatesToProcess.length} queued ICE candidates for call:`, callId);

  // Remove processed candidates from queue immediately to avoid duplicates
  queuedIceCandidates = queuedIceCandidates.filter(c => c.callId !== callId);

  // Process each candidate sequentially to avoid race conditions
  for (const data of candidatesToProcess) {
    try {
      if (data.candidate && data.candidate.candidate && pc && pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        console.log('✅ Added queued ICE candidate');
      }
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      // Don't log expected errors (candidate might already be added)
      if (!errorMsg.includes('Invalid candidate') &&
          !errorMsg.includes('InvalidStateError') &&
          !errorMsg.includes('remote description was null') &&
          !errorMsg.includes('OperationError')) {
        console.warn('⚠️ Failed to add queued ICE candidate:', errorMsg);
      }
    }
  }

  console.log(`✅ Finished processing ${candidatesToProcess.length} queued ICE candidates`);
}

// ICE failure tracking and recovery
let iceRestartAttempts = 0;
const MAX_ICE_RESTART_ATTEMPTS = 3;
let iceFailureTimeout: NodeJS.Timeout | null = null;

// Register device with backend using current token and loyalty_id
async function registerDeviceWithBackend(token: string, loyaltyId: string | null): Promise<void> {
  // Ensure token is clean (no spaces, trimmed)
  const cleanToken = token.replace(/\s+/g, '').trim();

  if (!cleanToken || cleanToken.length === 0) {
    throw new Error('Invalid token: token is empty after cleaning');
  }

  // Backend requires loyaltyId for registration
  // If loyaltyId is not available, skip backend registration and only register on socket
  // Backend registration will happen later when user logs in and loyaltyId is set
  if (!loyaltyId) {
    console.log('⚠️ Skipping backend registration - loyaltyId not available yet');
    console.log('   Device will be registered with backend once user logs in');
    console.log('   Token stored:', cleanToken.substring(0, 20) + '...');

    // Still register on Socket.IO for real-time features (without loyaltyId)
    // but avoid interfering with incoming native UI window.
    if (!isIncomingUiWindowActive()) {
      ensureSocketConnected();
      socket?.emit('registerDevice', {
        deviceId: cleanToken,
      });
    }
    // console.log('📡 Device registered on Socket.IO (without loyaltyId)');
    return;
  }

  // Build request body with loyaltyId
  const requestBody: any = {
    deviceId: cleanToken,
    voipToken: cleanToken,
    platform: Platform.OS,
    loyaltyId: loyaltyId,
    // Backend must push to <bundleId>.voip. The club app topic will not reach this app.
    bundleId: 'club.totus.support',
  };

  // console.log('📤 Sending device registration to backend:');
  // console.log('   deviceId:', cleanToken);
  // console.log('   voipToken:', cleanToken);
  // console.log('   platform:', Platform.OS);
  // console.log('   loyaltyId:', loyaltyId);

  try {
    const response = await voipFetch(`${BASE_URL}/api/register-device`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Backend registration failed:', response.status, errorText);
      throw new Error(`Backend registration failed: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json().catch(() => ({}));
    // console.log('✅ Backend registration successful:', responseData);
    // console.log('   Device registered with loyalty_id:', loyaltyId);
  } catch (e: any) {
    console.error('❌ Failed to register/update device on backend');
    console.error('   Error:', e?.message || e);
    console.error('   Token sent:', cleanToken);
    console.error('   Token length:', cleanToken.length);
    throw e;
  }

  // Also register this device on the Socket.IO signalling channel
  // but avoid interfering with incoming native UI window.
  if (!isIncomingUiWindowActive()) {
    ensureSocketConnected();
    socket?.emit('registerDevice', {
      deviceId: cleanToken,
      loyaltyId: loyaltyId,
    });
  }
  // console.log('📡 Device registered on Socket.IO');
}

/**
 * Unregister device from backend on logout.
 * Clears the user's voipToken so the device no longer receives VoIP pushes for that user.
 * CRITICAL for account switching: without this, the old user would still receive calls on this device.
 */
async function unregisterDeviceWithBackend(loyaltyId: string): Promise<void> {
  if (!loyaltyId) return;
  try {
    const response = await voipFetch(`${BASE_URL}/api/unregister-device`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({loyaltyId}),
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn('⚠️ Unregister device failed:', response.status, text);
      return;
    }
    console.log('✅ Unregistered device for user:', loyaltyId);
  } catch (e: any) {
    console.warn('⚠️ Failed to unregister device on logout:', e?.message || e);
  }
}

const generateUUID = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

async function requestAndroidCallPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  try {
    const permissions = [
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    ] as any;
    if (Platform.Version >= 31) {
      permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    }
    if (Platform.Version >= 33) {
      permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }

    const result = await PermissionsAndroid.requestMultiple(permissions);
    const recordAudioGranted =
      result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
      PermissionsAndroid.RESULTS.GRANTED;
    const readPhoneGranted =
      result[PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE] ===
      PermissionsAndroid.RESULTS.GRANTED;
    const bluetoothGranted =
      Platform.Version < 31 ||
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
        PermissionsAndroid.RESULTS.GRANTED;

    // For VoIP WebRTC calls, RECORD_AUDIO is mandatory.
    // READ_PHONE_STATE is useful for telecom integration but should not block call answer.
    if (!readPhoneGranted) {
      console.warn(
        'Android READ_PHONE_STATE denied - continuing with limited CallKeep features',
      );
    }
    if (!bluetoothGranted) {
      console.warn(
        'Android BLUETOOTH_CONNECT denied - Bluetooth headset routing may be limited',
      );
    }

    return recordAudioGranted;
  } catch (e) {
    console.warn('Failed to request Android call permissions', e);
    return false;
  }
}

type AndroidIncomingNotification = {
  callUUID: string;
  callerDisplayName: string;
  handle: string;
  toLoyaltyId: string | null;
  offer: {type: string; sdp: string} | null;
};

function normalizeAndroidIncomingNotification(
  payload: any,
): AndroidIncomingNotification | null {
  const data = payload?.data ?? payload ?? {};
  const callUUID = data.callId || data.uuid;
  if (!callUUID) {
    return null;
  }
  return {
    callUUID: String(callUUID),
    callerDisplayName:
      data.callerName || data.caller_name || data.handle || 'Incoming call',
    handle: data.handle || data.from || 'caller',
    toLoyaltyId: data.toLoyaltyId || data.toUserId || null,
    offer:
      data.offerSdp && (data.offerType || 'offer')
        ? {type: data.offerType || 'offer', sdp: data.offerSdp}
        : null,
  };
}

function activateAndroidAudioSession(context: string): void {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    InCallManager.start({media: 'audio', auto: true});
    InCallManager.setKeepScreenOn(true);
    InCallManager.setSpeakerphoneOn(currentSpeakerMode === 'loudspeaker');
    InCallManager.setMicrophoneMute(isMuted);
  } catch (e) {
    console.warn(`Android audio session activation failed (${context})`, e);
  }
  androidTelemetry('audio_session_activated', {context, speakerMode: currentSpeakerMode, muted: isMuted});
}

function registerAndroidAudioRouteObservers(): void {
  if (Platform.OS !== 'android' || inCallAudioEventRemovers.length > 0) {
    return;
  }
  const addInCallListener = (eventName: string, handler: (data?: any) => void) => {
    try {
      const remover = (InCallManager as any).addEventListener?.(eventName, handler);
      if (typeof remover === 'function') {
        inCallAudioEventRemovers.push(remover);
      }
    } catch (e) {
      console.warn(`InCallManager listener registration failed: ${eventName}`, e);
    }
  };

  addInCallListener('WiredHeadset', (data: any) => {
    androidTelemetry('audio_route_wired', {isPlugged: !!data?.isPlugged});
    activateAndroidAudioSession('wired-headset-change');
  });
  addInCallListener('NoisyAudio', () => {
    androidTelemetry('audio_route_noisy');
    currentSpeakerMode = 'earpiece';
    activateAndroidAudioSession('noisy-audio-fallback');
  });
  addInCallListener('onAudioFocusChange', (data: any) => {
    androidTelemetry('audio_focus_change', {focus: data?.eventText || 'unknown'});
    activateAndroidAudioSession('audio-focus-change');
  });
  addInCallListener('onAudioRouteChanged', (data: any) => {
    androidTelemetry('audio_route_changed', {route: data?.eventText || 'unknown'});
    activateAndroidAudioSession('audio-route-changed');
  });
}

function unregisterAndroidAudioRouteObservers(): void {
  if (inCallAudioEventRemovers.length === 0) {
    return;
  }
  inCallAudioEventRemovers.forEach(remove => {
    try {
      remove();
    } catch (_) {}
  });
  inCallAudioEventRemovers = [];
}

function isAnotherCallInProgress(callUUID?: string | null): boolean {
  const sameActive = callUUID && activeCallUUID && callUUID === activeCallUUID;
  const sameIncoming = callUUID && incomingCallUUID && callUUID === incomingCallUUID;
  if (sameActive || sameIncoming) {
    return false;
  }
  return Boolean(
    isCallTransitionLocked ||
      activeCallUUID ||
      incomingCallUUID ||
      (currentCallState !== 'idle' && currentCallState !== 'ended' && currentCallState !== 'rejected'),
  );
}

function isIncomingUiWindowActive(): boolean {
  return Platform.OS === 'android' && isIncomingDisplayWindowActive;
}

function safeRestartIce(peer: any, reason: string): boolean {
  if (isIncomingUiWindowActive()) {
    androidTelemetry('ice_restart_blocked_incoming_ui', {reason});
    return false;
  }
  const now = Date.now();
  if (!peer || peer.signalingState === 'closed' || peer.connectionState === 'closed') {
    return false;
  }
  if (isIceRestartInProgress) {
    return false;
  }
  if (now - lastIceRestartAtMs < ICE_RESTART_COOLDOWN_MS) {
    return false;
  }
  try {
    isIceRestartInProgress = true;
    lastIceRestartAtMs = now;
    peer.restartIce();
    androidTelemetry('ice_restart', {reason});
    return true;
  } catch (e) {
    console.warn('Failed to restart ICE safely', e);
    return false;
  } finally {
    setTimeout(() => {
      isIceRestartInProgress = false;
    }, 1200);
  }
}

export async function handleAndroidIncomingCallNotification(
  payload: any,
  options?: {skipNativeDisplay?: boolean},
): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  const normalized = normalizeAndroidIncomingNotification(payload);
  if (!normalized) {
    return;
  }

  const {callUUID, callerDisplayName, handle, toLoyaltyId, offer} = normalized;
  androidTelemetry('incoming_push_received', {hasOffer: !!offer?.sdp});
  if (toLoyaltyId && currentLoyaltyId && toLoyaltyId !== currentLoyaltyId) {
    return;
  }
  if (isAnotherCallInProgress(callUUID)) {
    androidTelemetry('incoming_ignored_busy', {});
    return;
  }
  // Do not reject in killed/cold-start state where currentLoyaltyId is not restored yet.
  // We still need to show incoming call UI; user/account validation can happen after answer.

  const now = Date.now();
  const previousHandledAt = recentlyHandledIncomingCalls.get(callUUID);
  if (
    previousHandledAt &&
    now - previousHandledAt < DUPLICATE_INCOMING_WINDOW_MS
  ) {
    return;
  }
  recentlyHandledIncomingCalls.set(callUUID, now);
  if (!tryAcquireCallLock(callUUID, 'incoming-notification')) {
    return;
  }
  if (offer?.sdp) {
    incomingOfferByCallId.set(callUUID, offer);
  }

  incomingCallUUID = callUUID;
  currentCallState = 'ringing';
  connectionState = 'connecting';
  callerName = callerDisplayName;
  ensureNativeConnectionStatusSync();
  pushNativeConnectionStatus();
  startIncomingRingtone();

  if (!options?.skipNativeDisplay && USE_ANDROID_CALLKEEP_INCOMING_UI) {
    isIncomingDisplayWindowActive = true;
    try {
      safeAndroidDisplayIncomingCall(
        callUUID,
        handle,
        callerDisplayName,
      );
    } catch (e) {
      console.warn('Android displayIncomingCall failed', e);
    } finally {
      // Keep the isolation window short: prevent UI interference without delaying call connection.
      setTimeout(() => {
        isIncomingDisplayWindowActive = false;
      }, 400);
    }
  }
  registerAndroidAudioRouteObservers();
}

/** Устройство уже в другом живом звонке (есть peer или идёт переход ответа / исходящего). */
function isBusyWithOtherCall(callId: string): boolean {
  const current = activeCallUUID;
  if (!current || current === callId) {
    return false;
  }
  return Boolean(pc) || (isCallTransitionLocked && activeCallLockUUID !== callId);
}

/** Остатки прошлого звонка без peer не должны заслонять новый входящий (getCallState берёт activeCallUUID первым). */
function dropStaleCallLeftovers(callId: string): void {
  if (activeCallUUID && activeCallUUID !== callId && !pc) {
    activeCallUUID = null;
    activeCallStartedAt = null;
  }
}

// ---------------------------------------------------------------------------
// Сторож соединения: ответ принят / применён, но медиа так и не соединилось за
// MEDIA_CONNECT_TIMEOUT_MS — завершаем звонок как обычный отбой пользователя, чтобы сервер и
// другие устройства не считали «пустой» звонок активным.
// ---------------------------------------------------------------------------
const MEDIA_CONNECT_TIMEOUT_MS = 20000;
let mediaWatchdog: ReturnType<typeof setTimeout> | null = null;
let mediaWatchdogCallId: string | null = null;

function isPeerMediaConnected(peer: any): boolean {
  if (!peer) {
    return false;
  }
  return (
    peer.iceConnectionState === 'connected' ||
    peer.iceConnectionState === 'completed' ||
    peer.connectionState === 'connected'
  );
}

function clearMediaWatchdog(): void {
  if (mediaWatchdog) {
    clearTimeout(mediaWatchdog);
  }
  mediaWatchdog = null;
  mediaWatchdogCallId = null;
}

function startMediaWatchdog(callId: string, side: 'caller' | 'callee'): void {
  if (!callId || mediaWatchdogCallId === callId || isPeerMediaConnected(pc)) {
    return;
  }
  clearMediaWatchdog();
  mediaWatchdogCallId = callId;
  mediaWatchdog = setTimeout(() => {
    mediaWatchdog = null;
    if (mediaWatchdogCallId !== callId) {
      return;
    }
    mediaWatchdogCallId = null;
    if ((activeCallUUID || incomingCallUUID) !== callId || isPeerMediaConnected(pc)) {
      return;
    }
    console.warn(`Media watchdog (${side}): no connection ${MEDIA_CONNECT_TIMEOUT_MS} ms after the answer, ending call`, callId);
    endCall();
  }, MEDIA_CONNECT_TIMEOUT_MS);
}

function ensureSocketConnected() {
  if (isIncomingUiWindowActive()) {
    androidTelemetry('socket_connect_frozen_incoming_ui');
    return;
  }
  if (socket) {
    if (socket.connected) {
      // If already connected and we have deviceId and loyaltyId, ensure we're registered
      if (currentDeviceId && currentLoyaltyId) {
        socket.emit('registerDevice', {
          deviceId: currentDeviceId,
          loyaltyId: currentLoyaltyId,
        });
      }
      return;
    }

    // Avoid creating duplicate socket instances/listeners while reconnect is in progress.
    const socketAny = socket as any;
    if (socketAny?.active || socketAny?.connecting) {
      return;
    }

    try {
      socket.connect();
      return;
    } catch (e) {
      console.warn('Socket reconnect attempt failed, creating new socket', e);
      try {
        socket.removeAllListeners();
        socket.disconnect();
      } catch (_) {}
      socket = null;
    }
  }
  socket = io(BASE_URL, {
    // agent/user-JWT в handshake: сервер (calling_api_v2 socketGate) берёт личность из токена
    auth: voipSocketAuth,
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 15000,
  });

  socket.on('connect', () => {
    androidTelemetry('socket_connected');
    // console.log('Socket connected', socket?.id);
    // Register device immediately when socket connects if we have deviceId and loyaltyId
    const deviceId = currentDeviceId;
    const loyaltyId = currentLoyaltyId;
    if (deviceId && loyaltyId && socket) {
      socket.emit('registerDevice', {
        deviceId: deviceId,
        loyaltyId: loyaltyId,
      });
      // console.log('Socket connected, registered device with loyaltyId:', loyaltyId);
    } else if (deviceId && socket) {
      // Register without loyaltyId if not available yet
      socket.emit('registerDevice', {
        deviceId: deviceId,
      });
      // console.log('Socket connected, registered device (no loyaltyId yet)');
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected');
    androidTelemetry('socket_disconnected');
    // Attempt to reconnect and re-register device
    const deviceId = currentDeviceId;
    const loyaltyId = currentLoyaltyId;
    if (deviceId && socket) {
      socket.once('connect', () => {
        console.log('Socket reconnected, re-registering device');
        if (socket && deviceId) {
          socket.emit('registerDevice', {
            deviceId: deviceId,
            loyaltyId: loyaltyId,
          });
        }
      });
    }
  });

  socket.on('call-state', payload => {
    console.log('Socket call-state:', payload);
    const callId = payload?.callId;
    // Состояние ЧУЖОГО звонка (повтор 'ended' старого звонка, поздний /end прошлого звонка) или
    // звонка, о котором движок не знает, не должно трогать текущий звонок: для ended/rejected
    // только убираем запись CallKit этого звонка, 'answered' игнорируем. 'ringing' нового входящего
    // проходит, если устройство не занято живым звонком (остатки прошлого звонка не мешают).
    const currentCallId = activeCallUUID || incomingCallUUID || pendingAnswerCallUUID;
    if (callId && callId !== currentCallId) {
      if (payload?.state === 'ringing') {
        if (isBusyWithOtherCall(callId)) {
          console.log('Socket ringing for another call ignored (busy):', callId, 'current:', currentCallId);
          return;
        }
        dropStaleCallLeftovers(callId);
        incomingCallUUID = callId;
      } else {
        if (payload?.state === 'ended' || payload?.state === 'rejected') {
          try {
            RNCallKeep.endCall(callId);
          } catch (e) {}
        }
        console.log('Socket call-state for another/unknown call ignored:', callId, payload?.state, 'current:', currentCallId);
        return;
      }
    }

    // Handle rejected state (caller receives rejection notification)
    if (payload?.state === 'rejected' && callId) {
      console.log('Call rejected by callee - call', callId);
      currentCallState = 'rejected';
      pushNativeConnectionStatus();
      if (activeCallUUID === callId) {
        activeCallUUID = null;
      }
      if (incomingCallUUID === callId) {
        incomingCallUUID = null;
      }
      activeCallStartedAt = null;
      stopRingback();
      // End call in CallKeep
      try {
        RNCallKeep.endCall(callId);
        console.log('CallKeep: ended call after rejection');
      } catch (e) {
        console.warn('Failed to end call in CallKeep after rejection:', e);
      }
      // Clean up - this will reset state to idle immediately
      endVoiceCall();
      nativeStopVoipService().catch(() => {});
      return;
    }

    // When backend reports that the call was answered (for the caller),
    // start the JS-side call timer and mark call as active in CallKeep.
    if (payload?.state === 'answered' && callId) {
      console.log('Call answered for call', callId);
      currentCallState = 'answered';
      // connectionState and the call timer follow the real peer connection events
      // (onconnectionstatechange / oniceconnectionstatechange), not signaling.
      pushNativeConnectionStatus();

      // Mark call as active in CallKeep so the native timer starts and UI updates
      // This is especially important for the caller to see the call as connected
      if (activeCallUUID === callId) {
        try {
          maybeCallKeepSetCurrentCallActive(callId);
          console.log('CallKeep: marked call as active/connected (from socket call-state)', callId);
        } catch (e) {
          console.warn('Failed to set call as active in CallKeep', e);
        }
      }

      // When the callee answers, stop the ringback tone on the caller
      stopRingback();
    }

    // When backend reports that the call has ended from the remote side,
    // end the CallKeep call and reset local state.
    if (payload?.state === 'ended' && callId) {
      console.log('Remote hangup received for call', callId);
      currentCallState = 'ended';
      connectionState = 'disconnected';
      pushNativeConnectionStatus();
      try {
        RNCallKeep.endCall(callId);
      } catch (e) {
        console.warn('Failed to end CallKeep call from socket', e);
      }

      // Reset all call states
      if (activeCallUUID === callId) {
        activeCallUUID = null;
      }
      if (incomingCallUUID === callId) {
        incomingCallUUID = null;
      }
      activeCallStartedAt = null;
      callerName = null;

      // Reset microphone and speaker states (endVoiceCall will also do this, but explicit here for clarity)
      isMuted = false;
      isSpeakerEnabled = false;
      currentSpeakerMode = 'earpiece';
      console.log('Remote hangup: ✅ Reset microphone (unmuted) and speaker states');

      // Clean up all media tracks and resources
      endVoiceCall();
      nativeStopVoipService().catch(() => {});
      stopRingback();
      stopIncomingRingtone();

      // Reset call state after a delay (so modal can show "ended" state briefly)
      setTimeout(() => {
        if (currentCallState === 'ended') {
          currentCallState = 'idle';
        }
      }, 3000);
    }

    // Handle ringing state (incoming call)
    if (payload?.state === 'ringing' && callId) {
      currentCallState = 'ringing';
      connectionState = 'connecting'; // Set initial connection state
      pushNativeConnectionStatus();
      if (payload?.callerName) {
        callerName = payload.callerName;
      }
    }
  });

  // Real-time WebRTC signaling via Socket.IO (faster than HTTP polling)
  socket.on('offer', async ({callId, offer, fromDeviceId, fromLoyaltyId, toLoyaltyId, callerName: incomingCallerName}: any) => {
    console.log('Socket: received offer for call', callId, 'from', fromLoyaltyId || fromDeviceId);
    if (!offer || !offer.sdp) {
      console.warn('Socket: invalid offer received');
      return;
    }
    // Guard: ignore offer if it's for a different user (account switch race)
    // DB stores "1111 2222 3333 4444", the app may hold "1111222233334444"
    if (toLoyaltyId && currentLoyaltyId && String(toLoyaltyId).replace(/\s+/g, '') !== String(currentLoyaltyId).replace(/\s+/g, '')) {
      console.log('⚠️ Ignoring socket offer for different user:', toLoyaltyId, 'current:', currentLoyaltyId);
      return;
    }
    if (!currentLoyaltyId) {
      console.log('⚠️ Ignoring socket offer - no logged-in user');
      return;
    }
    // For incoming calls, only cache offer and set ringing state.
    // Do NOT create RTCPeerConnection here; create it only after user answers.
    incomingOfferByCallId.set(callId, offer);
    if (isBusyWithOtherCall(callId)) {
      console.log('Socket offer cached, device is busy with another call:', callId);
      return;
    }
    if (!activeCallUUID || activeCallUUID !== callId) {
      dropStaleCallLeftovers(callId);
      incomingCallUUID = callId;
      currentCallState = 'ringing';
      connectionState = 'connecting';
      pushNativeConnectionStatus();
      callerName = incomingCallerName || fromLoyaltyId || fromDeviceId || 'Incoming call';
      console.log('Incoming call offer cached from socket - callerName:', callerName);
    }
  });

  socket.on('answer', async ({callId, answer, fromDeviceId}: any) => {
    console.log('Socket: received answer for call', callId);
    if (!answer || !answer.sdp) {
      console.warn('Socket: invalid answer received');
      return;
    }
    // Set remote description when answer arrives via socket (much faster than polling)
    // This is a direct socket listener (separate from waitForAnswer)
    // We need to check if answer was already processed to avoid duplicates
    if (pc && activeCallUUID === callId && answerProcessedForCall !== callId) {
      try {
        // Check signaling state before setting remote description
        const signalingState = (pc as any).signalingState;
        console.log('Socket: received answer, current signaling state:', signalingState);

        // Only set remote description if in correct state (have-local-offer) and not already processed
        // If already stable or have-remote-answer, the answer was already set
        if (signalingState === 'have-local-offer' && answerProcessedForCall !== callId) {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            answerProcessedForCall = callId; // Mark as processed immediately
            startMediaWatchdog(callId, 'caller');
            console.log('✅ Socket: remote description set from socket answer');

            // CRITICAL: Process any queued ICE candidates now that remote description is set
            await processQueuedIceCandidates(callId);

            // Start timer immediately when caller receives answer from callee
            // This ensures CallKeep UI shows the call as connected with timer
            if (!activeCallStartedAt) {
              activeCallStartedAt = Date.now();
            }

            // Always mark call as active when answer is received (updates CallKeep UI)
            try {
              maybeCallKeepSetCurrentCallActive(callId);
              console.log('CallKeep: marked call as active/connected for caller', callId);
            } catch (e) {
              console.warn('Failed to set call as active in CallKeep when answer received', e);
            }

            // Start polling for ICE candidates (or use socket for that too)
            void pollRemoteCandidates(callId, 'caller');
          } catch (setError: any) {
            const errorMsg = setError?.message || '';
            // If we get a "wrong state" error, it means the answer was already set (race condition)
            if (errorMsg.includes('wrong state') || errorMsg.includes('stable') || errorMsg.includes('Called in wrong state')) {
              console.log('Socket: remote description already set (wrong state error), marking as processed');
              answerProcessedForCall = callId; // Mark as processed
              // Don't rethrow - the answer was already set successfully
            } else {
              // Some other error occurred
              console.error('Socket: failed to set remote description:', setError);
              throw setError; // Re-throw if it's not a state error
            }
          }
        } else {
          console.log('Socket: answer already processed or wrong state:', signalingState, 'processed:', answerProcessedForCall === callId);
          if (signalingState === 'stable' || signalingState === 'have-remote-answer' || answerProcessedForCall === callId) {
            answerProcessedForCall = callId; // Mark as processed
          }
        }
      } catch (e: any) {
        // Outer catch for any unexpected errors
        const errorMsg = e?.message || '';
        if (errorMsg.includes('wrong state') || errorMsg.includes('stable') || errorMsg.includes('Called in wrong state')) {
          console.log('Socket: remote description already set (stable state), ignoring duplicate answer');
          answerProcessedForCall = callId; // Mark as processed
        } else {
          console.error('Socket: unexpected error setting remote description from answer', e);
        }
      }
    } else if (answerProcessedForCall === callId) {
      console.log('Socket: answer already processed for this call, ignoring duplicate');
    }
  });

  socket.on('ice-candidate', async ({callId, candidate, fromDeviceId}: any) => {
    console.log('Socket: received ICE candidate for call', callId, 'from device', fromDeviceId);

    // Handle null candidate (gathering complete signal)
    if (!candidate) {
      console.log('Socket: ICE candidate gathering complete from peer');
      return;
    }

    if (!pc) {
      console.warn('Socket: received ICE candidate but no peer connection exists');
      return;
    }

    if (activeCallUUID !== callId) {
      console.warn('Socket: received ICE candidate for different call', callId, 'current call:', activeCallUUID);
      return;
    }

    // Check peer connection state before adding candidate
    const connectionState = (pc as any).connectionState;
    const iceConnectionState = (pc as any).iceConnectionState;
    const signalingState = (pc as any).signalingState;

    // Don't add candidates if connection is closed or failed
    if (connectionState === 'closed' || connectionState === 'failed') {
      console.warn('Socket: Cannot add ICE candidate - peer connection is', connectionState);
      return;
    }

    // Don't add candidates if ICE connection is closed or failed
    if (iceConnectionState === 'closed' || iceConnectionState === 'failed') {
      console.warn('Socket: Cannot add ICE candidate - ICE connection is', iceConnectionState);
      return;
    }

    try {
      // Check if candidate is valid
      if (!candidate.candidate) {
        console.warn('Socket: Invalid ICE candidate - missing candidate field');
        return;
      }

      // Validate candidate format
      if (candidate.sdpMLineIndex === undefined && candidate.sdpMid === undefined) {
        console.warn('Socket: Invalid ICE candidate - missing sdpMLineIndex and sdpMid');
        return;
      }

      // If remote description is not ready yet, queue candidate and process later.
      // This happens frequently for caller side while we're still in have-local-offer.
      if (!pc.remoteDescription) {
        queuedIceCandidates.push({
          callId,
          candidate,
          fromDeviceId: fromDeviceId || 'unknown',
        });
        console.log(
          'Socket: queued ICE candidate (remote description not set yet)',
          callId,
          'queue size:',
          queuedIceCandidates.filter(c => c.callId === callId).length,
        );
        return;
      }

      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('Socket: ✅ ICE candidate added successfully:', candidate.candidate?.substring(0, 50) + '...');
    } catch (e: any) {
      const errorMsg = e?.message || String(e);

      // Handle specific error cases gracefully
      if (errorMsg.includes('InvalidStateError') || errorMsg.includes('Invalid state')) {
        console.warn('Socket: Cannot add ICE candidate - invalid peer connection state:', signalingState);
        return; // Don't log as error - state might not be ready yet
      }

      if (errorMsg.includes('Invalid candidate') || errorMsg.includes('InvalidCandidateError')) {
        console.warn('Socket: Invalid ICE candidate format:', candidate);
        return; // Invalid candidate - skip it
      }

      if (errorMsg.includes('OperationError') || errorMsg.includes('Operation error')) {
        console.warn('Socket: Operation error adding ICE candidate (might be duplicate or invalid):', errorMsg);
        return; // Operation error - skip this candidate
      }

      if (errorMsg.includes('remote description was null')) {
        queuedIceCandidates.push({
          callId,
          candidate,
          fromDeviceId: fromDeviceId || 'unknown',
        });
        console.warn(
          'Socket: queued ICE after add failure (remote description null)',
          callId,
        );
        return;
      }

      // Log other errors but don't throw
      console.error('Socket: ❌ Failed to add ICE candidate:', errorMsg);
      console.error('Candidate details:', {
        candidate: candidate.candidate?.substring(0, 100),
        sdpMLineIndex: candidate.sdpMLineIndex,
        sdpMid: candidate.sdpMid,
        connectionState,
        iceConnectionState,
        signalingState,
      });
      // Don't throw - continue with other candidates
    }
  });
}

async function fetchRemoteOfferWithRetry(
  callUUID: string,
  maxAttempts = OFFER_FETCH_MAX_ATTEMPTS,
): Promise<{type: string; sdp: string}> {
  let lastStatus: number | null = null;
  let finishedState: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pauseMs = offerRetryDelayMs(attempt);
    if (pauseMs > 0) {
      // After a long background the network / token refresh may need a few seconds.
      await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
    try {
      const resp = await voipFetch(`${BASE_URL}/api/calls/${callUUID}`);
      lastStatus = resp.status;
      if (resp.ok) {
        const data = await resp.json();
        if (data?.state === 'ended' || data?.state === 'rejected' || data?.state === 'missed') {
          // do not build a connection for a call the server already finished
          finishedState = data.state;
          break;
        }
        if (data?.offer?.sdp) {
          return data.offer;
        }
      }
    } catch (e) {
      // Network race during cold start; retry below.
    }
  }

  if (finishedState) {
    throw new Error(`Call ${callUUID} is already ${finishedState}`);
  }
  throw new Error(
    `No remote offer found for call ${callUUID} after ${maxAttempts} attempts (last status: ${lastStatus ?? 'n/a'})`,
  );
}

export function queuePendingAnswerFromBackground(callUUID: string): void {
  if (!callUUID) {
    return;
  }
  pendingAnswerCallUUID = callUUID;
  activeCallUUID = callUUID;
  incomingCallUUID = null;
  currentCallState = 'answered';
  lastAcceptedCallUUID = callUUID;
  lastAcceptedAtMs = Date.now();

  // If VoIP is already initialized, process immediately.
  // This avoids waiting for init hooks when app is reopened from killed/background answer.
  if (isVoipInitialized) {
    schedulePendingAnswer(callUUID, 200, 'background_queue');
  }
}

/**
 * The only entry point for a pending answer (answered while the app was in the
 * background or closed). Idempotent: repeated calls for the same call are ignored
 * while an answer is running or after it succeeded (answerGate).
 */
function schedulePendingAnswer(callUUID: string | null, delayMs: number, source: string): void {
  if (!callUUID) {
    return;
  }
  if (answerGate.isInFlight(callUUID) || answerGate.isDone(callUUID)) {
    console.log('pendingAnswer: already handled, skip', {callUUID, source});
    if (pendingAnswerCallUUID === callUUID) {
      pendingAnswerCallUUID = null;
    }
    return;
  }
  // Show the active-call screen right away.
  activeCallUUID = callUUID;
  incomingCallUUID = null;
  currentCallState = 'answered';
  setTimeout(() => {
    if (activeCallUUID !== callUUID && pendingAnswerCallUUID !== callUUID) {
      return; // call ended meanwhile
    }
    processPendingAnswer(callUUID).catch(e => {
      console.error(`❌ Failed to process pending answer (${source}):`, e);
    });
  }, delayMs);
}

/**
 * Leftovers of an earlier call (lock, incoming UUID) without a live peer must not
 * block answering a new call after a long background.
 */
function clearStaleCallStateFor(callUUID: string): void {
  if (pc) {
    return;
  }
  if (activeCallLockUUID && activeCallLockUUID !== callUUID) {
    console.warn('answer: releasing stale call lock of', activeCallLockUUID);
    releaseCallLock();
  }
  if (incomingCallUUID && incomingCallUUID !== callUUID) {
    incomingCallUUID = null;
  }
  if (activeCallUUID && activeCallUUID !== callUUID) {
    activeCallUUID = callUUID;
  }
}

/**
 * RNCallKeep keeps CallKit / ConnectionService actions that happened before JS
 * registered its listeners (app closed or JS not started). Earlier this queue was
 * read on Android only, so on iOS an answer from the closed app was lost.
 */
function recoverCallKeepInitialEvents(source: string): void {
  const callKeepAny = RNCallKeep as any;
  if (typeof callKeepAny?.getInitialEvents !== 'function') {
    return;
  }
  Promise.resolve(callKeepAny.getInitialEvents())
    .then((events: any[]) => {
      const {answerUUID, endedUUIDs, audioActivated} = summarizeInitialCallKeepEvents(events);
      if (typeof callKeepAny.clearInitialEvents === 'function') {
        callKeepAny.clearInitialEvents();
      }
      if (audioActivated) {
        notifyWebRtcAudioSession(true, `initial_events_${source}`);
      }
      endedUUIDs.forEach(endedUUID => {
        if (pendingAnswerCallUUID === endedUUID) {
          pendingAnswerCallUUID = null;
        }
        rejectCall(endedUUID);
      });
      if (answerUUID) {
        console.log('📞 Recovered answer from CallKeep initial events', {
          answerUUID,
          source,
          platform: Platform.OS,
        });
        pendingAnswerCallUUID = answerUUID;
        lastAcceptedCallUUID = answerUUID;
        lastAcceptedAtMs = Date.now();
        stopIncomingRingtone();
        schedulePendingAnswer(answerUUID, 400, `initial_events_${source}`);
      }
    })
    .catch(e => {
      console.warn('Failed to process CallKeep initial events', e);
    });
}

/**
 * iOS + CallKit: the audio session is activated by CallKit, not by the app.
 * WebRTC has to be told about it, otherwise a call answered from the lock screen
 * or from the background has no sound (the app cannot activate audio itself there).
 */
function notifyWebRtcAudioSession(active: boolean, source: string): void {
  if (Platform.OS !== 'ios') {
    return;
  }
  try {
    const session: any = RTCAudioSession;
    if (active && typeof session?.audioSessionDidActivate === 'function') {
      session.audioSessionDidActivate();
    } else if (!active && typeof session?.audioSessionDidDeactivate === 'function') {
      session.audioSessionDidDeactivate();
    }
    console.log(`iOS audio session ${active ? 'activated' : 'deactivated'} by CallKit (${source})`);
  } catch (e) {
    console.warn('Failed to notify WebRTC about CallKit audio session', e);
  }
}

/**
 * App became active (opened after answering from the lock screen / background):
 * reconnect signaling and finish an answered call that has no connection yet.
 */
function onVoipAppActive(): void {
  if (!isVoipInitialized) {
    return;
  }
  ensureSocketConnected();
  recoverCallKeepInitialEvents('app_active');
  const target = pendingAnswerCallUUID || activeCallUUID;
  const decision = decideOnResume({
    pendingAnswerUUID: pendingAnswerCallUUID,
    activeCallUUID,
    callState: currentCallState,
    hasPeer: !!pc,
    answerInFlight: target ? answerGate.isInFlight(target) : false,
    answerDone: target ? answerGate.isDone(target) : false,
  });
  if (decision.action === 'answer' && decision.uuid) {
    schedulePendingAnswer(decision.uuid, 300, 'app_active');
    return;
  }
  // Connection dropped while the phone was locked: restart ICE on the live peer.
  const peer: any = pc;
  if (
    peer &&
    activeCallUUID &&
    (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected')
  ) {
    safeRestartIce(peer, 'app_active');
  }
}

/**
 * RINGBACK AUDIO MANAGEMENT
 *
 * InCallManager is started by startVoiceCall() before startRingback() is called.
 * We just need to ensure ringback state is properly reset before each call.
 */

/**
 * Reset ringback state - called before each new call
 */
function forceResetRingbackState(): void {
  console.log('🔔 Resetting ringback state...');
  isRingbackPlaying = false;
  try { InCallManager.stopRingback(); } catch (e) {}
  console.log('🔔 ✅ Ringback state reset');
}

/**
 * Starts ringback tone for outgoing calls.
 * InCallManager should already be started by startVoiceCall().
 */
async function startRingback(): Promise<void> {
  console.log('🔔 ===== START RINGBACK =====');
  console.log('🔔 Platform:', Platform.OS);
  console.log('🔔 isRingbackPlaying (before):', isRingbackPlaying);

  // Reset any lingering ringback state
  isRingbackPlaying = false;
  try { InCallManager.stopRingback(); } catch (e) {}

  // Small delay to ensure audio is ready
  await new Promise(resolve => setTimeout(resolve, 50));

  // Mark as playing
  isRingbackPlaying = true;

  // Start ringback using InCallManager
  console.log('🔔 Starting ringback...');
  try {
    InCallManager.startRingback('_BUNDLE_');
    console.log('🔔 ✅ Ringback PLAYING (_BUNDLE_)');
  } catch (e: any) {
    console.log('🔔 _BUNDLE_ failed:', e?.message);
    try {
      InCallManager.startRingback('_DEFAULT_');
      console.log('🔔 ✅ Ringback PLAYING (_DEFAULT_)');
    } catch (e2: any) {
      console.log('🔔 ❌ All ringback methods failed');
      isRingbackPlaying = false;
    }
  }
}

/**
 * Stops ringback tone.
 */
function stopRingback(): void {
  console.log('🔔 ===== STOP RINGBACK =====');
  console.log('🔔 isRingbackPlaying:', isRingbackPlaying);

  isRingbackPlaying = false;

  try {
    InCallManager.stopRingback();
    console.log('🔔 ✅ Ringback stopped');
  } catch (e: any) {}
}

/**
 * Full cleanup after call ends.
 */
function cleanupRingbackAudio(): void {
  console.log('🔔 Cleanup ringback...');
  isRingbackPlaying = false;
  try { InCallManager.stopRingback(); } catch (e) {}
}

// Initialize incoming call ringtone (for Android or custom iOS behavior)
function initIncomingRingtone() {
  if (incomingRingtone || !SoundAvailable || !Sound) {
    return;
  }

  try {
    // IMPORTANT:
    // Place a file named "incoming_ringtone.mp3" into the iOS main bundle and Android
    // 'android/app/src/main/res/raw' folder. This is the tone played when receiving
    // an incoming call (though iOS CallKit handles ringtone automatically).
    // If the file is missing, ringtone will be null and calls will still work.
    incomingRingtone = new Sound('incoming_ringtone.mp3', Sound.MAIN_BUNDLE, (error: any) => {
      if (error) {
        console.warn('Failed to load incoming ringtone sound (calls will work without it):', error);
        incomingRingtone = null;
      } else {
        console.log('Incoming ringtone sound loaded successfully');
      }
    });
  } catch (e) {
    console.warn('Incoming ringtone initialization failed (calls will work without it):', e);
    incomingRingtone = null;
  }
}

function startIncomingRingtone() {
  try {
    // Android incoming alerting is handled by native ForegroundService/IncomingCallActivity.
    // Avoid double ringtone sources and race conditions with JS audio focus.
    if (Platform.OS === 'android') {
      return;
    }
    // On iOS, CallKit already plays system ringtone automatically.
    // Custom ringtone is mainly for Android or if you want to override iOS behavior.
    if (Platform.OS === 'ios') {
      // iOS CallKit handles ringtone automatically, but we can still play custom one
      // if needed (it will play alongside system ringtone)
      console.log('Incoming call - iOS CallKit will play system ringtone');
      // Uncomment below if you want custom ringtone on iOS too:
      // initIncomingRingtone();
      // if (!incomingRingtone || isIncomingRingtonePlaying) return;
      // incomingRingtone.setNumberOfLoops(-1);
      // incomingRingtone.play();
      // isIncomingRingtonePlaying = true;
      return;
    }

    // For Android, play custom ringtone
    initIncomingRingtone();
    if (!incomingRingtone || isIncomingRingtonePlaying) {
      return;
    }
    incomingRingtone.setNumberOfLoops(-1); // loop until stopped
    incomingRingtone.play((success: any) => {
      if (!success) {
        console.warn('Incoming ringtone playback failed');
      }
      isIncomingRingtonePlaying = false;
    });
    isIncomingRingtonePlaying = true;
  } catch (e) {
    console.warn('Failed to start incoming ringtone (call will continue without it):', e);
    // Don't throw - allow call to proceed without ringtone
  }
}

function stopIncomingRingtone() {
  if (incomingRingtone && isIncomingRingtonePlaying) {
    incomingRingtone.stop();
    isIncomingRingtonePlaying = false;
  }
}

/**
 * Re-apply speaker mode to InCallManager + WebRTC tracks.
 * Remote audio often arrives in `ontrack` after `startVoiceCall` finishes, so an early
 * `setSpeakerMode` does not configure remote tracks — UI shows speaker "on" but audio stays on earpiece until toggled.
 * Do not call this from ICE/PC state handlers (would stack with user toggles on the answered screen).
 */
function applyStoredSpeakerRouting(context: string): void {
  if (!pc) {
    return;
  }
  try {
    setSpeakerMode(currentSpeakerMode);
  } catch (e) {
    console.warn(`applyStoredSpeakerRouting (${context}) failed`, e);
  }
}

// ---------------------------------------------------------------------------
// ICE-серверы с бэкенда (Б.1, SECURITY_AUDIT_SECRETS_RU.md #29):
// TURN-логин/пароль больше не зашиты в бандл — их выдаёт calling_api_v2
// (GET /api/ice-servers, JWT через voipFetch). Ответ кэшируется до expiresAt
// минус запас. Если запрос не удался — фолбэк STUN-only (без relay).
// ---------------------------------------------------------------------------
const FALLBACK_ICE_SERVERS = [
  {urls: 'stun:stun1.totus.club:3478'},
  {urls: 'stun:stun2.totus.club:3478'},
];

let cachedIceServers: any[] | null = null;
let cachedIceExpiresAt = 0; // unix-секунды

async function fetchIceServers(): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedIceServers && now < cachedIceExpiresAt - 300) {
    return cachedIceServers;
  }
  try {
    const res = await voipFetch(`${BASE_URL}/api/ice-servers`);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        cachedIceServers = data.iceServers;
        cachedIceExpiresAt = Number(data.expiresAt) || now + 3600;
        if (data.mode === 'stun-only') {
          console.warn('[voip] backend вернул только STUN (TURN не настроен) — relay недоступен');
        }
        return data.iceServers as any[];
      }
    }
    console.warn('[voip] /api/ice-servers ответил', res.status, '— фолбэк STUN-only');
  } catch (e) {
    console.warn('[voip] не удалось получить /api/ice-servers — фолбэк STUN-only', e);
  }
  return cachedIceServers || FALLBACK_ICE_SERVERS;
}

async function startVoiceCall(
  callUUID: string,
  remoteOffer: {sdp: string; type: string} | undefined,
  role: 'caller' | 'callee',
) {
  if (Platform.OS === 'android') {
    void maybePromptAndroidVoipPowerSetup('first_call');
  }
  if (Platform.OS === 'android') {
    androidTelemetry('foreground_service_start_request', {phase: 'startVoiceCall'});
    await startAndroidCallForegroundService(callUUID, callerName || 'Звонок Totus Support');
    androidTelemetry('foreground_service_started');
  }
  // Reset ICE restart attempts for new call
  iceRestartAttempts = 0;
  clearMediaWatchdog();
  if (iceFailureTimeout) {
    clearTimeout(iceFailureTimeout);
    iceFailureTimeout = null;
  }

  // 1. Создание peer connection: ICE-серверы приходят с бэкенда (см. fetchIceServers выше)
  const iceServers = await fetchIceServers();

  const peer: any = new RTCPeerConnection({
    iceServers,

    // Նախօրոք հավաքել ICE թեկնածուներ արագ կապի համար
    iceCandidatePoolSize: 10,

    // Պրոֆեսիոնալ WebRTC պարամետրեր
    iceTransportPolicy: 'all', // օգտագործել ինչպես ուղղակի (STUN), այնպես էլ ռելեյ (TURN)
    bundlePolicy: 'max-bundle', // RTP/RTCP–ը նույն պորտով հավաքել՝ NAT–ի արդյունավետության համար
    rtcpMuxPolicy: 'require', // պահանջել RTP/RTCP համակցումը՝ նույն պորտով
  });

  pc = peer;
  androidTelemetry('peer_created');

  // 2. Handle ICE candidates – send to your signaling server
  peer.onicecandidate = (event: any) => {
    if (event.candidate) {
      // console.log(`ICE candidate [${role}]:`, event.candidate.candidate, 'type:', event.candidate.type);
      void sendIceCandidate(callUUID, role, event.candidate);
    } else {
      // console.log(`ICE candidate gathering complete for [${role}]`);
      // All candidates have been sent, signal completion
      void sendIceCandidate(callUUID, role, null);
    }
  };

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    androidTelemetry('peer_connection_state', {state});
    // console.log('PeerConnection state changed:', state);

    // Update connection state tracking
    if (state === 'connecting' || state === 'new') {
      connectionState = 'connecting';
    } else if (state === 'connected') {
      connectionState = 'connected';
      if (mediaWatchdogCallId === callUUID) {
        clearMediaWatchdog();
      }
      if (!activeCallStartedAt && activeCallUUID === callUUID && currentCallState === 'answered') {
        activeCallStartedAt = Date.now();
      }
      // console.log('✅ Peer connection established successfully!');
      // Update call state to answered when connection is established
      if (currentCallState === 'calling' || currentCallState === 'ringing') {
        currentCallState = 'answered';
        if (!activeCallStartedAt && activeCallUUID === callUUID) {
          activeCallStartedAt = Date.now();
        }
        // Mark call as active in CallKeep
        if (activeCallUUID === callUUID) {
          try {
            maybeCallKeepSetCurrentCallActive(callUUID);
            // console.log('CallKeep: marked call as active after connection established');
          } catch (e) {
            console.warn('Failed to set call as active in CallKeep', e);
          }
        }
      }
    } else if (state === 'disconnected') {
      connectionState = 'disconnected';
      // console.warn('⚠️ Peer connection disconnected');
      // Try to reconnect if call is still active
      if (activeCallUUID === callUUID && currentCallState === 'answered') {
        attemptReconnection(callUUID);
      }
    } else if (state === 'failed') {
      connectionState = 'failed';
      // console.error('❌ Peer connection failed! State:', state, 'for call:', callUUID);
      // console.error('   ICE connection state:', peer.iceConnectionState);
      // console.error('   Signaling state:', peer.signalingState);

      // Only restart if ICE state is also failed and we haven't exceeded attempts
      if (peer.iceConnectionState === 'failed' && iceRestartAttempts < MAX_ICE_RESTART_ATTEMPTS) {
        // console.log('   Attempting ICE restart from connection state handler...');
        try {
          if (peer.signalingState !== 'closed') {
            safeRestartIce(peer, 'connection-state-failed');
            // console.log('✅ ICE restart initiated from connection state handler');
          } else {
            // console.warn('⚠️ Cannot restart ICE - signaling state is closed');
          }
        } catch (e) {
          console.error('❌ Failed to restart ICE from connection state handler:', e);
        }
      } else if (iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
        console.error('❌ Max ICE restart attempts reached. Connection failed.');
      }
    } else if (state === 'closed') {
      console.log('Peer connection closed');
    }
  };

  peer.oniceconnectionstatechange = () => {
    const iceState = peer.iceConnectionState;
    androidTelemetry('ice_state', {iceState});
    // console.log('ICE connection state changed:', iceState, 'for call:', callUUID);

    // Update connection state based on ICE state
    if (iceState === 'checking' || iceState === 'new') {
      if (connectionState !== 'reconnecting') {
        connectionState = 'connecting';
      }
    } else if (iceState === 'connected' || iceState === 'completed') {
      connectionState = 'connected';
      if (mediaWatchdogCallId === callUUID) {
        clearMediaWatchdog();
      }
      console.log('✅ ICE connection established!');
      // Reset restart attempts on successful connection
      iceRestartAttempts = 0;
      if (iceFailureTimeout) {
        clearTimeout(iceFailureTimeout);
        iceFailureTimeout = null;
      }
    } else if (iceState === 'failed') {
      connectionState = 'failed';
      // console.error('❌ ICE connection failed! This usually means:');
      // console.error('  - Network connectivity issues');
      // console.error('  - TURN/STUN server problems');
      // console.error('  - Firewall blocking WebRTC traffic');
      // console.error('  - No common codecs between peers');
      // console.error(`  - Current restart attempt: ${iceRestartAttempts + 1}/${MAX_ICE_RESTART_ATTEMPTS}`);

      // Diagnostic information
      // console.error('📊 ICE Failure Diagnostics:');
      // console.error('   - Signaling state:', peer.signalingState);
      // console.error('   - Connection state:', peer.connectionState);
      // console.error('   - Has remote description:', !!peer.remoteDescription);
      // console.error('   - Has local description:', !!peer.localDescription);
      // console.error('   - Queued ICE candidates:', queuedIceCandidates.filter(c => c.callId === callUUID).length);
      if (peer.localDescription) {
        const localCandidates = peer.localDescription.sdp?.match(/a=candidate:/g)?.length || 0;
        console.error('   - Local SDP candidates:', localCandidates);
      }

      // Only restart if we haven't exceeded max attempts
      if (iceRestartAttempts < MAX_ICE_RESTART_ATTEMPTS) {
        iceRestartAttempts++;

        // Use exponential backoff: 1s, 2s, 4s
        const delay = Math.min(1000 * Math.pow(2, iceRestartAttempts - 1), 4000);
        console.log(`⏳ Waiting ${delay}ms before ICE restart attempt ${iceRestartAttempts}...`);

        if (iceFailureTimeout) {
          clearTimeout(iceFailureTimeout);
        }

        iceFailureTimeout = setTimeout(() => {
          try {
            console.log(`🔄 Attempting ICE restart ${iceRestartAttempts}/${MAX_ICE_RESTART_ATTEMPTS}...`);

            // Check if peer connection still exists and is in a valid state
            if (peer && peer.signalingState !== 'closed' && peer.connectionState !== 'closed') {
              safeRestartIce(peer, 'ice-failed-timeout');
              // console.log('✅ ICE restart initiated');
            } else {
              // console.warn('⚠️ Cannot restart ICE - peer connection is closed');
              iceRestartAttempts = MAX_ICE_RESTART_ATTEMPTS; // Prevent further attempts
            }
          } catch (e) {
            console.error('❌ Failed to restart ICE:', e);
            // If restart fails, try one more time after a longer delay
            if (iceRestartAttempts < MAX_ICE_RESTART_ATTEMPTS) {
              iceRestartAttempts++;
              setTimeout(() => {
                try {
                  if (peer && peer.signalingState !== 'closed') {
                    safeRestartIce(peer, 'ice-failed-retry');
                    console.log('✅ ICE restart retry initiated');
                  }
                } catch (retryError) {
                  console.error('❌ ICE restart retry also failed:', retryError);
                }
              }, 2000);
            }
          }
        }, delay);
      } else {
        // console.error('❌ Max ICE restart attempts reached. Connection may not be possible.');
        // console.error('   Consider checking:');
        // console.error('   1. Network connectivity');
        // console.error('   2. TURN/STUN server availability');
        // console.error('   3. Firewall/NAT configuration');
        // console.error('   4. Codec compatibility');

        // Notify user that connection failed
        if (activeCallUUID === callUUID) {
          // console.warn('⚠️ Call connection failed - user may need to retry');
          // Don't end the call automatically - let user decide
        }
      }
    } else if (iceState === 'disconnected') {
      // console.warn('⚠️ ICE connection disconnected');
      // Reset attempts on disconnect (might reconnect)
      iceRestartAttempts = 0;
    } else if (iceState === 'closed') {
      // console.log('ICE connection closed');
      // Reset attempts when closed
      iceRestartAttempts = 0;
      if (iceFailureTimeout) {
        clearTimeout(iceFailureTimeout);
        iceFailureTimeout = null;
      }
    }
  };

  // Monitor ICE gathering state
  peer.onicegatheringstatechange = () => {
    const gatheringState = peer.iceGatheringState;
    // console.log('ICE gathering state:', gatheringState, 'for call:', callUUID);

    if (gatheringState === 'complete') {
      // console.log('✅ ICE candidate gathering complete');
      const candidates = peer.localDescription?.sdp?.match(/a=candidate:/g)?.length || 0;
      // console.log(`   Found ${candidates} ICE candidates`);
    } else if (gatheringState === 'gathering') {
      // console.log('🔄 ICE candidate gathering in progress...');
    }
    if (peer.iceGatheringState === 'complete') {
      // console.log('✅ ICE candidate gathering complete');
    }
  };

  // Monitor signaling state
  peer.onsignalingstatechange = () => {
    console.log('Signaling state:', peer.signalingState);
  };

  peer.ontrack = (event: any) => {
    const stream = event.streams[0];
    if (!stream) {
      console.log('Remote track received without streams');
      return;
    }
    remoteStream = stream;
    console.log('Remote track received, stream id:', stream.id);

    // Configure remote audio tracks to play through speaker
    stream.getAudioTracks().forEach((track: any) => {
      console.log('Configuring remote audio track for audio output');

      // Ensure track is enabled and ready to play
      if (track.setEnabled) {
        track.setEnabled(true);
        console.log('Remote audio track enabled');
      }

      // Ensure track is ready state
      if (track.readyState === 'ended') {
        console.warn('Remote audio track is ended - may not play');
      } else {
        console.log('Remote audio track readyState:', track.readyState);
      }

      // For React Native WebRTC, remote audio should automatically play
      // when added to the peer connection. iOS CallKit will handle
      // speaker routing when user clicks speaker button.
      console.log('Remote audio track configured - should play automatically');
    });

    // For iOS CallKit, the speaker button in the CallKit UI will handle audio routing.
    // When user clicks speaker button in CallKit UI, iOS automatically routes audio.
    // The audio should automatically play through the device output (earpiece by default,
    // speaker when CallKit speaker button is enabled).
    console.log('Remote audio stream ready - audio should be audible. Use CallKit speaker button to toggle speaker.');

    applyStoredSpeakerRouting('ontrack');
  };

  // 3. Get local audio only
  localStream = await mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  localStream.getTracks().forEach(track => {
    peer.addTrack(track, localStream!);
  });

  // Initialize InCallManager for proper audio routing and call management
  // CRITICAL: Stop first to ensure fresh audio session (fixes iOS ringback on 2nd+ call)
  try {
    InCallManager.stop();
    console.log('🔔 InCallManager stopped (preparing fresh start)');
  } catch (e) {}

  // Wait for iOS to release audio session
  await new Promise(resolve => setTimeout(resolve, 100));

  try {
    InCallManager.start({ media: 'audio' });
    InCallManager.setKeepScreenOn(true);
    InCallManager.setSpeakerphoneOn(currentSpeakerMode === 'loudspeaker');
    InCallManager.setMicrophoneMute(isMuted);
    console.log('✅ InCallManager initialized fresh for call');
  } catch (e) {
    console.warn('⚠️ Failed to initialize InCallManager:', e);
  }
  activateAndroidAudioSession('startVoiceCall');
  registerAndroidAudioRouteObservers();

  // Configure audio output for better speaker support
  // On iOS, CallKit handles speaker button, but we ensure audio is ready
  if (Platform.OS === 'ios') {
    console.log('iOS: CallKit will handle speaker button automatically');
  }

  // 4. Offer/answer logic (signaling is up to you)
  if (!remoteOffer) {
    // We are the caller, create offer
    const offer = await peer.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await peer.setLocalDescription(offer);
    console.log('Created local offer SDP, signaling state should be: have-local-offer');
    // Reset answer processed flag for new call
    answerProcessedForCall = null;
  } else {
    // We are the callee, got remote offer from signaling
    await peer.setRemoteDescription(new RTCSessionDescription(remoteOffer));
    console.log('✅ Remote offer set in startVoiceCall');

    // CRITICAL: Process any queued ICE candidates now that remote description is set
    await processQueuedIceCandidates(callUUID);

    // Create answer
    const answer = await peer.createAnswer();
    console.log('📞 Created answer SDP, type:', answer.type);

    // Set local description (this triggers ICE candidate gathering)
    await peer.setLocalDescription(answer);
    console.log('✅ Local answer description set, signaling state:', peer.signalingState);

    // Wait a bit for ICE candidates to be gathered and included in the SDP
    // This improves connection establishment speed
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if ICE gathering is complete or still gathering
    const gatheringState = peer.iceGatheringState;
    console.log('📞 ICE gathering state after answer:', gatheringState);

    // If still gathering, wait a bit more (but don't wait too long)
    if (gatheringState === 'gathering') {
      console.log('📞 Waiting for ICE gathering to complete...');
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          peer.removeEventListener('icegatheringstatechange', handler);
          resolve(null);
        }, 2000); // Max 2 seconds wait

        const handler = () => {
          if (peer.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            peer.removeEventListener('icegatheringstatechange', handler);
            resolve(null);
          }
        };
        peer.addEventListener('icegatheringstatechange', handler);
      });
      console.log('📞 ICE gathering state after wait:', peer.iceGatheringState);
    }

    // Update local description if it changed (ICE candidates added)
    if (peer.localDescription) {
      console.log('📞 Final answer SDP length:', peer.localDescription.sdp?.length || 0);
      const candidateCount = peer.localDescription.sdp?.match(/a=candidate:/g)?.length || 0;
      console.log('📞 Answer SDP contains', candidateCount, 'ICE candidates');
    }

    // Reset answer processed flag for new call
    answerProcessedForCall = null;
  }

  // Apply speaker/mute chosen on ringing/calling UI to WebRTC + keep InCallManager in sync
  try {
    setSpeakerMode(currentSpeakerMode);
  } catch (e) {
    console.warn('startVoiceCall: setSpeakerMode re-apply failed', e);
  }
  try {
    InCallManager.setMicrophoneMute(isMuted);
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => {
        t.enabled = !isMuted;
      });
    }
  } catch (e) {
    console.warn('startVoiceCall: mute re-apply failed', e);
  }
}

// Wait for answer via Socket.IO (real-time, much faster than HTTP polling)
async function waitForAnswer(callId: string): Promise<void> {
  // Store local reference to pc to avoid race conditions
  const currentPc = pc;
  if (!currentPc) {
    console.warn('waitForAnswer called with no active peer connection');
    return;
  }

  // Ensure socket is connected
  ensureSocketConnected();
  if (!socket || !socket.connected) {
    console.warn('waitForAnswer: socket not connected, will fallback to HTTP polling');
    // Fallback to HTTP polling if socket not available
    await waitForAnswerHTTP(callId);
    return;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (answerListener) {
        socket?.removeListener('answer', answerListener);
        answerListener = null;
      }
      console.warn('waitForAnswer: socket timeout, falling back to HTTP polling');
      waitForAnswerHTTP(callId).then(resolve).catch(reject);
    }, 20000); // 20 second timeout

    let answerListener: ((data: any) => void) | null = null;

    answerListener = async ({callId: receivedCallId, answer: receivedAnswer}: any) => {
      if (receivedCallId !== callId) {
        return; // Not our call
      }

      if (!receivedAnswer || !receivedAnswer.sdp) {
        return;
      }

      // Clear timeout and listener
      clearTimeout(timeout);
      if (answerListener && socket) {
        socket.removeListener('answer', answerListener);
        answerListener = null;
      }

      // Double-check pc still exists and matches
      if (!pc || pc !== currentPc) {
        console.warn('waitForAnswer: peer connection closed before setting remote description');
        reject(new Error('Peer connection closed'));
        return;
      }

      try {
        // Check signaling state before setting remote description
        const signalingState = (currentPc as any).signalingState;
        console.log('waitForAnswer: current signaling state:', signalingState);

        // Only set remote description if in correct state (have-local-offer)
        // Also check if answer was already processed to prevent duplicates
        if (signalingState === 'have-local-offer' && answerProcessedForCall !== callId) {
          try {
            await currentPc.setRemoteDescription(new RTCSessionDescription(receivedAnswer));
            answerProcessedForCall = callId; // Mark as processed immediately
            startMediaWatchdog(callId, 'caller');
            console.log('waitForAnswer: remote description set successfully via socket');

            // Start timer when caller receives answer (if not already started)
            if (!activeCallStartedAt && activeCallUUID === callId) {
              activeCallStartedAt = Date.now();
            }

            // Always mark call as active when answer is received (updates CallKeep UI)
            if (activeCallUUID === callId) {
              try {
                maybeCallKeepSetCurrentCallActive(callId);
                console.log('CallKeep: marked call as active/connected for caller (via socket wait)', callId);
              } catch (e) {
                console.warn('Failed to set call as active in CallKeep', e);
              }
            }

            resolve();
          } catch (setError: any) {
            // Handle error when setting remote description
            const errorMsg = setError?.message || '';
            if (errorMsg.includes('wrong state') || errorMsg.includes('stable') || errorMsg.includes('Called in wrong state')) {
              console.log('waitForAnswer: remote description already set (wrong state error detected)');
              answerProcessedForCall = callId; // Mark as processed
              resolve(); // Answer was already set, continue normally
            } else {
              // Some other error, re-throw
              throw setError;
            }
          }
        } else {
          console.log('waitForAnswer: answer already processed or wrong state:', signalingState, 'processed:', answerProcessedForCall === callId);
          // If already stable or already processed, the answer was already set, just resolve
          if (signalingState === 'stable' || signalingState === 'have-remote-answer' || answerProcessedForCall === callId) {
            answerProcessedForCall = callId; // Ensure it's marked
            resolve();
          } else {
            reject(new Error(`Wrong signaling state: ${signalingState}`));
          }
        }
      } catch (descError: any) {
        // Check if error is about wrong state (already set)
        const errorMsg = descError?.message || '';
        if (errorMsg.includes('wrong state') || errorMsg.includes('stable') || errorMsg.includes('Called in wrong state')) {
          console.log('waitForAnswer: remote description already set (stable/wrong state error), resolving');
          answerProcessedForCall = callId; // Mark as processed
          resolve(); // Answer was already processed
        } else {
          console.error('waitForAnswer: failed to set remote description', descError?.message || descError);
          reject(descError);
        }
      }
    };

    if (socket) {
      socket.on('answer', answerListener);
    }
  });
}

// Fallback: HTTP polling for answer (if socket fails)
async function waitForAnswerHTTP(callId: string): Promise<void> {
  const currentPc = pc;
  if (!currentPc) {
    console.warn('waitForAnswerHTTP called with no active peer connection');
    return;
  }

  for (let i = 0; i < 20; i += 1) {
    if (!pc || pc !== currentPc) {
      console.warn('waitForAnswerHTTP: peer connection was closed');
      return;
    }

    try {
      const resp = await voipFetch(`${BASE_URL}/api/calls/${callId}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.answer && data.answer.sdp) {
          console.log('waitForAnswerHTTP: got remote answer from backend');
          if (!pc || pc !== currentPc) {
            return;
          }
          // Check signaling state before setting remote description
          const signalingState = (currentPc as any).signalingState;
          console.log('waitForAnswerHTTP: current signaling state:', signalingState);

          // Only set remote description if in correct state (have-local-offer)
          // Also check if answer was already processed to prevent duplicates
          if (signalingState === 'have-local-offer' && answerProcessedForCall !== callId) {
            try {
              await currentPc.setRemoteDescription(new RTCSessionDescription(data.answer));
              answerProcessedForCall = callId; // Mark as processed immediately
              startMediaWatchdog(callId, 'caller');
              console.log('✅ waitForAnswerHTTP: remote description set successfully');

              // CRITICAL: Process any queued ICE candidates now that remote description is set
              await processQueuedIceCandidates(callId);

              // Start timer when caller receives answer via HTTP (if not already started)
              if (!activeCallStartedAt && activeCallUUID === callId) {
                activeCallStartedAt = Date.now();
              }

              // Always mark call as active when answer is received (updates CallKeep UI)
              if (activeCallUUID === callId) {
                try {
                  maybeCallKeepSetCurrentCallActive(callId);
                  console.log('CallKeep: marked call as active/connected for caller (via HTTP)', callId);
                } catch (e) {
                  console.warn('Failed to set call as active in CallKeep', e);
                }
              }

              return;
            } catch (setError: any) {
              // Handle error when setting remote description
              const errorMsg = setError?.message || '';
              if (errorMsg.includes('wrong state') || errorMsg.includes('stable') || errorMsg.includes('Called in wrong state')) {
                console.log('waitForAnswerHTTP: remote description already set (wrong state error detected)');
                answerProcessedForCall = callId; // Mark as processed
                return; // Answer was already set, continue normally
              } else {
                // Some other error, log and continue
                console.warn('waitForAnswerHTTP: error setting remote description:', setError);
              }
            }
          } else {
            console.log('waitForAnswerHTTP: answer already processed or wrong state:', signalingState, 'processed:', answerProcessedForCall === callId);
            // If already stable or already processed, the answer was already set
            if (signalingState === 'stable' || signalingState === 'have-remote-answer' || answerProcessedForCall === callId) {
              answerProcessedForCall = callId; // Ensure it's marked
              return; // Answer already processed
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('waitForAnswerHTTP: error', e?.message || e);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.warn('waitForAnswerHTTP: no answer received within timeout');
}

// Send this device's local SDP as answer back to backend via Socket.IO (faster) and HTTP (fallback)
async function sendAnswerToBackend(callId: string) {
  console.log('📤 sendAnswerToBackend: Starting to send answer for call:', callId);
  console.log('   Has pc:', !!pc);
  console.log('   Has localDescription:', !!(pc && (pc as any).localDescription));

  if (!pc) {
    console.error('❌ sendAnswerToBackend: No peer connection!');
    throw new Error('No peer connection - cannot send answer');
  }

  const localDesc = (pc as any).localDescription;
  if (!localDesc) {
    console.error('❌ sendAnswerToBackend: No local description!');
    console.error('   Signaling state:', (pc as any).signalingState);
    console.error('   Connection state:', (pc as any).connectionState);
    throw new Error('No local description - cannot send answer');
  }

  const answer = {
    type: localDesc.type,
    sdp: localDesc.sdp,
  };

  console.log('📤 sendAnswerToBackend: Answer prepared:', {
    type: answer.type,
    sdpLength: answer.sdp?.length || 0,
    callId,
    currentDeviceId,
  });

  // Get call info to find caller device ID
  let callerDeviceId: string | null = null;
  try {
    console.log('📤 sendAnswerToBackend: Fetching call info from backend...');
    const callResp = await voipFetch(`${BASE_URL}/api/calls/${callId}`);
    if (callResp.ok) {
      const callData = await callResp.json();
      callerDeviceId = callData.fromDeviceId || null;
      console.log('📤 sendAnswerToBackend: Call info retrieved:', {
        callerDeviceId,
        fromDeviceId: callData.fromDeviceId,
        toDeviceId: callData.toDeviceId,
      });
    } else {
      console.warn('📤 sendAnswerToBackend: Call not found in backend (status:', callResp.status, ')');
    }
  } catch (e) {
    console.error('❌ sendAnswerToBackend: Failed to fetch call info:', e);
    // Continue anyway - HTTP will still work
  }

  // Send via Socket.IO first (real-time, faster), but allow socket warm-up in background mode.
  ensureSocketConnected();
  let socketAttempts = 0;
  while ((!socket || !socket.connected) && socketAttempts < 6) {
    await new Promise(resolve => setTimeout(resolve, 300));
    ensureSocketConnected();
    socketAttempts++;
  }

  if (socket && socket.connected) {
    if (callerDeviceId) {
      try {
        console.log('📤 sendAnswerToBackend: Sending answer via socket to:', callerDeviceId);
        socket.emit('answer', {
          callId,
          answer,
          fromDeviceId: currentDeviceId,
          toDeviceId: callerDeviceId,
        });
        console.log('✅ sendAnswerToBackend: Answer sent via socket to', callerDeviceId);
      } catch (e) {
        console.error('❌ sendAnswerToBackend: Socket emit failed:', e);
      }
    } else {
      console.log('📤 sendAnswerToBackend: No callerDeviceId, skipping socket emit (will use HTTP only)');
    }
  } else {
    console.log('📤 sendAnswerToBackend: Socket not connected after warm-up, using HTTP retry');
  }

  // Always send via HTTP too (authoritative path); retry for background/cold-start races.
  let lastError: any = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      console.log(`📤 sendAnswerToBackend: HTTP answer attempt ${attempt}/8`);
      const resp = await voipFetch(`${BASE_URL}/api/calls/${callId}/answer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          answer,
          deviceId: currentDeviceId,
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        // 404/409/410 = call unknown / answered elsewhere / already finished -> final
        if (resp.status >= 400 && resp.status < 500) {
          const finalErr: any = new Error(`Backend rejected answer: ${resp.status} - ${errorText}`);
          finalErr.final = true;
          throw finalErr;
        }
        throw new Error(`Backend rejected answer: ${resp.status} - ${errorText}`);
      }

      console.log('✅ sendAnswerToBackend: Answer sent to backend via HTTP successfully');
      return;
    } catch (e: any) {
      lastError = e;
      if (e && e.final) {
        throw e;
      }
      console.warn(`⚠️ sendAnswerToBackend: HTTP attempt ${attempt} failed`, e);
      if (attempt < 8) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  console.error('❌ sendAnswerToBackend: Failed to send answer after retries:', lastError);
  throw lastError;
}

// Send ICE candidate - backend will forward via socket automatically
// We can also emit directly via socket for faster delivery if peer is connected
// candidate can be null to signal that gathering is complete
async function sendIceCandidate(
  callId: string,
  from: 'caller' | 'callee',
  candidate: RTCIceCandidate | null,
) {
  // Skip null candidates (gathering complete signal) - we don't need to send those
  if (!candidate) {
    console.log(`ICE candidate gathering complete for [${from}] - no need to send null candidate`);
    return;
  }
  // Try socket direct emit first (fastest path if peer is connected)
  ensureSocketConnected();
  if (socket && socket.connected) {
    try {
      // Get call info to find peer device ID
      const callResp = await voipFetch(`${BASE_URL}/api/calls/${callId}`).catch(() => null);
      if (callResp && callResp.ok) {
        const callData = await callResp.json();
        const toDeviceId = from === 'caller' ? callData.toDeviceId : callData.fromDeviceId;
        const fromDeviceId = from === 'caller' ? callData.fromDeviceId : callData.toDeviceId;

        if (toDeviceId) {
          socket.emit('ice-candidate', {
            callId,
            candidate,
            fromDeviceId: fromDeviceId || currentDeviceId,
            toDeviceId,
          });
          console.log('sendIceCandidate: sent directly via socket to', toDeviceId);
        }
      }
    } catch (e) {
      console.warn('sendIceCandidate: socket direct emit failed, using HTTP', e);
    }
  }

  // Always send via HTTP too - backend will forward via socket if peer is connected
  try {
    await voipFetch(`${BASE_URL}/api/calls/${callId}/candidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        candidate,
      }),
    });
  } catch (e) {
    console.warn('sendIceCandidate: HTTP send failed', e);
  }
}

// Poll backend for ICE candidates (fallback only - socket events are preferred)
// Note: This is kept as a fallback but socket events handle ICE candidates in real-time
async function pollRemoteCandidates(
  callId: string,
  side: 'caller' | 'callee',
) {
  // With socket events, this function is no longer needed for real-time signaling.
  // ICE candidates are received via socket.on('ice-candidate') in real-time.
  // This function is kept as a fallback or for catching up on missed candidates.
  console.log('pollRemoteCandidates: Using socket events for real-time ICE candidates');

  // Optionally, do a one-time fetch to catch any missed candidates
  const currentPc = pc;
  if (!currentPc) {
    return;
  }

  try {
    const querySide = side === 'caller' ? 'caller' : 'callee';
    const resp = await voipFetch(
      `${BASE_URL}/api/calls/${callId}/candidates?for=${querySide}`,
    );
    if (resp.ok) {
      const data = await resp.json();
      const candidates: any[] = data.candidates || [];
      for (const c of candidates) {
        try {
          if (!pc || pc !== currentPc) {
            return;
          }

          // Check peer connection state before adding candidate
          const connectionState = (currentPc as any).connectionState;
          const iceConnectionState = (currentPc as any).iceConnectionState;

          if (connectionState === 'closed' || connectionState === 'failed') {
            console.warn('Cannot add ICE candidate from fallback - peer connection is', connectionState);
            return;
          }

          if (iceConnectionState === 'closed' || iceConnectionState === 'failed') {
            console.warn('Cannot add ICE candidate from fallback - ICE connection is', iceConnectionState);
            return;
          }

          // Validate candidate
          if (!c.candidate) {
            console.warn('Invalid ICE candidate from fallback - missing candidate field');
            return;
          }

          await currentPc.addIceCandidate(new RTCIceCandidate(c));
          console.log('Added missed ICE candidate from HTTP fallback');
        } catch (err: any) {
          const errorMsg = err?.message || String(err);

          // Handle specific errors gracefully
          if (errorMsg.includes('InvalidStateError') || errorMsg.includes('Invalid state')) {
            console.warn('Cannot add ICE candidate from fallback - invalid state');
            return;
          }

          if (errorMsg.includes('Invalid candidate') || errorMsg.includes('InvalidCandidateError')) {
            console.warn('Invalid ICE candidate from fallback:', c);
            return;
          }

          console.warn('Failed to add ICE candidate from fallback', errorMsg);
        }
      }
    }
  } catch (e: any) {
    console.warn('pollRemoteCandidates fallback error', e?.message || e);
  }
}

// --- Outgoing call: create CallKeep call, start WebRTC and send offer to backend ---
/**
 * Start an outgoing voice-only call to a remote device.
 *
 * @param targetDeviceId remote device identifier / push token (e.g. "8936ddd19...")
 * @param displayName    human-readable name for CallKit / call UI
 */
export async function startOutgoingVoiceCall(
  targetDeviceId: string,
  displayName: string,
): Promise<void> {
  if (isAnotherCallInProgress()) {
    androidTelemetry('outgoing_blocked_busy');
    return;
  }
  // Clean up any existing call completely before starting new one
  if (activeCallUUID || incomingCallUUID || currentCallState !== 'idle') {
    console.log('🧹 Cleaning up previous call before starting new one...');

    // End any active call in CallKeep
  if (activeCallUUID) {
      try {
    RNCallKeep.endCall(activeCallUUID);
      } catch (e) {
        console.warn('Error ending previous call in CallKeep:', e);
      }
    }
    if (incomingCallUUID) {
      try {
        RNCallKeep.endCall(incomingCallUUID);
      } catch (e) {
        console.warn('Error ending previous incoming call in CallKeep:', e);
      }
    }

    // Clean up all resources
    endVoiceCall();

    // Reset all state variables
    activeCallUUID = null;
    incomingCallUUID = null;
    currentCallState = 'idle';
    callerName = null;
    answerProcessedForCall = null;

    // Small delay to ensure cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 200));
    console.log('✅ Previous call cleaned up, ready for new call');
  }

  // CRITICAL: Force reset ringback state before EVERY new call
  // This ensures ringback plays on 2nd, 3rd, etc. calls
  forceResetRingbackState();

  const callUUID = generateUUID();
  if (!tryAcquireCallLock(callUUID, 'outgoing-device')) {
    return;
  }
  activeCallUUID = callUUID;
  currentCallState = 'calling';
  callerName = displayName;
  connectionState = 'connecting'; // Set initial connection state
  // Reset answer processed flag for new call
  answerProcessedForCall = null;

  // 1. Start native outgoing UI only on iOS.
  // On Android we keep the flow in-app to avoid default telecom UI interruptions.
  if (Platform.OS === 'ios') {
    try {
      maybeCallKeepStartCall(callUUID, targetDeviceId, displayName);
      console.log('CallKeep: started outgoing call UI for', callUUID, 'to', displayName);
    } catch (e) {
      console.error('Failed to start CallKeep call UI', e);
      throw e;
    }
  } else {
    console.log('Android: skipping RNCallKeep.startCall for outgoing flow');
  }

  try {
    ensureSocketConnected();
    androidTelemetry('foreground_service_start_request', {phase: 'outgoing'});
    // 2. Start local WebRTC and create offer (this also initializes InCallManager)
    await startVoiceCall(callUUID, undefined, 'caller');
    const localDesc = pc?.localDescription;
    if (!localDesc) {
      throw new Error('Local description not set after createOffer');
    }

    console.log('Outgoing call offer SDP:', localDesc.type, localDesc.sdp?.slice(0, 80) + '...');
    if (Platform.OS === 'android') {
      try {
        maybeCallKeepStartCall(callUUID, targetDeviceId, displayName);
      } catch (e) {
        console.warn('Android startCall failed after WebRTC prep', e);
      }
    }

    // Start ringback AFTER WebRTC/InCallManager setup is complete
    console.log('🔔 Starting ringback for outgoing call...');
    await startRingback();

    // 3. Send offer + target device id to your backend so it can:
    //    - send a PushKit / FCM push to the remote device (using targetDeviceId)
    //    - deliver the SDP offer via your signaling channel
    //
    try {
      await voipFetch(`${BASE_URL}/api/calls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
          body: JSON.stringify({
          callId: callUUID,
          toDeviceId: targetDeviceId,
          toLoyaltyId: undefined, // Can be used if provided
          fromDeviceId: currentDeviceId,
          fromLoyaltyId: undefined, // Can be used if provided
          callerName: displayName,
          offer: {
            type: localDesc.type,
            sdp: localDesc.sdp,
          },
        }),
      });
    } catch (networkErr) {
      console.warn('Failed to send offer to backend', networkErr);
      // You might want to retry or show error to user here.
    }
  } catch (err) {
    console.error('Failed to start outgoing voice call', err);
    RNCallKeep.endCall(callUUID);
    activeCallUUID = null;
    endVoiceCall();
    stopRingback();
  }

  // 4. On caller side, wait for callee's answer via Socket.IO (real-time, faster)
  // Note: ringback will stop when socket receives 'call-state: answered' event
  // ICE candidates are received in real-time via socket.on('ice-candidate')
  try {
    await waitForAnswer(callUUID);

    // Ensure CallKeep UI is active and shows timer after answer is received
    // This is critical for User 1 (caller) to see the call as connected
    if (activeCallUUID === callUUID) {
      try {
        // Double-check call is marked as active (ensures CallKeep UI shows timer)
        maybeCallKeepSetCurrentCallActive(callUUID);
        console.log('CallKeep: ensured call is active after answer received for caller', callUUID);
      } catch (e) {
        console.warn('Failed to ensure call is active in CallKeep after answer', e);
      }
    }

    // Do a one-time catch-up poll for any ICE candidates that might have been missed
    // (socket events handle real-time delivery, this is just a safety net)
    void pollRemoteCandidates(callUUID, 'caller');
  } catch (e) {
    console.warn('startOutgoingVoiceCall: error while waiting for answer', e);
    // Only stop ringback if there was an error (timeout, etc.)
    // Otherwise, let socket 'answered' event stop it
    stopRingback();
  }
}

function endVoiceCall() {
  console.log('endVoiceCall: Stopping all media tracks and cleaning up...');
  clearMediaWatchdog();

  // Clear ICE failure timeout if active
  if (iceFailureTimeout) {
    clearTimeout(iceFailureTimeout);
    iceFailureTimeout = null;
  }

  // Clear reconnection timeout if active
  if (reconnectionTimeout) {
    clearTimeout(reconnectionTimeout);
    reconnectionTimeout = null;
  }

  // Reset ICE restart attempts
  iceRestartAttempts = 0;

  // Reset answer processed flag
  answerProcessedForCall = null;

  // Reset microphone and speaker states
  isMuted = false;
  isSpeakerEnabled = false;
  currentSpeakerMode = 'earpiece';
  lastSpeakerToggleMs = 0;

  // Reset connection state
  connectionState = null;

  // IMPORTANT: Reset call state to idle immediately when call ends
  // This ensures modal closes properly and new calls can start cleanly
  if (currentCallState !== 'idle') {
    console.log('endVoiceCall: Resetting call state from', currentCallState, 'to idle');
    currentCallState = 'idle';
  }

  // Reset caller name
  callerName = null;

  // Reset active call started timestamp
  activeCallStartedAt = null;

  console.log('endVoiceCall: ✅ Reset microphone (unmuted) and speaker states');

  // First, stop all local audio tracks (microphone) before closing peer connection
  if (localStream) {
    try {
      const tracks = localStream.getTracks();
      console.log('endVoiceCall: Stopping', tracks.length, 'local audio track(s)');
      tracks.forEach(track => {
        try {
          track.stop();
          console.log('endVoiceCall: ✅ Stopped local track:', track.kind, track.id);
        } catch (e) {
          console.warn('endVoiceCall: Error stopping local track:', e);
        }
      });
      localStream = null;
    } catch (e) {
      console.error('endVoiceCall: Error accessing localStream:', e);
    }
  }

  // Stop all remote tracks
  if (remoteStream) {
    try {
      const tracks = remoteStream.getTracks();
      console.log('endVoiceCall: Stopping', tracks.length, 'remote track(s)');
      tracks.forEach(track => {
        try {
          track.stop();
          console.log('endVoiceCall: ✅ Stopped remote track:', track.kind, track.id);
        } catch (e) {
          console.warn('endVoiceCall: Error stopping remote track:', e);
        }
      });
      remoteStream = null;
    } catch (e) {
      console.error('endVoiceCall: Error accessing remoteStream:', e);
    }
  }

  // Stop and remove all tracks from peer connection senders
  if (pc) {
    try {
      const senders = pc.getSenders();
      console.log('endVoiceCall: Stopping', senders.length, 'sender track(s)');
      senders.forEach(sender => {
        if (sender.track) {
          try {
            sender.track.stop();
            console.log('endVoiceCall: ✅ Stopped sender track:', sender.track.kind, sender.track.id);
          } catch (e) {
            console.warn('endVoiceCall: Error stopping sender track:', e);
          }
        }
        // Remove track from sender
        try {
          sender.replaceTrack(null).catch((e: any) => {
            console.warn('endVoiceCall: Error replacing track with null:', e);
          });
        } catch (e) {
          console.warn('endVoiceCall: Error removing track from sender:', e);
        }
      });

      // Close peer connection
      try {
        pc.close();
        console.log('endVoiceCall: ✅ Closed peer connection');
        androidTelemetry('peer_closed');
      } catch (e) {
        console.warn('endVoiceCall: Error closing peer connection:', e);
      }
      pc = null;
    } catch (e) {
      console.error('endVoiceCall: Error accessing peer connection:', e);
      pc = null;
    }
  }

  // Stop all audio tones when call ends
  cleanupRingbackAudio();
  stopIncomingRingtone();

  // Stop InCallManager - CRITICAL for allowing next call's ringback to work
  try {
    InCallManager.stop();
    InCallManager.setKeepScreenOn(false);
    console.log('✅ InCallManager stopped');
  } catch (e) {
    console.warn('⚠️ Failed to stop InCallManager:', e);
  }
  if (Platform.OS === 'android') {
    androidTelemetry('foreground_service_stop_request');
    void stopAndroidCallForegroundService();
    androidTelemetry('foreground_service_stopped');
  }
  unregisterAndroidAudioRouteObservers();
  releaseCallLock();
  androidTelemetry('cleanup_complete', {
    hasPc: !!pc,
    hasLocal: !!localStream,
    hasRemote: !!remoteStream,
    callState: currentCallState,
  });

  console.log('endVoiceCall: ✅ All media tracks stopped and resources cleaned up');
}

// Network monitoring and reconnection logic
function startNetworkMonitoring() {
  if (isNetworkMonitoring) {
    return;
  }

  isNetworkMonitoring = true;
  // console.log('📡 Starting network monitoring...');

  // Get initial network state
  NetInfo.fetch().then((state: NetInfoState) => {
    lastNetworkState = state;
    // console.log('📡 Initial network state:', state.type, state.isConnected);
  });

  // Subscribe to network state changes
  networkUnsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
    const wasConnected = lastNetworkState?.isConnected ?? false;
    const isConnected = state.isConnected ?? false;
    const networkTypeChanged = lastNetworkState?.type && lastNetworkState?.type !== state.type;
    if (wasConnected !== isConnected || networkTypeChanged) {
      androidTelemetry('network_state', {connected: isConnected, type: state.type});
    }

    // console.log('📡 Network state changed:', {
    //   type: state.type,
    //   isConnected,
    //   wasConnected,
    //   details: state.details,
    // });

    // If network was disconnected and now connected, try to reconnect
    if (!wasConnected && isConnected && activeCallUUID && pc) {
      console.log('🔄 Network reconnected - attempting to reconnect call...');
      if (currentCallState === 'answered' || currentCallState === 'calling' || currentCallState === 'ringing') {
        attemptReconnection(activeCallUUID);
      }
    }

    // If network disconnected during active call, update connection state
    if (!isConnected && activeCallUUID && (currentCallState === 'answered' || currentCallState === 'calling')) {
      console.warn('⚠️ Network disconnected during active call');
      connectionState = 'disconnected';
    }

    lastNetworkState = state;
  });
}

function stopNetworkMonitoring() {
  if (networkUnsubscribe) {
    networkUnsubscribe();
    networkUnsubscribe = null;
    isNetworkMonitoring = false;
    console.log('📡 Network monitoring stopped');
  }
}

// Attempt to reconnect peer connection
async function attemptReconnection(callUUID: string) {
  if (!pc || !activeCallUUID || activeCallUUID !== callUUID) {
    console.log('⚠️ Cannot reconnect - no active peer connection or call UUID mismatch');
    return;
  }

  if (connectionState === 'reconnecting') {
    console.log('⚠️ Reconnection already in progress');
    return;
  }

  console.log('🔄 Attempting to reconnect call:', callUUID);
  connectionState = 'reconnecting';

  // Clear any existing reconnection timeout
  if (reconnectionTimeout) {
    clearTimeout(reconnectionTimeout);
    reconnectionTimeout = null;
  }

  try {
    // Check if peer connection is still valid
    if (pc.signalingState === 'closed' || pc.connectionState === 'closed') {
      console.warn('⚠️ Peer connection is closed - cannot reconnect');
      connectionState = 'failed';
      return;
    }

    // Try ICE restart
    if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
      console.log('🔄 Restarting ICE connection...');
      safeRestartIce(pc, 'network-reconnection');

      // Set timeout to check if reconnection succeeded
      reconnectionTimeout = setTimeout(() => {
        if (pc && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
          console.log('✅ Reconnection successful!');
          connectionState = 'connected';
        } else if (connectionState === 'reconnecting') {
          console.warn('⚠️ Reconnection timeout - connection may still be pending');
          // Don't set to failed yet - let ICE continue trying
        }
        reconnectionTimeout = null;
      }, 10000); // 10 second timeout
    } else {
      console.log('✅ ICE connection already established');
      connectionState = 'connected';
    }
  } catch (e) {
    console.error('❌ Reconnection attempt failed:', e);
    connectionState = 'failed';
    reconnectionTimeout = null;
  }
}

export function initVoipAndCallKeep(loyaltyId?: string) {
  if (isVoipInitializing) {
    androidTelemetry('init_skipped_in_progress');
    return;
  }
  // Prevent multiple initializations
  if (isVoipInitialized) {
    console.log('VoipAndCallKeep already initialized, updating if needed...');
    // If loyalty_id provided, update it
    if (loyaltyId) {
      currentLoyaltyId = loyaltyId;
    }

    // Force update backend registration with current token and loyalty_id
    // This ensures backend is always up to date even if token hasn't changed
    if (currentDeviceId) {
      registerDeviceWithBackend(currentDeviceId, currentLoyaltyId).catch((e) => {
        console.warn('Failed to update device registration', e);
      });
    }

    // Re-register VoIP token to ensure it's up to date (in case token changed)
    if (Platform.OS === 'ios') {
      try {
        VoipPushNotification.registerVoipToken();
        console.log('VoIP token re-registration requested');
      } catch (e) {
        console.warn('Failed to re-register VoIP token', e);
      }
    }

    // Handle any pending answer that was waiting for initialization
    if (pendingAnswerCallUUID) {
      schedulePendingAnswer(pendingAnswerCallUUID, 1500, 'init_again');
    }
    recoverCallKeepInitialEvents('init_again');
    return;
  }

  // Set loyalty_id if provided
  if (loyaltyId) {
    currentLoyaltyId = loyaltyId;
  }

  isVoipInitializing = true;
  try {
    // console.log('🔧 Initializing CallKeep...');
    telecomDebug('setup_start');
    const callKeepSetupOptions = buildCallKeepSetupOptions();
    const androidSetup = (callKeepSetupOptions as any)?.android;
    if (
      Platform.OS === 'android' &&
      (!androidSetup ||
        !androidSetup.alertTitle ||
        !androidSetup.alertDescription ||
        !androidSetup.foregroundService?.channelId)
    ) {
      telecomDebug('setup_abort_invalid_android_options', {
        hasAndroid: !!androidSetup,
        hasAlertTitle: !!androidSetup?.alertTitle,
        hasAlertDescription: !!androidSetup?.alertDescription,
        hasChannelId: !!androidSetup?.foregroundService?.channelId,
      });
      isVoipInitializing = false;
      return;
    }
    telecomDebug('setup_options_ready', {
      hasAndroid: !!(callKeepSetupOptions as any)?.android,
      alertTitle: (callKeepSetupOptions as any)?.android?.alertTitle || null,
    });
    RNCallKeep.setup(callKeepSetupOptions);
    telecomDebug('setup_called');
    RNCallKeep.setAvailable(true);
    telecomDebug('setAvailable_true_called');
    isVoipInitialized = true;
    // console.log('✅ VoipAndCallKeep initialized successfully');
    // console.log('   CallKeep setup complete');
    // console.log('   VoIP initialization flag set to true');

    // Start network monitoring
    startNetworkMonitoring();

    if (Platform.OS === 'android') {
      void ensureAndroidTelecomReady().catch((e) => {
        telecomDebug('ensureAndroidTelecomReady_failed', {
          error: e?.message || String(e),
        });
      });
      if (!appStateSubscription) {
        appStateSubscription = AppState.addEventListener(
          'change',
          (state: AppStateStatus) => {
            androidTelemetry('app_state', {state});
          },
        );
      }
      void requestAndroidCallPermissions();
      void ensureAndroidBatteryOptimizationHandled();
      void messaging()
        .getToken()
        .then(token => {
          if (!token) {
            return;
          }
          currentDeviceId = token;
          return registerDeviceWithBackend(token, currentLoyaltyId);
        })
        .catch(e => {
          console.warn('Failed to register Android FCM token', e);
        });

      if (!fcmTokenRefreshUnsubscribe) {
        fcmTokenRefreshUnsubscribe = messaging().onTokenRefresh(token => {
          if (!token) {
            return;
          }
          currentDeviceId = token;
          registerDeviceWithBackend(token, currentLoyaltyId).catch(e => {
            console.warn('Failed to refresh Android FCM token registration', e);
          });
        });
      }

      void messaging()
        .getInitialNotification()
        .then(initialMessage => {
          if (initialMessage?.data) {
            handleAndroidIncomingCallNotification(initialMessage.data).catch(
              e => {
                console.warn(
                  'Failed to process Android initial notification call',
                  e,
                );
              },
            );
          }
        })
        .catch(e => {
          console.warn('Failed to read Android initial notification', e);
        });

      // CallKeep initial events (answer before JS start) are recovered below for both platforms.
    }

    // iOS and Android: answer made in CallKit / ConnectionService before JS started.
    recoverCallKeepInitialEvents('init');

    // Handle any pending answer that was waiting for initialization
    if (pendingAnswerCallUUID) {
      schedulePendingAnswer(pendingAnswerCallUUID, 1000, 'init');
    }

    // Opening the app after answering from the lock screen / long background:
    // reconnect signaling and complete the answer (both platforms).
    if (!voipResumeSubscription) {
      voipResumeSubscription = AppState.addEventListener(
        'change',
        (state: AppStateStatus) => {
          if (state === 'active') {
            onVoipAppActive();
          }
        },
      );
    }
  } catch (e) {
    console.error('❌ Failed to setup CallKeep', e);
    console.error('   Error details:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
    isVoipInitializing = false;
    return;
  }
  isVoipInitializing = false;

  // Set up event listener BEFORE registering token to ensure we catch the event
  // console.log('🔧 Setting up VoIP token registration event listener...');

  try {
    VoipPushNotification.addEventListener('register', async (token: string | any) => {
      // console.log('📨 VoIP token registration event received!');
      // console.log('   Event listener is working correctly');

      // Handle different token formats - token might be a string or an object
      let tokenString: string = '';

      if (typeof token === 'string') {
        tokenString = token;
      } else if (token && typeof token === 'object') {
        // Token might be in an object format
        tokenString = token.token || token.voipToken || token.deviceToken || String(token) || '';
      } else if (token) {
        tokenString = String(token);
      }

      // Clean and format the token (remove spaces, convert to hex string if needed)
      // VoIP tokens from iOS are typically hex strings without spaces
      const cleanedToken = tokenString.replace(/\s+/g, '').trim();

      // console.log('📱 VoIP token registered/updated event received');
      // console.log('   Raw token type:', typeof token);
      // console.log('   Raw token value:', token);
      // console.log('   Token string:', tokenString);
      // console.log('   Raw token length:', tokenString.length);
      // console.log('   Cleaned token length:', cleanedToken.length);

    // Validate token - skip if empty
    if (!cleanedToken || cleanedToken.length === 0) {
      console.warn('⚠️ Received empty VoIP token, skipping registration');
      console.warn('   This might happen if:');
      console.warn('   1. VoIP push notifications are not properly configured in Xcode');
      console.warn('   2. App is running in simulator (VoIP tokens only work on real devices)');
      console.warn('   3. Push notification capabilities are not enabled');
      console.warn('   4. App is not properly signed with a development/distribution certificate');
      return;
    }

    // console.log('   Token preview:', cleanedToken.substring(0, 32) + '...' + cleanedToken.substring(Math.max(0, cleanedToken.length - 16)));

    // Check if token changed or if this is first registration
    const isFirstRegistration = !currentDeviceId;
    const tokenChanged = currentDeviceId !== cleanedToken && !isFirstRegistration;
    const previousDeviceId = currentDeviceId;
    currentDeviceId = cleanedToken;

    // Use loyalty_id from logged-in user (set via setUserLoyaltyId or passed to initVoipAndCallKeep)
    const loyaltyIdToUse = currentLoyaltyId;

    if (!loyaltyIdToUse) {
      console.warn('⚠️ No loyalty_id set. Device will be registered without loyalty_id.');
      console.warn('   Call setUserLoyaltyId() or pass loyaltyId to initVoipAndCallKeep() to set it.');
    }

    // Always register/update device with backend (even if token hasn't changed)
    // This ensures backend always has the latest token and loyalty_id
    try {
      await registerDeviceWithBackend(cleanedToken, loyaltyIdToUse);

      // Also register with socket immediately to show user as online in real-time
      ensureSocketConnected();
      if (socket && socket.connected && loyaltyIdToUse) {
        socket.emit('registerDevice', {
          deviceId: cleanedToken,
          loyaltyId: loyaltyIdToUse,
        });
        // console.log('VoIP token: Registered device with socket (loyaltyId available)');
      } else if (socket && socket.connected) {
        // Register without loyaltyId if not available yet
        socket.emit('registerDevice', {
          deviceId: cleanedToken,
        });
        // console.log('VoIP token: Registered device with socket (no loyaltyId yet)');
      }

      if (isFirstRegistration) {
        // console.log('✅ VoIP token registered for the first time with backend');
        // console.log('   Device ID:', cleanedToken);
        // console.log('   Token length:', cleanedToken.length);
        if (loyaltyIdToUse) {
          // console.log('   Loyalty ID:', loyaltyIdToUse);
        } else {
          console.log('   ⚠️ No loyalty_id - device registered without user association');
        }
      } else if (tokenChanged) {
        // console.log('✅ VoIP token changed and registered with backend');
        // console.log('   Previous token length:', previousDeviceId?.length || 0);
        // console.log('   New token length:', cleanedToken.length);
        // console.log('   Device ID:', cleanedToken);
        if (loyaltyIdToUse) {
          // console.log('   Loyalty ID:', loyaltyIdToUse);
        }
      } else {
        // console.log('✅ Device registration confirmed/updated with backend (token unchanged)');
        // console.log('   Device ID:', cleanedToken);
        // console.log('   Token length:', cleanedToken.length);
        if (loyaltyIdToUse) {
          // console.log('   Loyalty ID:', loyaltyIdToUse);
        }
      }
    } catch (e) {
      console.error('❌ Failed to register/update device on backend', e);
      console.error('   Token that failed:', cleanedToken);
      console.error('   Loyalty ID:', loyaltyIdToUse || 'none');
    }

    // After device is registered, process any pending answer
    // Wait a bit more to ensure socket is connected and registered
    // Idempotent: the token event fires several times (requestToken retries),
    // schedulePendingAnswer ignores a call that is already being answered.
    if (pendingAnswerCallUUID) {
      schedulePendingAnswer(pendingAnswerCallUUID, 1500, 'voip_register');
    }
  });

  console.log('✅ VoIP token registration event listener set up successfully');
  } catch (listenerError) {
    console.error('❌ Failed to set up VoIP token registration event listener', listenerError);
    console.error('   This is critical - token registration will not work!');
    console.error('   Error details:', JSON.stringify(listenerError, null, 2));
  }

  // Register for VoIP token AFTER setting up the event listener
  // This ensures the listener is ready when the token arrives
  // Use a delay to ensure React Native bridge and native modules are fully ready
  if (Platform.OS === 'ios') {
    // console.log('🔍 Checking VoIP push notification setup...');
    // console.log('   Platform:', Platform.OS);
    // console.log('   VoipPushNotification module:', typeof VoipPushNotification);
    // console.log('   VoipPushNotification object:', VoipPushNotification);

    // Wait for React Native bridge to fully initialize before requesting token
    // The library's native module needs to be fully loaded
    const requestToken = (attempt: number) => {
      try {
        // console.log(`📱 [Attempt ${attempt}] Requesting VoIP token registration from iOS...`);
        // console.log('   Checking if VoipPushNotification is available:', typeof VoipPushNotification);
        // console.log('   registerVoipToken method available:', typeof VoipPushNotification.registerVoipToken);
        // console.log('   All VoipPushNotification methods:', Object.keys(VoipPushNotification || {}));

        if (!VoipPushNotification) {
          console.error('❌ VoipPushNotification module is null or undefined!');
          console.error('   This means the native module is not properly linked.');
          console.error('   Please ensure:');
          console.error('   1. Run "cd ios && pod install"');
          console.error('   2. Clean build folder in Xcode (Cmd+Shift+K)');
          console.error('   3. Rebuild the app');
          console.error('   4. Make sure react-native-voip-push-notification is in package.json');
          return;
        }

        if (typeof VoipPushNotification.registerVoipToken !== 'function') {
          console.error('❌ VoipPushNotification.registerVoipToken is not a function!');
          console.error('   Available methods:', Object.keys(VoipPushNotification));
          console.error('   This usually means the native module is not properly linked.');
          console.error('   Please ensure:');
          console.error('   1. Run "cd ios && pod install"');
          console.error('   2. Clean build folder in Xcode (Cmd+Shift+K)');
          console.error('   3. Rebuild the app');
          return;
        }

        // console.log('   ✅ registerVoipToken is available, calling it...');
        VoipPushNotification.registerVoipToken();
        // console.log(`✅ [Attempt ${attempt}] VoIP token registration requested successfully`);
      } catch (e: any) {
        console.error(`❌ [Attempt ${attempt}] Failed to register VoIP token`, e);
        console.error('   Error name:', e?.name);
        console.error('   Error message:', e?.message);
        console.error('   Error stack:', e?.stack);
        console.error('   Error details:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
      }
    };

    // Try immediately (in case bridge is already ready)
    requestToken(1);

    // Also try after delays to account for async initialization
    setTimeout(() => requestToken(2), 1000);
    setTimeout(() => requestToken(3), 3000);
    setTimeout(() => requestToken(4), 5000);
    setTimeout(() => requestToken(5), 10000); // One more attempt after 10 seconds
  } else {
    console.log('ℹ️ VoIP push notifications are only available on iOS');
    console.log('   Current platform:', Platform.OS);
  }

  VoipPushNotification.addEventListener('notification', (notification: any) => {
    console.log('Incoming VoIP push:', notification);

    // CRITICAL: Guard - ignore pushes for other users after account switch.
    // Backend includes toLoyaltyId (callee) in payload. If we're logged in as different user, ignore.
    const toLoyaltyId = notification.toLoyaltyId || notification.toUserId;
    const callIdForDismiss = notification.callId || notification.uuid;
    if (toLoyaltyId && currentLoyaltyId && String(toLoyaltyId).replace(/\s+/g, '') !== String(currentLoyaltyId).replace(/\s+/g, '')) {
      console.log('⚠️ Ignoring VoIP push for different user:', toLoyaltyId, 'current:', currentLoyaltyId);
      if (callIdForDismiss) {
        try {
          RNCallKeep.endCall(callIdForDismiss);
        } catch (e) {
          console.warn('Failed to dismiss CallKeep for wrong user', e);
        }
      }
      return;
    }
    if (toLoyaltyId && !currentLoyaltyId) {
      console.log('⚠️ Ignoring VoIP push - no logged-in user (logged out)');
      if (callIdForDismiss) {
        try {
          RNCallKeep.endCall(callIdForDismiss);
        } catch (e) {
          console.warn('Failed to dismiss CallKeep for logged-out state', e);
        }
      }
      return;
    }

    if (Platform.OS === 'android') {
      handleAndroidIncomingCallNotification(notification).catch(e => {
        console.warn('Failed to handle Android incoming notification', e);
      });
      return;
    }

    // Store the incoming call UUID so we can track it when user answers
    const callUUID = notification.callId || notification.uuid || String(Date.now());
    if (notification.offer?.sdp) {
      incomingOfferByCallId.set(callUUID, notification.offer);
    }
    // After a background resume the push event can arrive AFTER the answer event:
    // do not turn an answered call back into "ringing".
    if (
      pendingAnswerCallUUID === callUUID ||
      answerGate.isInFlight(callUUID) ||
      answerGate.isDone(callUUID) ||
      (activeCallUUID === callUUID && currentCallState !== 'ringing')
    ) {
      console.log('VoIP push for a call that is already answered, ignore UI reset:', callUUID);
      return;
    }
    incomingCallUUID = callUUID; // Track incoming call for modal
    // Don't set activeCallUUID yet - only set it when user actually answers

    // Update call state and caller name
    currentCallState = 'ringing';
    connectionState = 'connecting'; // Set initial connection state
    callerName = notification.callerName || notification.handle || 'Incoming call';

    // Start incoming call ringtone (for Android or custom iOS behavior)
    startIncomingRingtone();

    // NOTE:
    // On iOS we already trigger CallKit UI natively in AppDelegate
    // via RNCallKeep.reportNewIncomingCall when a VoIP push arrives.
    // This works even when app is closed/backgrounded.
    // When app is open, we also want to show our custom modal.
    if (Platform.OS !== 'ios') {
      const handle = notification.handle ?? 'caller';
      const callerName = notification.callerName ?? 'Incoming call';

      console.log('Incoming call:', callUUID, handle, callerName);

      safeAndroidDisplayIncomingCall(callUUID, handle, callerName);
    }

    // If app is already open, the modal will be shown by App.tsx monitoring call state
    // The CallKeep UI will also be shown by AppDelegate (iOS) or above (Android)
  });

  // When user answers in CallKit → start WebRTC voice call
  // This works even when app is closed - the app will open and handle the answer
  RNCallKeep.addEventListener('answerCall', async ({callUUID}) => {
    androidTelemetry('callkeep_answer', {});
    console.log('📞 Call answered via CallKeep UI - callUUID:', callUUID);

    // If we're already handling a programmatic answer, skip this event
    // (it was triggered by our answerIncomingCall call)
    if (isAnsweringProgrammatically) {
      console.log('📞 AnswerCall event triggered by programmatic answer - already handling');
      return;
    }

    // CRITICAL: Set state immediately even if VoIP not initialized
    // This ensures modal shows active call screen when app opens
    activeCallUUID = callUUID;
    incomingCallUUID = null;
    currentCallState = 'answered';
    lastAcceptedCallUUID = callUUID;
    lastAcceptedAtMs = Date.now();
    console.log('✅ Call state set to answered immediately for callUUID:', callUUID);

    // Stop incoming ringtone when user answers
    stopIncomingRingtone();

    // If VoIP is not yet initialized (app was closed), store the answer for later
    if (!isVoipInitialized) {
      console.log('⚠️ VoIP not initialized yet, storing pending answer for call:', callUUID);
      pendingAnswerCallUUID = callUUID;
      // State is already set above, so modal will show correctly
      // The answer will be processed when initVoipAndCallKeep is called
      return;
    }

    if (Platform.OS === 'android') {
      activateAndroidAudioSession('answerCall-event');
      const hasPermissions = await requestAndroidCallPermissions();
      if (!hasPermissions) {
        // Do not force-reject incoming call when answering from background/killed state.
        // Runtime permission prompt can fail in headless flow; continue best-effort.
        console.warn(
          'Android answer: RECORD_AUDIO permission not granted, continuing best-effort without auto-reject',
        );
      }
    }

    // Use the shared answer handler function
    try {
      await handleAnswerCall(callUUID);
      console.log('✅ Call answered successfully via CallKeep');
    } catch (e) {
      console.error('❌ Failed to handle answer call from CallKeep:', e);
      // Error handling is already done in handleAnswerCall
    }
  });

  RNCallKeep.addEventListener('endCall', ({callUUID}) => {
    androidTelemetry('callkeep_end', {});
    const justAcceptedSameCall =
      callUUID &&
      lastAcceptedCallUUID === callUUID &&
      Date.now() - lastAcceptedAtMs < 3000;
    if (Platform.OS === 'android' && justAcceptedSameCall) {
      console.warn(
        'Android: ignoring transient endCall right after answer',
        callUUID,
      );
      return;
    }

    console.log('Call ended:', callUUID);

    // Reset all call states
    if (activeCallUUID === callUUID) {
      activeCallUUID = null;
    }
    if (incomingCallUUID === callUUID) {
      incomingCallUUID = null;
    }
    if (pendingAnswerCallUUID === callUUID) {
      pendingAnswerCallUUID = null;
    }
    incomingOfferByCallId.delete(callUUID);
    activeCallStartedAt = null;
    callerName = null;

    // Clean up all resources - this will reset state to idle immediately
    endVoiceCall();

    // Stop any playing ringtones
    stopRingback();
    stopIncomingRingtone();

    // Inform backend so the other user can end their CallKeep UI as well
    if (currentDeviceId) {
      voipFetch(`${BASE_URL}/api/calls/${callUUID}/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: currentDeviceId,
        }),
      }).catch(e => {
        console.warn('Failed to notify backend about call end', e);
      });
    }

    // Reset call state to idle after delay (so modal can show "ended" state briefly)
    setTimeout(() => {
      if (currentCallState === 'ended') {
        currentCallState = 'idle';
      }
    }, 3000);
  });

  // Listen for mute toggle from CallKeep UI
  RNCallKeep.addEventListener('didPerformSetMutedCallAction', ({muted, callUUID}) => {
    console.log('🔇 CallKeep mute action:', {muted, callUUID});

    // Sync mute state with our internal state
    if (isMuted !== muted) {
      isMuted = muted;

      // Apply mute state to audio tracks
      if (pc) {
        try {
          // Update local stream tracks
          if (localStream) {
            localStream.getAudioTracks().forEach((track: any) => {
              track.enabled = !muted;
            });
          }

          // Update peer connection senders
          const senders = pc.getSenders();
          senders.forEach((sender) => {
            if (sender.track && sender.track.kind === 'audio') {
              sender.track.enabled = !muted;
            }
          });

          // Update InCallManager mute state
          InCallManager.setMicrophoneMute(muted);

          console.log(`✅ Mute state synced from CallKeep: ${muted ? 'muted' : 'unmuted'}`);
        } catch (e) {
          console.error('❌ Failed to sync mute state from CallKeep:', e);
        }
      }
    }
  });

  // Listen for speaker toggle from CallKeep UI (iOS only via audio route change)
  // Note: iOS CallKit doesn't provide a direct speaker event, but we can detect audio route changes
  // For Android, CallKeep provides setSpeakerPhoneOn which we already handle
  RNCallKeep.addEventListener('didToggleHoldCallAction', ({hold, callUUID}) => {
    if (Platform.OS !== 'android') {
      return;
    }
    console.log('📞 CallKeep hold action:', {hold, callUUID});
    // Keep call in active mode for now; hold is optional and not mapped to WebRTC pause.
    if (!hold && callUUID) {
      try {
        maybeCallKeepSetCurrentCallActive(callUUID);
      } catch (e) {
        console.warn('Failed to re-activate call after hold toggle', e);
      }
    }
  });

  RNCallKeep.addEventListener('didActivateAudioSession', () => {
    if (Platform.OS === 'ios') {
      notifyWebRtcAudioSession(true, 'callkit');
      return;
    }
    activateAndroidAudioSession('didActivateAudioSession');
  });

  RNCallKeep.addEventListener('didDeactivateAudioSession', () => {
    notifyWebRtcAudioSession(false, 'callkit');
  });

  RNCallKeep.addEventListener('didDisplayIncomingCall', ({callUUID, error}) => {
    if (Platform.OS !== 'android') {
      return;
    }
    androidTelemetry('callkeep_didDisplayIncomingCall', {
      hasCallUUID: !!callUUID,
      hasError: !!error,
    });
    telecomDebug('connection_service_incoming_ui_result', {
      hasCallUUID: !!callUUID,
      hasError: !!error,
      phoneAccountEnabled: lastTelecomAudit.phoneAccountEnabled,
      hasPhoneAccount: lastTelecomAudit.hasPhoneAccount,
      supportsConnectionService: lastTelecomAudit.supportsConnectionService,
      hasDefaultPhoneAccount: lastTelecomAudit.hasDefaultPhoneAccount,
    });
  });

  // Android-only CallKeep events: never register on iOS — RCTEventEmitter rejects
  // unknown event types at addListener time (before the JS callback runs).
  if (Platform.OS === 'android') {
    RNCallKeep.addEventListener('showIncomingCallUi', () => {
      telecomDebug('showIncomingCallUi_event');
    });

    RNCallKeep.addEventListener('createIncomingConnectionFailed', (event: any) => {
      telecomDebug('createIncomingConnectionFailed_event', {
        hasCallUUID: !!event?.callUUID,
        errorCode: event?.errorCode || null,
        hasError: !!event?.error,
      });
    });
  }
}

// Helper for UI: returns current loyalty_id (deprecated, use getCurrentLoyaltyId instead)
export function getCurrentUserId(): string | null {
  return currentLoyaltyId;
}

// Start outgoing call by loyalty_id (for database users)
export async function startOutgoingVoiceCallByLoyaltyId(
  targetLoyaltyId: string,
  displayName: string,
): Promise<void> {
  if (isAnotherCallInProgress()) {
    androidTelemetry('outgoing_loyalty_blocked_busy');
    return;
  }
  // Validate prerequisites
  if (!targetLoyaltyId) {
    throw new Error('Target loyaltyId is required');
  }

  if (!currentDeviceId) {
    throw new Error('Device ID (VoIP token) not available. Please wait for VoIP initialization.');
  }

  if (!currentLoyaltyId) {
    console.warn('⚠️ Current loyaltyId not set. Call will proceed but caller identification may be limited.');
  }

  // Clean up any existing call completely before starting new one
  if (activeCallUUID || incomingCallUUID || currentCallState !== 'idle') {
    console.log('🧹 Cleaning up previous call before starting new one (by loyaltyId)...');

    // End any active call in CallKeep
  if (activeCallUUID) {
      try {
    RNCallKeep.endCall(activeCallUUID);
      } catch (e) {
        console.warn('Error ending previous call in CallKeep:', e);
      }
    }
    if (incomingCallUUID) {
      try {
        RNCallKeep.endCall(incomingCallUUID);
      } catch (e) {
        console.warn('Error ending previous incoming call in CallKeep:', e);
      }
    }

    // Clean up all resources
    endVoiceCall();

    // Reset all state variables
    activeCallUUID = null;
    incomingCallUUID = null;
    currentCallState = 'idle';
    callerName = null;
    answerProcessedForCall = null;

    // Small delay to ensure cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 200));
    console.log('✅ Previous call cleaned up, ready for new call (by loyaltyId)');
  }

  // CRITICAL: Force reset ringback state before EVERY new call
  // This ensures ringback plays on 2nd, 3rd, etc. calls
  forceResetRingbackState();

  const callUUID = generateUUID();
  if (!tryAcquireCallLock(callUUID, 'outgoing-loyalty')) {
    return;
  }
  activeCallUUID = callUUID;
  currentCallState = 'calling';
  callerName = displayName;
  connectionState = 'connecting'; // Set initial connection state

  console.log('📞 Starting outgoing call:', {
    callUUID,
    targetLoyaltyId,
    displayName,
    fromDeviceId: currentDeviceId,
    fromLoyaltyId: currentLoyaltyId,
  });

  // Show outgoing call in native UI only on iOS.
  if (Platform.OS === 'ios') {
    try {
      maybeCallKeepStartCall(callUUID, targetLoyaltyId, displayName);
      console.log('CallKeep: started outgoing call UI for', callUUID, 'to', displayName);
    } catch (e) {
      console.error('Failed to start CallKeep call UI', e);
      throw e;
    }
  } else {
    console.log('Android: skipping RNCallKeep.startCall for outgoing loyalty flow');
  }

  try {
    ensureSocketConnected();
    // Start local WebRTC and create offer (this also initializes InCallManager)
    await startVoiceCall(callUUID, undefined, 'caller');
    const localDesc = pc?.localDescription;
    if (!localDesc) {
      throw new Error('Local description not set after createOffer');
    }

    // Start ringback AFTER WebRTC/InCallManager setup is complete
    if (Platform.OS === 'android') {
      try {
        maybeCallKeepStartCall(callUUID, targetLoyaltyId, displayName);
      } catch (e) {
        console.warn('Android startCall failed after WebRTC prep', e);
      }
    }
    console.log('🔔 Starting ringback for outgoing call (loyalty)...');
    await startRingback();

    // Send offer to backend with loyalty_id
    try {
      const requestBody = {
        callId: callUUID,
        toLoyaltyId: targetLoyaltyId,
        fromDeviceId: currentDeviceId,
        fromLoyaltyId: currentLoyaltyId,
        callerName: displayName,
        offer: {
          type: localDesc.type,
          sdp: localDesc.sdp,
        },
      };

      console.log('📤 Sending call request to backend:', {
        callId: callUUID,
        toLoyaltyId: targetLoyaltyId,
        fromDeviceId: currentDeviceId,
        fromLoyaltyId: currentLoyaltyId,
        offerType: localDesc.type,
        offerSdpLength: localDesc.sdp.length,
      });

      const response = await voipFetch(`${BASE_URL}/api/calls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Backend returned ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorMessage;
        } catch {
          errorMessage = errorText || errorMessage;
        }
        console.error('❌ Backend call request failed:', response.status, errorMessage);
        throw new Error(`Failed to start call: ${errorMessage}`);
      }

      const responseData = await response.json().catch(() => ({}));
      console.log('✅ Call request sent successfully:', responseData);
    } catch (networkErr: any) {
      console.error('❌ Failed to send offer to backend', networkErr);
      throw new Error(`Network error: ${networkErr.message || 'Failed to connect to server'}`);
    }
  } catch (err: any) {
    console.error('❌ Failed to start outgoing voice call', err);
    RNCallKeep.endCall(callUUID);
    activeCallUUID = null;
    endVoiceCall();
    stopRingback();
    throw err;
  }

  // Wait for answer
  try {
    await waitForAnswer(callUUID);

    if (activeCallUUID === callUUID) {
      try {
        maybeCallKeepSetCurrentCallActive(callUUID);
        console.log('CallKeep: ensured call is active after answer received', callUUID);
      } catch (e) {
        console.warn('Failed to ensure call is active in CallKeep after answer', e);
      }
    }

    void pollRemoteCandidates(callUUID, 'caller');
  } catch (e) {
    console.warn('startOutgoingVoiceCallByLoyaltyId: error while waiting for answer', e);
  }
}

// Initialize VoipService with logged-in user's loyalty_id
export function setUserLoyaltyId(loyaltyId: string) {
  currentLoyaltyId = loyaltyId;
  // Re-enable CallKeep for incoming calls (was disabled on logout)
  if (isVoipInitialized) {
    try {
      RNCallKeep.setAvailable(true);
    } catch (e) {
      console.warn('setUserLoyaltyId: Failed to set CallKeep available', e);
    }
  }

  // Re-register device with backend using loyalty_id to update voipToken in database
  if (currentDeviceId) {
    // Update backend with new loyalty_id and voipToken
    registerDeviceWithBackend(currentDeviceId, loyaltyId).catch((e) => {
      console.warn('Failed to update device registration with loyalty_id', e);
    });

    // Also register with socket immediately to show user as online
    ensureSocketConnected();
    if (socket && socket.connected) {
      socket.emit('registerDevice', {
        deviceId: currentDeviceId,
        loyaltyId: loyaltyId,
      });
      // console.log('VoipService: Registered device with socket (loyaltyId set)');
    }
  } else {
    // If no device ID yet, request token registration
    // This will trigger the 'register' event which will then register with backend
    if (Platform.OS === 'ios' && isVoipInitialized) {
      try {
        VoipPushNotification.registerVoipToken();
        // console.log('Requested VoIP token registration to update loyalty_id');
      } catch (e) {
        console.warn('Failed to request VoIP token registration', e);
      }
    } else if (Platform.OS === 'android' && isVoipInitialized) {
      messaging()
        .getToken()
        .then(token => {
          if (!token) {
            return;
          }
          currentDeviceId = token;
          return registerDeviceWithBackend(token, loyaltyId);
        })
        .catch(e => {
          console.warn('Failed to request Android FCM token', e);
        });
    }
  }
}

// Get current loyalty_id
export function getCurrentLoyaltyId(): string | null {
  // Return stored loyalty_id if set
  if (currentLoyaltyId) {
    return currentLoyaltyId;
  }
  return null;
}

// Get current VoIP token/device ID
export function getCurrentVoipToken(): string | null {
  return currentDeviceId;
}

// Get current device ID (alias for getCurrentVoipToken)
export function getCurrentDeviceId(): string | null {
  return currentDeviceId;
}

/**
 * Full cleanup on logout. Must be called before clearing auth state.
 * - Unregisters device from backend (clears voipToken so device no longer receives calls for this user)
 * - Disconnects socket and clears state (prevents reconnect with old user)
 * - Sets CallKeep unavailable
 * - Ends any active call and resets all call state
 * CRITICAL for account switching: without this, the previous user would still receive calls.
 */
export async function cleanupVoipOnLogout(): Promise<void> {
  const loyaltyIdToUnregister = currentLoyaltyId;

  // 1. Unregister device from backend FIRST - stops VoIP pushes for this user
  //    (ещё с токеном текущего пользователя — voip проверяет владельца loyaltyId)
  if (loyaltyIdToUnregister) {
    await unregisterDeviceWithBackend(loyaltyIdToUnregister);
  }
  // Токен предыдущего пользователя больше не должен уходить на voip
  setVoipAccessToken(null);

  // 2. End any active call in CallKeep and reset call state
  if (activeCallUUID) {
    try {
      RNCallKeep.endCall(activeCallUUID);
    } catch (e) {
      console.warn('cleanupVoipOnLogout: Error ending CallKeep call', e);
    }
  }
  if (incomingCallUUID) {
    try {
      RNCallKeep.endCall(incomingCallUUID);
    } catch (e) {
      console.warn('cleanupVoipOnLogout: Error ending incoming call', e);
    }
  }
  endVoiceCall();
  stopRingback();
  stopIncomingRingtone();
  activeCallUUID = null;
  incomingCallUUID = null;
  incomingOfferByCallId.clear();
  pendingAnswerCallUUID = null;
  answerProcessedForCall = null;
  currentCallState = 'idle';
  callerName = null;
  activeCallStartedAt = null;

  // 3. Clear loyaltyId/deviceId BEFORE disconnect so socket handler doesn't reconnect
  currentLoyaltyId = null;
  currentDeviceId = null;

  // 4. Disconnect socket - backend will remove device from deviceSockets
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch (e) {
      console.warn('cleanupVoipOnLogout: Error disconnecting socket', e);
    }
    socket = null;
  }

  if (fcmTokenRefreshUnsubscribe) {
    try {
      fcmTokenRefreshUnsubscribe();
    } catch (e) {
      console.warn('cleanupVoipOnLogout: Error unsubscribing FCM token listener', e);
    }
    fcmTokenRefreshUnsubscribe = null;
  }
  if (appStateSubscription) {
    try {
      appStateSubscription.remove();
    } catch (e) {
      console.warn('cleanupVoipOnLogout: Error removing AppState listener', e);
    }
    appStateSubscription = null;
  }
  stopNetworkMonitoring();
  unregisterAndroidAudioRouteObservers();
  releaseCallLock();
  isVoipInitializing = false;

  // 5. Disable CallKeep so no incoming call UI for logged-out state
  try {
    RNCallKeep.setAvailable(false);
  } catch (e) {
    console.warn('cleanupVoipOnLogout: Error setting CallKeep unavailable', e);
  }

  console.log('✅ VoipService cleanup on logout complete');
}

// Update/refresh VoIP token (useful when app is already open)
export async function updateVoipToken(): Promise<void> {
  if (!isVoipInitialized) {
    console.warn('VoIP not initialized yet. Call initVoipAndCallKeep() first.');
    return;
  }

  // First, force update backend with current token (if we have one)
  // This ensures backend is updated even if token hasn't changed
  if (currentDeviceId) {
    try {
      await registerDeviceWithBackend(currentDeviceId, currentLoyaltyId);
      console.log('✅ Device registration updated with backend');
    } catch (e) {
      console.warn('Failed to update device registration', e);
    }
  }

  // Then request new token registration (in case token changed)
  if (Platform.OS === 'ios') {
    try {
      VoipPushNotification.registerVoipToken();
      console.log('VoIP token update requested');
    } catch (e) {
      console.warn('Failed to update VoIP token', e);
    }
  } else {
    console.log('VoIP token update is only available on iOS');
  }
}

// Helper for UI: returns whether a call is active and when it started
export function getActiveCallInfo(): {isActive: boolean; startedAt: number | null} {
  return {
    isActive: !!activeCallUUID && !!activeCallStartedAt,
    startedAt: activeCallStartedAt,
  };
}

// Set speaker mode: 'earpiece' (front) or 'loudspeaker' (back)
export function setSpeakerMode(mode: SpeakerMode): void {
  const isLoudspeaker = mode === 'loudspeaker';

  if (!pc) {
    const uuid = activeCallUUID || incomingCallUUID;
    const preConnect =
      (currentCallState === 'ringing' || currentCallState === 'calling') && !!uuid;

    if (preConnect) {
      currentSpeakerMode = mode;
      isSpeakerEnabled = isLoudspeaker;
      try {
        InCallManager.setSpeakerphoneOn(isLoudspeaker);
      } catch (e) {
        console.warn('setSpeakerMode (pre-WebRTC): InCallManager failed', e);
      }
      if (Platform.OS === 'android' && (RNCallKeep as any).setSpeakerPhoneOn) {
        try {
          (RNCallKeep as any).setSpeakerPhoneOn(uuid, isLoudspeaker);
        } catch (e) {
          console.warn('setSpeakerMode (pre-WebRTC): CallKeep failed', e);
        }
      }
      androidTelemetry('audio_route_manual', {mode});
    } else {
      console.warn('No active call - cannot set speaker mode');
    }
    return;
  }

  currentSpeakerMode = mode;
  isSpeakerEnabled = isLoudspeaker;

  try {
    // Use InCallManager for proper audio routing (works on both iOS and Android)
    InCallManager.setSpeakerphoneOn(isLoudspeaker);
    console.log(`✅ InCallManager: Speaker set to ${mode}`);

    // Also sync with CallKeep for Android
    if (Platform.OS === 'android' && (RNCallKeep as any).setSpeakerPhoneOn) {
      (RNCallKeep as any).setSpeakerPhoneOn(activeCallUUID || '', isLoudspeaker);
      console.log(`✅ CallKeep: Speaker phone set to ${mode}`);
    }

    // Configure remote audio tracks for speaker output
    if (remoteStream) {
      remoteStream.getAudioTracks().forEach((track: any) => {
        try {
          // React Native WebRTC: Enable/disable speaker output
          if (track._setSpeakerEnabled && typeof track._setSpeakerEnabled === 'function') {
            track._setSpeakerEnabled(isLoudspeaker);
            console.log(`Speaker mode set to ${mode} for remote track`);
          }
          // Also ensure track is enabled
          if (track.setEnabled) {
            track.setEnabled(true);
          }
        } catch (e) {
          console.warn('Failed to configure remote track for speaker mode', e);
        }
      });
    }
    androidTelemetry('audio_route_manual', {mode});

    // Configure local audio tracks as well (for echo cancellation and routing)
    if (localStream) {
      localStream.getAudioTracks().forEach((track: any) => {
        try {
          if (track._setSpeakerEnabled && typeof track._setSpeakerEnabled === 'function') {
            track._setSpeakerEnabled(isLoudspeaker);
            console.log(`Speaker mode set to ${mode} for local track`);
          }
        } catch (e) {
          console.warn('Failed to configure local track for speaker mode', e);
        }
      });
    }

    // For iOS, also try WebRTC's audio routing as fallback
    if (Platform.OS === 'ios' && pc) {
      try {
        // Method 1: Try WebRTC's switchAudioOutput if available
        if ((pc as any).switchAudioOutput && typeof (pc as any).switchAudioOutput === 'function') {
          (pc as any).switchAudioOutput(isLoudspeaker ? 'speaker' : 'earpiece');
          console.log(`✅ iOS: Audio output switched to ${mode} via WebRTC switchAudioOutput`);
        }
        // Method 2: Try using mediaDevices.setAudioOutput
        else if (mediaDevices && (mediaDevices as any).setAudioOutput && typeof (mediaDevices as any).setAudioOutput === 'function') {
          (mediaDevices as any).setAudioOutput(isLoudspeaker ? 'speaker' : 'earpiece');
          console.log(`✅ iOS: Audio output switched to ${mode} via mediaDevices.setAudioOutput`);
        }
      } catch (e) {
        console.warn('⚠️ Failed to set iOS audio route via WebRTC (InCallManager should handle it)', e);
      }
    }

    console.log(`✅ Speaker mode set to: ${mode} (${isLoudspeaker ? 'loudspeaker' : 'earpiece'})`);
  } catch (e) {
    console.error('❌ Failed to set speaker mode', e);
  }
}

// Toggle between earpiece and loudspeaker
export function toggleSpeakerMode(): SpeakerMode {
  const now = Date.now();
  if (now - lastSpeakerToggleMs < SPEAKER_TOGGLE_DEBOUNCE_MS) {
    return currentSpeakerMode;
  }
  lastSpeakerToggleMs = now;

  const newMode = currentSpeakerMode === 'earpiece' ? 'loudspeaker' : 'earpiece';
  setSpeakerMode(newMode);
  return newMode;
}

// Set to earpiece (front speaker)
export function setEarpiece(): void {
  setSpeakerMode('earpiece');
}

// Set to loudspeaker (back speaker)
export function setLoudspeaker(): void {
  setSpeakerMode('loudspeaker');
}

// Legacy functions for backward compatibility
export function toggleSpeaker(enabled: boolean): void {
  setSpeakerMode(enabled ? 'loudspeaker' : 'earpiece');
}

export function enableSpeaker(): void {
  setLoudspeaker();
}

export function disableSpeaker(): void {
  setEarpiece();
}

// Get current call state for UI
export function getCallState(): {
  state: CallState;
  callerName: string | null;
  isMuted: boolean;
  isSpeakerEnabled: boolean;
  speakerMode: SpeakerMode;
  callUUID: string | null;
  connectionState: ConnectionState | null;
} {
  return {
    state: currentCallState,
    callerName,
    isMuted,
    isSpeakerEnabled,
    speakerMode: currentSpeakerMode,
    callUUID: activeCallUUID || incomingCallUUID, // Include incoming call UUID
    connectionState,
  };
}

// Get WebRTC connection status for UI display
export function getConnectionStatus(): {
  connectionState: string | null;
  iceConnectionState: string | null;
  isConnecting: boolean;
  isConnected: boolean;
} {
  if (!pc) {
    return {
      connectionState: null,
      iceConnectionState: null,
      isConnecting: false,
      isConnected: false,
    };
  }

  const connectionState = (pc as any).connectionState || 'unknown';
  const iceConnectionState = (pc as any).iceConnectionState || 'unknown';
  const signalingState = (pc as any).signalingState || 'unknown';

  // Determine if we're in a connecting state
  // Include 'checking' and 'new' states for both connection and ICE
  const isConnecting =
    connectionState === 'connecting' ||
    connectionState === 'new' ||
    iceConnectionState === 'checking' ||
    iceConnectionState === 'new' ||
    (connectionState !== 'connected' && connectionState !== 'disconnected' && connectionState !== 'failed' && connectionState !== 'closed' && iceConnectionState !== 'connected' && iceConnectionState !== 'completed' && iceConnectionState !== 'failed' && iceConnectionState !== 'closed');

  // Determine if we're fully connected
  // Consider connected if either connectionState OR iceConnectionState indicates connection
  // This is more lenient to catch connection even if one state hasn't updated yet
  const isConnected =
    (connectionState === 'connected' || connectionState === 'completed') &&
    (iceConnectionState === 'connected' || iceConnectionState === 'completed');

  // Debug logging (only log occasionally to avoid spam)
  if (Math.random() < 0.1) { // Log 10% of the time
    console.log('📊 Connection Status:', {
      connectionState,
      iceConnectionState,
      signalingState,
      isConnecting,
      isConnected,
    });
  }

  return {
    connectionState,
    iceConnectionState,
    isConnecting,
    isConnected,
  };
}

function pushNativeConnectionStatus(): void {
  if (Platform.OS !== 'android') {
    return;
  }
  const callId = activeCallUUID || incomingCallUUID;
  if (!callId) {
    return;
  }
  const status = getConnectionStatus();
  const isIncoming = currentCallState === 'ringing';
  const isOutgoing = currentCallState === 'calling';
  nativeUpdateConnectionStatus(
    callId,
    status.connectionState,
    status.iceConnectionState,
    status.isConnecting,
    status.isConnected,
    isIncoming,
    isOutgoing,
  ).catch(e => {
    if (Math.random() < 0.05) {
      console.warn('Failed to push native connection status', e);
    }
  });
}

function ensureNativeConnectionStatusSync(): void {
  if (Platform.OS !== 'android') {
    return;
  }
  if (nativeConnectionStatusInterval) {
    return;
  }
  nativeConnectionStatusInterval = setInterval(() => {
    const hasCall = !!(activeCallUUID || incomingCallUUID);
    if (!hasCall || currentCallState === 'idle' || currentCallState === 'ended' || currentCallState === 'rejected') {
      stopNativeConnectionStatusSync();
      return;
    }
    pushNativeConnectionStatus();
  }, 1000);
  pushNativeConnectionStatus();
}

function stopNativeConnectionStatusSync(): void {
  if (nativeConnectionStatusInterval) {
    clearInterval(nativeConnectionStatusInterval);
    nativeConnectionStatusInterval = null;
  }
}

// Get network/internet status for UI display
export async function getNetworkStatus(): Promise<{
  isConnected: boolean;
  type: string;
  isInternetReachable: boolean | null;
}> {
  try {
    const state = await NetInfo.fetch();
    return {
      isConnected: state.isConnected ?? false,
      type: state.type,
      isInternetReachable: state.isInternetReachable ?? null,
    };
  } catch (e) {
    console.error('Failed to get network status:', e);
    return {
      isConnected: false,
      type: 'unknown',
      isInternetReachable: false,
    };
  }
}

// Get current network status (synchronous, uses last known state)
export function getCurrentNetworkStatus(): {
  isConnected: boolean;
  type: string;
  isInternetReachable: boolean | null;
} {
  if (lastNetworkState) {
    return {
      isConnected: lastNetworkState.isConnected ?? false,
      type: lastNetworkState.type,
      isInternetReachable: lastNetworkState.isInternetReachable ?? null,
    };
  }
  return {
    isConnected: false,
    type: 'unknown',
    isInternetReachable: false,
  };
}

function canUseCallAudioWithoutPc(): boolean {
  const uuid = activeCallUUID || incomingCallUUID;
  return (
    !!uuid &&
    (currentCallState === 'ringing' || currentCallState === 'calling')
  );
}

// Mute/unmute microphone
export function toggleMute(): boolean {
  if (!pc) {
    if (canUseCallAudioWithoutPc()) {
      isMuted = !isMuted;
      const uuid = activeCallUUID || incomingCallUUID;
      try {
        InCallManager.setMicrophoneMute(isMuted);
      } catch (e) {
        console.warn('toggleMute (pre-WebRTC): InCallManager failed', e);
      }
      if (uuid) {
        try {
          RNCallKeep.setMutedCall(uuid, isMuted);
        } catch (e) {
          console.warn('toggleMute (pre-WebRTC): CallKeep failed', e);
        }
      }
      return isMuted;
    }
    console.warn('toggleMute: No active call (no peer connection) - cannot toggle mute');
    return isMuted;
  }

  const previousMutedState = isMuted;
  isMuted = !isMuted;
  let trackFound = false;
  let tracksUpdated = 0;

  try {
    // Use InCallManager to set mute state (works on both iOS and Android)
    InCallManager.setMicrophoneMute(isMuted);
    console.log(`✅ InCallManager: Microphone mute set to ${isMuted}`);

    // Sync with CallKeep (for UI consistency)
    if (activeCallUUID) {
      try {
        RNCallKeep.setMutedCall(activeCallUUID, isMuted);
        console.log(`✅ CallKeep: Mute state synced to ${isMuted}`);
      } catch (e) {
        console.warn('⚠️ Failed to sync mute state with CallKeep:', e);
      }
    }

    // First, try to get tracks from localStream
    if (localStream) {
      const tracks = localStream.getAudioTracks();
      if (tracks.length > 0) {
        tracks.forEach(track => {
          try {
            track.enabled = !isMuted;
            tracksUpdated++;
            trackFound = true;
            console.log(`toggleMute: Updated track ${track.id} via localStream, enabled: ${!isMuted}`);
          } catch (trackError) {
            console.warn('toggleMute: Error updating track from localStream:', trackError);
          }
        });
      } else {
        console.warn('toggleMute: localStream exists but has no audio tracks');
      }
    } else {
      console.log('toggleMute: localStream is null, trying peer connection senders');
    }

    // If no tracks found in localStream, try to get them from peer connection senders
    if (!trackFound && pc) {
      try {
        const senders = pc.getSenders();
        console.log(`toggleMute: Found ${senders.length} senders in peer connection`);
        senders.forEach((sender, index) => {
          if (sender.track) {
            console.log(`toggleMute: Sender ${index} has track: kind=${sender.track.kind}, id=${sender.track.id}, enabled=${sender.track.enabled}`);
            if (sender.track.kind === 'audio') {
              try {
                sender.track.enabled = !isMuted;
                tracksUpdated++;
                trackFound = true;
                console.log(`toggleMute: Updated sender track ${sender.track.id}, enabled: ${!isMuted}`);
              } catch (trackError) {
                console.warn('toggleMute: Error updating sender track:', trackError);
              }
            }
          } else {
            console.log(`toggleMute: Sender ${index} has no track`);
          }
        });
      } catch (senderError) {
        console.error('toggleMute: Error accessing peer connection senders:', senderError);
      }
    }

    if (!trackFound) {
      console.warn('toggleMute: No audio tracks found to mute/unmute - reverting state');
      // Revert the state change since we couldn't apply it
      isMuted = previousMutedState;
      InCallManager.setMicrophoneMute(isMuted); // Revert InCallManager too
      return isMuted;
    }

    console.log(`toggleMute: ✅ Successfully toggled mute. New state: ${isMuted}, ${tracksUpdated} track(s) updated`);
    return isMuted;
  } catch (e) {
    console.error('toggleMute: Failed to toggle mute', e);
    // Revert the state change on error
    isMuted = previousMutedState;
    InCallManager.setMicrophoneMute(isMuted); // Revert InCallManager too
    return isMuted;
  }
}

// Set mute state
export function setMute(muted: boolean): void {
  if (!pc) {
    if (canUseCallAudioWithoutPc()) {
      if (isMuted === muted) {
        return;
      }
      isMuted = muted;
      try {
        InCallManager.setMicrophoneMute(isMuted);
      } catch (e) {
        console.warn('setMute (pre-WebRTC): InCallManager failed', e);
      }
      const uuid = activeCallUUID || incomingCallUUID;
      if (uuid) {
        try {
          RNCallKeep.setMutedCall(uuid, isMuted);
        } catch (e) {
          console.warn('setMute (pre-WebRTC): CallKeep failed', e);
        }
      }
      return;
    }
    console.warn('setMute: No active call (no peer connection) - cannot set mute');
    return;
  }

  // If state is already what we want, no need to change
  if (isMuted === muted) {
    console.log(`setMute: Already in desired state (${muted ? 'muted' : 'unmuted'})`);
    return;
  }

  try {
    isMuted = muted;
    let trackFound = false;
    let tracksUpdated = 0;

    // First, try to get tracks from localStream
    if (localStream) {
      const tracks = localStream.getAudioTracks();
      if (tracks.length > 0) {
        tracks.forEach(track => {
          try {
            track.enabled = !isMuted;
            tracksUpdated++;
            trackFound = true;
            console.log(`setMute: Updated track ${track.id} via localStream, enabled: ${!isMuted}`);
          } catch (trackError) {
            console.warn('setMute: Error updating track from localStream:', trackError);
          }
        });
      } else {
        console.warn('setMute: localStream exists but has no audio tracks');
      }
    } else {
      console.log('setMute: localStream is null, trying peer connection senders');
    }

    // If no tracks found in localStream, try to get them from peer connection senders
    if (!trackFound && pc) {
      try {
        const senders = pc.getSenders();
        console.log(`setMute: Found ${senders.length} senders in peer connection`);
        senders.forEach((sender, index) => {
          if (sender.track) {
            console.log(`setMute: Sender ${index} has track: kind=${sender.track.kind}, id=${sender.track.id}, enabled=${sender.track.enabled}`);
            if (sender.track.kind === 'audio') {
              try {
                sender.track.enabled = !isMuted;
                tracksUpdated++;
                trackFound = true;
                console.log(`setMute: Updated sender track ${sender.track.id}, enabled: ${!isMuted}`);
              } catch (trackError) {
                console.warn('setMute: Error updating sender track:', trackError);
              }
            }
          } else {
            console.log(`setMute: Sender ${index} has no track`);
          }
        });
      } catch (senderError) {
        console.error('setMute: Error accessing peer connection senders:', senderError);
      }
    }

    if (!trackFound) {
      console.warn('setMute: No audio tracks found to set mute state - reverting');
      // Revert the state change since we couldn't apply it
      isMuted = !muted;
      return;
    }

    console.log(`setMute: ✅ Successfully set mute to ${muted}. ${tracksUpdated} track(s) updated`);
  } catch (e) {
    console.error('setMute: Failed to set mute', e);
    // Revert the state change on error
    isMuted = !muted;
  }
}

// Answer incoming call (programmatically trigger answer logic)
// Process pending answer when app opens after answering from CallKeep
// Shared function to handle answering a call (used by both CallKeep event and programmatic calls)
async function handleAnswerCall(callUUID: string): Promise<void> {
  if (!answerGate.begin(callUUID)) {
    console.log('📞 Answer already running or done for call, skip duplicate:', callUUID);
    return;
  }
  clearStaleCallStateFor(callUUID);
  try {
    await handleAnswerCallOnce(callUUID);
    answerGate.finish(callUUID, true);
  } catch (e) {
    answerGate.finish(callUUID, false);
    throw e;
  }
}

async function handleAnswerCallOnce(callUUID: string): Promise<void> {
  if (!tryAcquireCallLock(callUUID, 'handleAnswerCall')) {
    throw new Error('Another call transition is already in progress');
  }
  if (isAnotherCallInProgress(callUUID)) {
    throw new Error('Another call is already in progress');
  }
  console.log('📞 Handling answer call - callUUID:', callUUID);

  // CRITICAL: Set state IMMEDIATELY and SYNCHRONOUSLY before any async operations
  // This ensures the modal updates instantly when user answers
  activeCallUUID = callUUID;
  incomingCallUUID = null; // Clear incoming call UUID
  currentCallState = 'answered';
  console.log('📞 ✅ Call state set to answered IMMEDIATELY for callUUID:', callUUID);

  // Stop incoming ringtone when user answers
  stopIncomingRingtone();

  // Wait for app to initialize if it was just opened
  // This ensures WebRTC and other services are ready
  await new Promise(resolve => setTimeout(resolve, 500));

  // Re-confirm state after delay (in case something tried to change it)
  if (currentCallState !== 'answered' || activeCallUUID !== callUUID) {
    activeCallUUID = callUUID;
    incomingCallUUID = null;
    currentCallState = 'answered';
    console.log('📞 Re-confirmed call state as answered after delay');
  }

  try {
    // If we have a local-offer peer while answering incoming call, it cannot be reused as callee.
    // Reset and create a fresh callee peer connection to avoid answer/connection deadlocks.
    if (pc && (pc as any).signalingState === 'have-local-offer') {
      console.warn(
        '📞 Existing peer is in have-local-offer during incoming answer, resetting peer connection',
      );
      endVoiceCall();
      pc = null;
    }

    // If this is an outgoing call, we already created the offer in startOutgoingVoiceCall
    // and are waiting for answer via waitForAnswer on the other side.
    if (!pc) {
      // Incoming call case: prefer cached offer from push/socket to avoid backend timing races.
      let remoteOffer = incomingOfferByCallId.get(callUUID);
      if (!remoteOffer?.sdp) {
        console.log('📞 Fetching call offer from backend for callUUID:', callUUID);
        remoteOffer = await fetchRemoteOfferWithRetry(callUUID);
      }

      // Re-confirm state before starting WebRTC (state should already be 'answered' from above)
      if (currentCallState !== 'answered' || activeCallUUID !== callUUID) {
        activeCallUUID = callUUID;
        incomingCallUUID = null;
        currentCallState = 'answered';
        console.log('📞 Re-confirmed call state as answered before WebRTC setup');
      }

      console.log('📞 Starting WebRTC voice call for incoming call:', callUUID);
      await startVoiceCall(callUUID, remoteOffer, 'callee');
      console.log('✅ WebRTC voice call started for incoming call', callUUID);

      // CRITICAL: Ensure state is still 'answered' after WebRTC setup
      // This is a defensive check in case startVoiceCall or any async operation changed it
      if (currentCallState !== 'answered' || activeCallUUID !== callUUID) {
        activeCallUUID = callUUID;
        incomingCallUUID = null;
        currentCallState = 'answered';
        console.log('📞 ⚠️ Re-confirmed call state as answered after WebRTC setup (state was changed!)');
      } else {
        console.log('📞 ✅ Call state confirmed as answered after WebRTC setup');
      }

      // IMPORTANT: Send our answer SDP back to backend so caller can apply it
      // This must be done after creating the answer in startVoiceCall
      // startVoiceCall already waits for ICE gathering, so local description should be ready
      console.log('📤 Preparing to send answer to backend for call:', callUUID);

      // Wait a moment to ensure local description is fully set (defensive)
      await new Promise(resolve => setTimeout(resolve, 100));

      const currentPc = pc;
      if (!currentPc) {
        console.error('❌ Cannot send answer - peer connection is null!');
        throw new Error('Peer connection is null after startVoiceCall');
      }

      const localDesc = (currentPc as any).localDescription;
      if (!localDesc) {
        console.error('❌ Cannot send answer - local description not set!');
        console.error('   Signaling state:', (currentPc as any).signalingState);
        console.error('   Connection state:', (currentPc as any).connectionState);
        console.error('   ICE gathering state:', (currentPc as any).iceGatheringState);
        throw new Error('Local description not set after creating answer');
      }

      console.log('📤 Sending answer to backend for call:', callUUID);
      console.log('   Answer type:', localDesc.type);
      console.log('   Answer SDP length:', localDesc.sdp?.length || 0);
      console.log('   Signaling state:', (currentPc as any).signalingState);
      console.log('   ICE gathering state:', (currentPc as any).iceGatheringState);

      try {
        await sendAnswerToBackend(callUUID);
        startMediaWatchdog(callUUID, 'callee');
        console.log('✅ Answer sent to backend for call:', callUUID);
      } catch (e) {
        console.error('❌ Failed to send answer to backend:', e);
        // without an accepted answer there is no call — end it (catch below ends CallKit)
        throw e;
      }

      // Backend will automatically notify caller via socket when answer is received
      // But we also send call-state event to ensure real-time notification
      ensureSocketConnected();
      if (socket && socket.connected) {
        try {
          socket.emit('call-state', {
            callId: callUUID,
            callUUID: callUUID, // Include both for compatibility
            state: 'answered',
            direction: 'incoming',
          });
          console.log('✅ Answer state sent via socket for call:', callUUID);
        } catch (e) {
          console.warn('⚠️ Failed to send answer state via socket', e);
        }
      } else {
        console.warn('⚠️ Socket not connected, cannot send answer state');
      }

      // And poll for remote ICE candidates coming from caller
      void pollRemoteCandidates(callUUID, 'callee');

      // Start timer immediately when callee answers (incoming call)
      activeCallStartedAt = Date.now();
      try {
        // Mark call as active in CallKeep so the native timer starts
        maybeCallKeepSetCurrentCallActive(callUUID);
        console.log('✅ CallKeep: started timer for incoming call', callUUID);
      } catch (e) {
        console.warn('⚠️ Failed to set call as active in CallKeep for incoming call', e);
      }
    } else {
      console.log('📞 WebRTC peer connection already active for call', callUUID);
      console.log('   This is an incoming call that was answered - peer connection was created when offer was received');

      // For incoming calls, we need to create and send the answer
      // Check if we already have a local description (answer was already created)
      const currentPc = pc;
      if (currentPc) {
        const localDesc = (currentPc as any).localDescription;
        if (!localDesc) {
          // No local description means answer wasn't created yet
          // This shouldn't happen for incoming calls, but handle it
          console.warn('⚠️ Peer connection exists but no local description - answer might not have been created');
          console.warn('   Signaling state:', (currentPc as any).signalingState);
          console.warn('   Remote description exists:', !!(currentPc as any).remoteDescription);

          // Try to create answer if we have remote description
          if ((currentPc as any).remoteDescription) {
            try {
              console.log('📞 Creating answer for existing peer connection...');
              const answer = await currentPc.createAnswer();
              await currentPc.setLocalDescription(answer);
              console.log('✅ Answer created and set for existing peer connection');

              // Wait a bit for ICE gathering
              await new Promise(resolve => setTimeout(resolve, 500));

              // Now send the answer
              await sendAnswerToBackend(callUUID);
              startMediaWatchdog(callUUID, 'callee');
              console.log('✅ Answer sent to backend for existing peer connection');
            } catch (createError) {
              console.error('❌ Failed to create answer for existing peer connection:', createError);
            }
          }
        } else {
          // Local description exists - answer was already created
          console.log('✅ Answer already exists for peer connection, sending to backend...');
          try {
            await sendAnswerToBackend(callUUID);
            startMediaWatchdog(callUUID, 'callee');
            console.log('✅ Answer sent to backend for existing peer connection');
          } catch (sendError) {
            console.error('❌ Failed to send existing answer to backend:', sendError);
          }
        }
      }

      // CRITICAL: Ensure state is set to answered and UUIDs are correct
      if (currentCallState !== 'answered' || activeCallUUID !== callUUID) {
        activeCallUUID = callUUID;
        incomingCallUUID = null;
        currentCallState = 'answered';
        console.log('📞 ⚠️ Re-confirmed call state as answered for outgoing call (state was changed!)');
      } else {
        console.log('📞 ✅ Call state confirmed as answered for outgoing call');
      }
      activeCallStartedAt = Date.now();
      try {
        maybeCallKeepSetCurrentCallActive(callUUID);
        console.log('✅ CallKeep: started timer for outgoing call', callUUID);
      } catch (e) {
        console.warn('⚠️ Failed to set call as active in CallKeep for outgoing call', e);
      }
    }
  } catch (e) {
    console.error('❌ Failed to start WebRTC call on answer:', e);
    try {
      RNCallKeep.endCall(callUUID);
    } catch (endError) {
      console.warn('⚠️ Failed to end CallKeep call:', endError);
    }
    activeCallUUID = null;
    endVoiceCall();
    stopRingback();
    stopIncomingRingtone();
    activeCallStartedAt = null;
    currentCallState = 'ended';
    throw e;
  }
}

async function processPendingAnswer(callUUID: string): Promise<void> {
  if (!answerGate.begin(callUUID)) {
    console.log('processPendingAnswer: already running or done, skip duplicate:', callUUID);
    return;
  }
  if (pendingAnswerCallUUID === callUUID) {
    pendingAnswerCallUUID = null;
  }
  clearStaleCallStateFor(callUUID);
  try {
    await processPendingAnswerOnce(callUUID);
    answerGate.finish(callUUID, true);
  } catch (e) {
    answerGate.finish(callUUID, false);
    // Do not leave a frozen "answered" screen: end the call the same way handleAnswerCall does.
    try {
      RNCallKeep.endCall(callUUID);
    } catch (endError) {
      console.warn('⚠️ Failed to end CallKeep call:', endError);
    }
    if (activeCallUUID === callUUID) {
      activeCallUUID = null;
    }
    endVoiceCall();
    stopRingback();
    stopIncomingRingtone();
    activeCallStartedAt = null;
    currentCallState = 'ended';
    throw e;
  }
}

async function processPendingAnswerOnce(callUUID: string): Promise<void> {
  if (!tryAcquireCallLock(callUUID, 'processPendingAnswer')) {
    throw new Error('Another call transition is already in progress');
  }
  if (isAnotherCallInProgress(callUUID)) {
    throw new Error('Another call is already in progress');
  }
  console.log('processPendingAnswer: Starting connection setup for call:', callUUID);

  // CRITICAL: Set state IMMEDIATELY so modal shows active call screen
  activeCallUUID = callUUID;
  incomingCallUUID = null;
  currentCallState = 'answered';
  console.log('processPendingAnswer: ✅ Call state set to answered immediately for callUUID:', callUUID);

  // Cold start: answer and ICE candidates are sent with currentDeviceId, which on iOS
  // appears only after the VoIP token event. Wait for it (up to ~6 s), then continue.
  let deviceWait = 0;
  while (!currentDeviceId && deviceWait < 30) {
    await new Promise(resolve => setTimeout(resolve, 200));
    deviceWait++;
  }
  if (!currentDeviceId) {
    console.warn('processPendingAnswer: device token not ready, continuing without it');
  }

  // Ensure socket is connected
  ensureSocketConnected();

  // Wait for socket to connect if needed (critical for real-time signaling)
  console.log('processPendingAnswer: Ensuring socket connection...');
  let attempts = 0;
  while (!socket?.connected && attempts < 15) {
    ensureSocketConnected();
    await new Promise(resolve => setTimeout(resolve, 300));
    attempts++;
    if (socket?.connected) {
      // console.log('processPendingAnswer: ✅ Socket connected after', attempts, 'attempts');
      break;
    }
  }

  if (!socket?.connected) {
    console.warn('processPendingAnswer: ⚠️ Socket not connected after waiting, continuing anyway (will use HTTP polling)');
  } else {
    console.log('processPendingAnswer: ✅ Socket is connected and ready');
  }

  try {
    // State is already set above, but ensure it's still 'answered'
    if (currentCallState !== 'answered') {
      currentCallState = 'answered';
      console.log('processPendingAnswer: Re-confirmed call state as answered');
    }

    // Prefer cached offer from push to avoid backend fetch race during background answer.
      let remoteOffer = incomingOfferByCallId.get(callUUID);
    if (!remoteOffer?.sdp) {
      console.log('processPendingAnswer: Fetching call offer from backend for callUUID:', callUUID);
      remoteOffer = await fetchRemoteOfferWithRetry(callUUID);
    }

    console.log('processPendingAnswer: Offer fetched, starting WebRTC call...');

    // Start WebRTC call with remote offer
    await startVoiceCall(callUUID, remoteOffer, 'callee');
    console.log('processPendingAnswer: WebRTC voice call started');

    // Ensure state is still 'answered' after WebRTC setup
    if (currentCallState !== 'answered') {
      currentCallState = 'answered';
      console.log('processPendingAnswer: Re-confirmed call state as answered after WebRTC setup');
    }

    // Send our answer SDP back to backend
    console.log('processPendingAnswer: Sending answer to backend...');
    await sendAnswerToBackend(callUUID);
    startMediaWatchdog(callUUID, 'callee');
    console.log('processPendingAnswer: Answer sent to backend');

    // Poll for remote ICE candidates
    void pollRemoteCandidates(callUUID, 'callee');

    // Start timer
    activeCallStartedAt = Date.now();

    // Mark call as active in CallKeep
    try {
      maybeCallKeepSetCurrentCallActive(callUUID);
      console.log('processPendingAnswer: ✅ Call marked as active in CallKeep');
    } catch (e) {
      console.warn('processPendingAnswer: Failed to set call as active in CallKeep', e);
    }

    // Final state confirmation
    if (currentCallState !== 'answered') {
      currentCallState = 'answered';
      console.log('processPendingAnswer: Final state confirmation as answered');
    }

    console.log('processPendingAnswer: ✅ Connection setup completed successfully');
  } catch (e) {
    console.error('processPendingAnswer: ❌ Failed to setup connection:', e);
    throw e;
  }
}

export async function answerCall(callUUID: string): Promise<void> {
  console.log('📞 Answering call programmatically from CallModal - callUUID:', callUUID);

  // Validate callUUID
  if (!callUUID) {
    console.error('❌ Cannot answer call - callUUID is null or undefined');
    throw new Error('Call UUID is required to answer call');
  }

  // Use incomingCallUUID if callUUID doesn't match (in case of mismatch)
  const actualCallUUID = incomingCallUUID || callUUID;
  console.log('   Using callUUID:', actualCallUUID);

  // Prevent infinite loop if answerCall event fires
  if (isAnsweringProgrammatically) {
    console.log('⚠️ Already answering programmatically, ignoring duplicate call');
    return;
  }

  isAnsweringProgrammatically = true;

  try {
    if (Platform.OS === 'android') {
      await startAndroidCallForegroundService(actualCallUUID, 'Active call');
      activateAndroidAudioSession('answerCall-modal');
      const hasPermissions = await requestAndroidCallPermissions();
      if (!hasPermissions) {
        // Avoid failing/ending accepted call in killed/background flow.
        // Continue and let connection proceed if possible.
        console.warn(
          'Android answerCall: RECORD_AUDIO permission not granted, continuing best-effort',
        );
      }
    }

    // STEP 1: Call answerIncomingCall() FIRST - This notifies CallKeep that we're answering
    // This programmatically answers the incoming call displayed via displayIncomingCall()
    // It should hide the push notification and mark the call as answered in CallKeep
    try {
      maybeCallKeepAnswerIncomingCall(actualCallUUID);
      console.log('✅ CallKeep: answerIncomingCall() called - call answered in CallKeep');
    } catch (e) {
      console.error('❌ Failed to call answerIncomingCall:', e);
      // Continue anyway - might work on some platforms
    }

    // STEP 2: Follow EXACT same flow as CallKeep's answerCall event handler
    // This ensures identical behavior between CallModal and CallKeep

    // Set state immediately (same as CallKeep answer event)
    // This ensures modal shows active call screen instantly
    activeCallUUID = actualCallUUID;
    incomingCallUUID = null;
    currentCallState = 'answered';
    lastAcceptedCallUUID = actualCallUUID;
    lastAcceptedAtMs = Date.now();
    console.log('✅ Call state set to answered immediately for callUUID:', actualCallUUID);
    ensureNativeConnectionStatusSync();
    pushNativeConnectionStatus();

    // Stop incoming ringtone when user answers (same as CallKeep answer)
    stopIncomingRingtone();

    // For Android, also call setCurrentCallActive() to ensure ConnectionService is updated
    if (Platform.OS === 'android') {
      try {
        maybeCallKeepSetCurrentCallActive(actualCallUUID);
        console.log('✅ CallKeep: setCurrentCallActive() called (Android)');
      } catch (e) {
        console.warn('⚠️ Failed to set call as active on Android:', e);
      }
    }

    // If VoIP is not yet initialized (app was closed), store the answer for later
    if (!isVoipInitialized) {
      console.log('⚠️ VoIP not initialized yet, storing pending answer for call:', actualCallUUID);
      pendingAnswerCallUUID = actualCallUUID;
      // State is already set above, so modal will show correctly
      // The answer will be processed when initVoipAndCallKeep is called
      isAnsweringProgrammatically = false;
      return;
    }

    // Use the shared answer handler function (same as CallKeep)
    try {
      await handleAnswerCall(actualCallUUID);
      console.log('✅ Call answered successfully from CallModal (same function as CallKeep)');
    } catch (e) {
      console.error('❌ Failed to handle answer call from CallModal:', e);
      // Error handling is already done in handleAnswerCall
      throw e;
    }

  } catch (e) {
    console.error('❌ Failed to answer call from CallModal:', e);
    // Reset state on error
    if (activeCallUUID === actualCallUUID) {
      activeCallUUID = null;
      currentCallState = 'idle';
      try {
        RNCallKeep.endCall(actualCallUUID);
      } catch (endError) {
        console.warn('Failed to end call in CallKeep on error:', endError);
      }
    }
    throw e;
  } finally {
    isAnsweringProgrammatically = false;
  }
}

// Reject incoming call
export function rejectCall(callUUID: string): void {
  try {
    androidTelemetry('callkeep_reject', {});
    console.log('📞 Rejecting call:', callUUID);

    // Update state immediately
    currentCallState = 'rejected';

    // Reset all call states and cleanup
    if (activeCallUUID === callUUID) {
      activeCallUUID = null;
    }
    if (incomingCallUUID === callUUID) {
      incomingCallUUID = null;
    }
    incomingOfferByCallId.delete(callUUID);
    activeCallStartedAt = null;
    callerName = null;

    // Reset microphone and speaker states
    isMuted = false;
    isSpeakerEnabled = false;
    currentSpeakerMode = 'earpiece';
    console.log('rejectCall: ✅ Reset microphone (unmuted) and speaker states');

    // Clean up media tracks
    endVoiceCall();
    stopIncomingRingtone();

    // End call in CallKeep (this dismisses the native call UI)
    try {
      RNCallKeep.endCall(callUUID);
      console.log('✅ CallKeep: ended call for rejection');
    } catch (e) {
      console.warn('⚠️ Failed to end call in CallKeep:', e);
    }

    // Inform backend that call was rejected (not just ended)
    if (currentDeviceId) {
      voipFetch(`${BASE_URL}/api/calls/${callUUID}/reject`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({deviceId: currentDeviceId}),
      })
        .then(() => {
          console.log('✅ Backend notified about call rejection');
        })
        .catch(e => {
          console.error('❌ Failed to notify backend about call rejection:', e);
        });
    } else {
      console.warn('⚠️ Cannot notify backend - currentDeviceId not set');
    }

    console.log('✅ Call rejected successfully:', callUUID);

    // Reset call state to idle after delay (so modal can show "rejected" state briefly)
    setTimeout(() => {
      if (currentCallState === 'rejected') {
        currentCallState = 'idle';
        stopNativeConnectionStatusSync();
        console.log('Call state reset to idle after rejection');
      }
    }, 3000);
  } catch (e) {
    console.error('❌ Failed to reject call:', e);
    // Try to clean up even if there was an error
    try {
      RNCallKeep.endCall(callUUID);
    } catch (endError) {
      console.warn('⚠️ Failed to end call in CallKeep after error:', endError);
    }
    endVoiceCall();
    stopIncomingRingtone();
  }
}

// Test function to verify ringback - CAN BE CALLED MULTIPLE TIMES
export async function testRingback(): Promise<void> {
  console.log('🔔 ======== TEST RINGBACK ========');
  console.log('🔔 Platform:', Platform.OS);

  // Step 1: Stop InCallManager first (ensures fresh start)
  console.log('🔔 Step 1: Stopping InCallManager...');
  try { InCallManager.stop(); } catch (e) {}

  // Step 2: Wait for iOS to release audio session
  await new Promise(resolve => setTimeout(resolve, 100));

  // Step 3: Start fresh InCallManager
  console.log('🔔 Step 2: Starting fresh InCallManager...');
  try {
    InCallManager.start({ media: 'audio' });
    console.log('🔔 ✅ InCallManager started');
  } catch (e: any) {
    console.log('🔔 InCallManager error:', e?.message);
  }

  // Step 4: Wait for audio session to be ready
  await new Promise(resolve => setTimeout(resolve, 100));

  // Step 5: Start ringback
  console.log('🔔 Step 3: Starting ringback...');
  await startRingback();

  console.log('🔔 isRingbackPlaying:', isRingbackPlaying);
  console.log('🔔 ✅ You should hear the ringback sound now!');

  // Stop after 10 seconds
  setTimeout(() => {
    console.log('🔔 ======== STOPPING TEST ========');
    stopRingback();
    try { InCallManager.stop(); } catch (e) {}
    console.log('🔔 ✅ TEST COMPLETE - call testRingback() again!');
  }, 10000);
}

// Force start ringback (exported for testing)
export async function forceStartRingback(): Promise<void> {
  console.log('🔔 FORCE: Starting ringback...');
  await startRingback();
}

// Force stop ringback (exported for testing)
export function forceStopRingback(): void {
  console.log('🔔 FORCE: Stopping ringback...');
  stopRingback();
}

// Direct test - bypasses all logic, just tries to play sound
export function directSoundTest(): void {
  console.log('🔔 ===== DIRECT SOUND TEST =====');
  console.log('🔔 Sound:', Sound);
  console.log('🔔 SoundAvailable:', SoundAvailable);
  console.log('🔔 Sound.MAIN_BUNDLE:', Sound?.MAIN_BUNDLE);

  if (!Sound) {
    console.error('🔔 ❌ Sound module is null!');
    return;
  }

  // Try to set category
  try {
    Sound.setCategory('Playback', true);
    console.log('🔔 Category set to Playback');
  } catch (e: any) {
    console.error('🔔 setCategory failed:', e?.message);
  }

  // Create and play sound
  console.log('🔔 Creating Sound instance for ringback.mp3...');
  const testSound = new Sound('ringback.mp3', Sound.MAIN_BUNDLE, (error: any) => {
    if (error) {
      console.error('🔔 ❌ FAILED to load ringback.mp3:', error);
      console.error('🔔 Error message:', error?.message);
      console.error('🔔 Error code:', error?.code);
      return;
    }

    console.log('🔔 ✅ Sound loaded!');
    console.log('🔔 Duration:', testSound.getDuration(), 'seconds');
    console.log('🔔 isLoaded:', testSound.isLoaded());

    testSound.setVolume(1.0);
    console.log('🔔 Playing...');

    testSound.play((success: boolean) => {
      console.log('🔔 Play callback - success:', success);
      if (success) {
        console.log('🔔 ✅ SOUND PLAYED SUCCESSFULLY!');
      } else {
        console.error('🔔 ❌ PLAYBACK FAILED');
      }
    });
  });
}

export function endCall(): void {
  const callId = activeCallUUID || incomingCallUUID;
  currentCallState = 'ended';
  activeCallUUID = null;
  incomingCallUUID = null;
  activeCallStartedAt = null;
  callerName = null;
  isMuted = false;
  isSpeakerEnabled = false;
  currentSpeakerMode = 'earpiece';
  pendingAnswerCallUUID = null;

  try {
    if (callId) {
      RNCallKeep.endCall(callId);
    }
  } catch (e) {
    console.warn('endCall: CallKeep endCall failed', e);
  }

  try {
    endVoiceCall();
    stopRingback();
    stopIncomingRingtone();
  } catch (e) {
    console.warn('endCall: media cleanup failed', e);
  }

  if (currentDeviceId && callId) {
    voipFetch(`${BASE_URL}/api/calls/${callId}/end`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({deviceId: currentDeviceId}),
    }).catch(e => console.warn('Failed to notify backend about call end', e));
  }

  console.log('Call ended', callId || '(no uuid)');

  setTimeout(() => {
    if (currentCallState === 'ended') {
      currentCallState = 'idle';
      stopNativeConnectionStatusSync();
    }
  }, 400);
}

// Temporary manual telecom test for Android incoming UI without FCM.
export async function debugShowIncomingCallUIManually(
  callerName = 'Telecom Test',
  handle = 'debug-caller',
): Promise<string | null> {
  if (Platform.OS !== 'android') {
    return null;
  }
  const callUUID = generateUUID();
  try {
    ensureAndroidTelecomReady().catch(() => {});
    telecomDebug('manual_displayIncomingCall_attempt', {callUUID});
    safeAndroidDisplayIncomingCall(callUUID, handle, callerName);
    telecomDebug('manual_displayIncomingCall_called', {callUUID});
    return callUUID;
  } catch (e: any) {
    telecomDebug('manual_displayIncomingCall_error', {
      callUUID,
      errorName: e?.name || 'Error',
      errorMessage: e?.message || String(e),
      isSecurityException: String(e?.message || '').includes('SecurityException'),
    });
    throw e;
  }
}


// ---------------------------------------------------------------------------
// Totus Support: повторный вход без перезапуска приложения.
// cleanupVoipOnLogout() снимает регистрацию, сокет, подписку на FCM-токен и сетевой монитор,
// но CallKeep остаётся настроенным (isVoipInitialized = true), а initVoipAndCallKeep() в этом
// случае ничего не регистрирует, если deviceId уже сброшен. Для нового входа — эта функция.
// ---------------------------------------------------------------------------
export function isVoipEngineInitialized(): boolean {
  return isVoipInitialized;
}

export function resumeVoipAfterLogin(loyaltyId: string): void {
  if (!isVoipInitialized) {
    initVoipAndCallKeep(loyaltyId);
    return;
  }
  setUserLoyaltyId(loyaltyId);
  startNetworkMonitoring();
  if (Platform.OS === 'android' && !fcmTokenRefreshUnsubscribe) {
    fcmTokenRefreshUnsubscribe = messaging().onTokenRefresh(token => {
      if (!token) {
        return;
      }
      currentDeviceId = token;
      registerDeviceWithBackend(token, currentLoyaltyId).catch(e => {
        console.warn('Failed to refresh Android FCM token registration', e);
      });
    });
  }
}
