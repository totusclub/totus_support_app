// Точка входа VoIP для фоновых сценариев Android (FCM data-push «incoming_call», headless-задачи
// CallKeep) — порт totus_APP/src/modules/voip/CallService.js.
//
// calling_api_v2 будит Android-устройство data-only FCM-пушем:
//   data { type: 'incoming_call', callId, uuid, callerName, fromLoyaltyId, toLoyaltyId, offerType, offerSdp }
// iOS будится PushKit VoIP-пушем (AppDelegate.swift → CallKeepHelper → CallKit), JS подключается позже.
import {Platform} from 'react-native';
import messaging from '@react-native-firebase/messaging';
import RNCallKeep from 'react-native-callkeep';
import {
  initVoipAndCallKeep,
  isVoipEngineInitialized,
  resumeVoipAfterLogin,
  getCallState,
  handleAndroidIncomingCallNotification,
  answerCall as voipAnswerCall,
  endCall as voipEndCall,
  rejectCall as voipRejectCall,
  queuePendingAnswerFromBackground,
} from './VoipService';

let androidMessagingHandlersRegistered = false;

type PushData = Record<string, any> | undefined | null;

// Только FCM data-push входящего звонка от calling_api_v2 (index.js: data.type = 'incoming_call').
// События действий CallKeep тоже содержат callUUID — их сюда не пускаем.
function isIncomingCallMessage(data: PushData): boolean {
  return Boolean(data) && data!.type === 'incoming_call' && Boolean(data!.callId || data!.uuid);
}

function ensureAndroidVoipReady(loyaltyId?: string) {
  if (Platform.OS !== 'android' || isVoipEngineInitialized()) return;
  initVoipAndCallKeep(loyaltyId);
}

function bringAndroidAppToForeground(reason: string) {
  if (Platform.OS !== 'android') return;
  try {
    const callKeepAny = RNCallKeep as any;
    if (typeof callKeepAny?.backToForeground === 'function') {
      callKeepAny.backToForeground();
      console.log(`Android: app moved to foreground (${reason})`);
    }
  } catch (e) {
    console.warn('Android: failed to bring app to foreground', e);
  }
}

function normalizeIncomingPayload(data: PushData) {
  if (!data) return null;
  const uuid = data.uuid || data.callUUID || data.callId;
  if (!uuid) return null;
  return {
    uuid: String(uuid),
    handle: data.handle || data.fromDevice || data.from || 'Unknown',
    callerName: data.callerName || data.caller_name || 'Входящий звонок',
    toLoyaltyId: data.toLoyaltyId || data.toUserId || null,
    offerSdp: data.offerSdp || null,
    offerType: data.offerType || null,
  };
}

/** Регистрируется в index.js до AppRegistry.registerComponent. */
export function registerAndroidCallBackgroundHandlers(): void {
  if (Platform.OS !== 'android' || androidMessagingHandlersRegistered) return;

  messaging().setBackgroundMessageHandler(async remoteMessage => {
    const data = remoteMessage?.data as PushData;
    if (isIncomingCallMessage(data)) {
      await displayIncomingCall(data);
    }
  });

  messaging().onMessage(async remoteMessage => {
    const data = remoteMessage?.data as PushData;
    if (isIncomingCallMessage(data)) {
      await displayIncomingCall(data);
    }
  });

  androidMessagingHandlersRegistered = true;
}

/** После входа (и повторного входа без перезапуска приложения). */
export async function initCallKeep(loyaltyId: string): Promise<void> {
  if (Platform.OS === 'android') registerAndroidCallBackgroundHandlers();
  if (isVoipEngineInitialized()) {
    // движок уже поднят (фоновым пушем до входа или прошлой сессией) — перерегистрировать устройство
    resumeVoipAfterLogin(loyaltyId);
  } else {
    initVoipAndCallKeep(loyaltyId);
  }
}

export async function displayIncomingCall(data: PushData): Promise<void> {
  if (Platform.OS !== 'android') return;
  const normalized = normalizeIncomingPayload(data);
  if (!normalized) return;
  ensureAndroidVoipReady();

  let didShowNativeIncoming = false;
  try {
    RNCallKeep.displayIncomingCall(
      normalized.uuid,
      normalized.handle || 'Unknown',
      normalized.callerName || 'Входящий звонок',
      'generic',
      true,
    );
    didShowNativeIncoming = true;
  } catch (e) {
    console.warn('Android: failed to show native incoming call UI', e);
  }

  // Прошивки, где системный экран CallKeep не показывается: поднимаем приложение,
  // экран входящего звонка покажет наш CallScreen.
  if (!didShowNativeIncoming) {
    bringAndroidAppToForeground('incoming-call-fallback');
  }

  await handleAndroidIncomingCallNotification(
    {
      ...data,
      uuid: normalized.uuid,
      callId: normalized.uuid,
      callerName: normalized.callerName,
      handle: normalized.handle,
      toLoyaltyId: normalized.toLoyaltyId,
      offerSdp: normalized.offerSdp,
      offerType: normalized.offerType,
    },
    {skipNativeDisplay: true},
  );
}

export async function answerCall(callUUID: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  ensureAndroidVoipReady();
  await voipAnswerCall(callUUID);
}

export function endCall(callUUID?: string): void {
  if (Platform.OS !== 'android') return;
  ensureAndroidVoipReady();
  const current = getCallState();
  // Отвечённый/исходящий звонок завершаем, входящий неотвеченный — отклоняем
  if (callUUID && !(current.callUUID === callUUID && (current.state === 'answered' || current.state === 'calling'))) {
    voipRejectCall(callUUID);
    return;
  }
  voipEndCall();
}

export async function handleBackgroundCallKeepEvent(message: any): Promise<void> {
  if (Platform.OS !== 'android' || !message) return;
  const eventName = message?.name || message?.data?.name || '';
  const callUUID =
    message?.callUUID || message?.data?.callUUID || message?.data?.callId || message?.callId || null;
  if (!eventName || !callUUID) return;

  if (eventName === 'RNCallKeepPerformAnswerCallAction' || eventName === 'answerCall') {
    ensureAndroidVoipReady();
    queuePendingAnswerFromBackground(callUUID);
    bringAndroidAppToForeground('background-answer-event');
    return;
  }
  if (eventName === 'RNCallKeepPerformEndCallAction' || eventName === 'endCall') {
    endCall(callUUID);
  }
}

/** Headless / background FCM entry (index.js). */
export async function handleIncomingPush(message: any, source = 'unknown'): Promise<void> {
  try {
    const data = message?.data || message || null;
    console.log('[push/voip] handleIncomingPush', source, {
      type: data?.type || null,
      hasCallId: Boolean(data?.callId || data?.callUUID || data?.uuid),
    });
    if (isIncomingCallMessage(data)) {
      await displayIncomingCall(data);
    }
  } catch (e: any) {
    console.warn('[push/voip] handleIncomingPush failed', source, e?.message || e);
  }
}

export {queuePendingAnswerFromBackground};
