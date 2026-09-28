// Состояние звонка для UI + журнал звонков.
//
// VoipService (как и calling_v2/lib/webrtc-service.ts) хранит состояние в модуле и не шлёт
// событий — UI опрашивает getCallState() каждые 400 мс (так же делает CallModal панели агента).
// Здесь же по переходам состояний ведётся история звонков (src/history/callHistory.ts).
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {Alert, AppState} from 'react-native';
import {
  answerCall,
  endCall,
  getActiveCallInfo,
  getCallState,
  rejectCall,
  startOutgoingVoiceCallByLoyaltyId,
  toggleMute,
  toggleSpeakerMode,
} from '../voip/VoipService';
import {getCallInfo} from '../api/calls';
import {normalizeLoyaltyId} from '../api/users';
import {upsertCallRecord, type CallDirection} from '../history/callHistory';
import {showMissedCallNotification} from '../push/localNotifications';
import {useAuth} from './AuthContext';

export type UiCallState = 'idle' | 'calling' | 'ringing' | 'answered' | 'ended' | 'rejected';

export interface CallTarget {
  loyaltyId: string;
  name: string;
}

interface CallSnapshot {
  state: UiCallState;
  callUUID: string | null;
  callerName: string | null;
  isMuted: boolean;
  speakerOn: boolean;
  connectionState: string | null;
  startedAt: number | null;
  direction: CallDirection | null;
  peerLoyaltyId: string | null;
}

interface CallContextValue extends CallSnapshot {
  seconds: number;
  screenVisible: boolean;
  showScreen: () => void;
  hideScreen: () => void;
  call: (target: CallTarget) => Promise<void>;
  answer: () => void;
  reject: () => void;
  hangup: () => void;
  mute: () => void;
  speaker: () => void;
}

const EMPTY: CallSnapshot = {
  state: 'idle',
  callUUID: null,
  callerName: null,
  isMuted: false,
  speakerOn: false,
  connectionState: null,
  startedAt: null,
  direction: null,
  peerLoyaltyId: null,
};

const Ctx = createContext<CallContextValue>({
  ...EMPTY,
  seconds: 0,
  screenVisible: false,
  showScreen: () => {},
  hideScreen: () => {},
  call: async () => {},
  answer: () => {},
  reject: () => {},
  hangup: () => {},
  mute: () => {},
  speaker: () => {},
});

export function useCall(): CallContextValue {
  return useContext(Ctx);
}

const POLL_MS = 400;

interface TrackedCall {
  callId: string;
  direction: CallDirection;
  answered: boolean;
  rejectedByMe: boolean;
  peerLoyaltyId: string | null;
  peerName: string;
}

export function CallProvider({children}: {children: React.ReactNode}) {
  const {user, status} = useAuth();
  const [snap, setSnap] = useState<CallSnapshot>(EMPTY);
  const [seconds, setSeconds] = useState(0);
  const [screenVisible, setScreenVisible] = useState(false);

  const tracked = useRef<TrackedCall | null>(null);
  const pendingOutgoing = useRef<CallTarget | null>(null);
  const prevState = useRef<UiCallState>('idle');
  const snapRef = useRef<CallSnapshot>(EMPTY);

  const finishTracked = useCallback((finalState: UiCallState) => {
    const t = tracked.current;
    if (!t) return;
    tracked.current = null;
    const endedAt = Date.now();
    let outcome: 'answered' | 'missed' | 'rejected' | 'no_answer';
    if (t.answered) outcome = 'answered';
    else if (t.direction === 'outgoing') outcome = 'no_answer';
    else if (t.rejectedByMe) outcome = 'rejected';
    else outcome = 'missed';
    upsertCallRecord({callId: t.callId, endedAt, outcome}).catch(() => {});
    if (outcome === 'missed' && AppState.currentState !== 'active') {
      showMissedCallNotification({callId: t.callId, name: t.peerName}).catch(() => {});
    }
    void finalState;
  }, []);

  const poll = useCallback(() => {
    const s = getCallState();
    const info = getActiveCallInfo();
    const state = (s.state || 'idle') as UiCallState;
    const prev = prevState.current;
    prevState.current = state;

    // ── Журнал: начало звонка ────────────────────────────────────────────
    if (s.callUUID && (!tracked.current || tracked.current.callId !== s.callUUID)) {
      if (state === 'calling' || state === 'ringing' || state === 'answered') {
        if (tracked.current) finishTracked(state);
        const outgoing = state === 'calling' || (state === 'answered' && !!pendingOutgoing.current);
        const target = outgoing ? pendingOutgoing.current : null;
        pendingOutgoing.current = null;
        const t: TrackedCall = {
          callId: s.callUUID,
          direction: outgoing ? 'outgoing' : 'incoming',
          answered: state === 'answered',
          rejectedByMe: false,
          peerLoyaltyId: target ? target.loyaltyId : null,
          peerName: (target?.name || s.callerName || 'Пользователь') as string,
        };
        tracked.current = t;
        upsertCallRecord({
          callId: t.callId,
          direction: t.direction,
          peerName: t.peerName,
          peerLoyaltyId: t.peerLoyaltyId,
          startedAt: Date.now(),
          answeredAt: t.answered ? Date.now() : null,
          outcome: t.answered ? 'answered' : t.direction === 'outgoing' ? 'no_answer' : 'missed',
        }).catch(() => {});
        if (t.direction === 'incoming') {
          // loyaltyId звонящего — из звонка на сервере (in-memory calls)
          getCallInfo(t.callId).then(ci => {
            if (!ci || tracked.current?.callId !== t.callId) {
              if (ci?.fromLoyaltyId) {
                upsertCallRecord({callId: t.callId, peerLoyaltyId: ci.fromLoyaltyId}).catch(() => {});
              }
              return;
            }
            const peer = ci.fromLoyaltyId || null;
            t.peerLoyaltyId = peer;
            if (ci.callerName) t.peerName = ci.callerName;
            upsertCallRecord({callId: t.callId, peerLoyaltyId: peer, peerName: t.peerName}).catch(() => {});
          });
        }
        setScreenVisible(true);
      }
    }

    // ── Журнал: ответ ───────────────────────────────────────────────────
    if (state === 'answered' && tracked.current && !tracked.current.answered) {
      tracked.current.answered = true;
      upsertCallRecord({
        callId: tracked.current.callId,
        answeredAt: info.startedAt || Date.now(),
        outcome: 'answered',
      }).catch(() => {});
    }

    // ── Журнал: завершение ──────────────────────────────────────────────
    if (tracked.current && (state === 'idle' || state === 'ended' || state === 'rejected')) {
      const t = tracked.current;
      finishTracked(state);
      if (t.answered) {
        const started = snapRef.current.startedAt;
        if (started) {
          upsertCallRecord({
            callId: t.callId,
            durationSec: Math.max(0, Math.round((Date.now() - started) / 1000)),
          }).catch(() => {});
        }
      }
    }

    if (prev !== state && state === 'idle') {
      // карточку закрываем чуть позже, чтобы было видно «Звонок завершён»
      setTimeout(() => {
        if (prevState.current === 'idle') setScreenVisible(false);
      }, 1500);
    }

    const next: CallSnapshot = {
      state,
      callUUID: s.callUUID,
      callerName: s.callerName || tracked.current?.peerName || null,
      isMuted: s.isMuted,
      speakerOn: s.speakerMode === 'loudspeaker' || s.isSpeakerEnabled,
      connectionState: s.connectionState,
      startedAt: info.isActive ? info.startedAt : null,
      direction: tracked.current?.direction || null,
      peerLoyaltyId: tracked.current?.peerLoyaltyId || null,
    };
    snapRef.current = next;
    setSnap(prevSnap =>
      prevSnap.state === next.state &&
      prevSnap.callUUID === next.callUUID &&
      prevSnap.callerName === next.callerName &&
      prevSnap.isMuted === next.isMuted &&
      prevSnap.speakerOn === next.speakerOn &&
      prevSnap.connectionState === next.connectionState &&
      prevSnap.startedAt === next.startedAt &&
      prevSnap.direction === next.direction &&
      prevSnap.peerLoyaltyId === next.peerLoyaltyId
        ? prevSnap
        : next,
    );
    setSeconds(next.startedAt ? Math.floor((Date.now() - next.startedAt) / 1000) : 0);
  }, [finishTracked]);

  useEffect(() => {
    if (status !== 'signedIn') return;
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [status, poll]);

  const call = useCallback(
    async (target: CallTarget) => {
      const loyaltyId = normalizeLoyaltyId(target.loyaltyId);
      const mine = normalizeLoyaltyId(user?.loyaltyId);
      if (!loyaltyId) {
        Alert.alert('Звонок', 'У пользователя нет loyalty ID');
        return;
      }
      if (loyaltyId === mine) {
        Alert.alert('Звонок', 'Вы не можете позвонить себе');
        return;
      }
      if (getCallState().state !== 'idle') {
        Alert.alert('Звонок', 'Сначала завершите текущий звонок');
        return;
      }
      // loyaltyId передаём в том виде, в каком его отдал backend (сравнение — по нормализованному)
      pendingOutgoing.current = {loyaltyId: target.loyaltyId, name: target.name};
      setScreenVisible(true);
      try {
        // Промис живёт до ответа/сброса — не блокируем UI
        startOutgoingVoiceCallByLoyaltyId(target.loyaltyId, target.name).catch((e: any) => {
          const msg = String(e?.message || e || '');
          console.warn('[call] outgoing failed', msg);
          const callId = `failed-${Date.now()}`;
          if (!tracked.current) {
            upsertCallRecord({
              callId,
              direction: 'outgoing',
              peerName: target.name,
              peerLoyaltyId: target.loyaltyId,
              startedAt: Date.now(),
              endedAt: Date.now(),
              outcome: 'failed',
            }).catch(() => {});
          }
          pendingOutgoing.current = null;
          if (getCallState().state === 'idle') setScreenVisible(false);
          Alert.alert(
            'Не удалось позвонить',
            msg.includes('not found') || msg.includes('not registered')
              ? 'Пользователь не в сети и не может принимать звонки'
              : msg.includes('Device ID')
              ? 'Звонки ещё инициализируются. Повторите через несколько секунд'
              : msg || 'Ошибка соединения',
          );
        });
        // Движок мог молча не начать звонок (занят другим звонком) — не держим пустой экран
        setTimeout(() => {
          if (!tracked.current && getCallState().state === 'idle') {
            pendingOutgoing.current = null;
            setScreenVisible(false);
          }
        }, 2500);
      } catch (e: any) {
        pendingOutgoing.current = null;
        setScreenVisible(false);
        Alert.alert('Не удалось позвонить', String(e?.message || e));
      }
    },
    [user],
  );

  const answer = useCallback(() => {
    const id = getCallState().callUUID;
    if (id) answerCall(id).catch(e => console.warn('[call] answer failed', e));
  }, []);

  const reject = useCallback(() => {
    const id = getCallState().callUUID;
    if (tracked.current) tracked.current.rejectedByMe = true;
    if (id) rejectCall(id);
  }, []);

  const hangup = useCallback(() => {
    endCall();
  }, []);

  const mute = useCallback(() => {
    toggleMute();
    poll();
  }, [poll]);

  const speaker = useCallback(() => {
    toggleSpeakerMode();
    poll();
  }, [poll]);

  const value = useMemo<CallContextValue>(
    () => ({
      ...snap,
      seconds,
      screenVisible,
      showScreen: () => setScreenVisible(true),
      hideScreen: () => setScreenVisible(false),
      call,
      answer,
      reject,
      hangup,
      mute,
      speaker,
    }),
    [snap, seconds, screenVisible, call, answer, reject, hangup, mute, speaker],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
