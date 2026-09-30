/**
 * Recovering a call answered while the app was in the background or closed.
 *
 * Plain logic with no React Native imports, so scripts/check-voip-answer-recovery.mjs
 * can run it on bare Node. Only erasable TypeScript syntax here (no enum, no
 * parameter properties): Node >= 22.18 runs this file directly.
 *
 * Why it exists (totus_support_app, 30.09.2026):
 * 1. iOS: when a CallKit call is answered before JS has registered its listeners,
 *    RNCallKeep keeps the answer in its delayed-events queue. It is only
 *    available through getInitialEvents(); the app read that queue on Android only,
 *    so the iOS answer was lost and the call never connected.
 * 2. The pending answer was processed from up to 4 places (init timer, every
 *    VoIP-token 'register' event, the already-initialized branch, the background
 *    queue) and was never cleared. Each run created a new RTCPeerConnection and
 *    overwrote the previous one, breaking the connection that had just started.
 */

export type CallKeepInitialEvent = {
  name?: string;
  data?: {callUUID?: string | null} | null;
};

export type InitialEventsSummary = {
  /** Call to connect: answered and not ended afterwards. */
  answerUUID: string | null;
  /** Calls ended by the user (reject or hang up) before JS started. */
  endedUUIDs: string[];
  /**
   * iOS: CallKit activated the audio session before JS started (and did not
   * deactivate it afterwards). WebRTC must be told, otherwise the call connects
   * without sound when answered from the lock screen.
   */
  audioActivated: boolean;
};

const ANSWER_EVENT = 'RNCallKeepPerformAnswerCallAction';
const END_EVENT = 'RNCallKeepPerformEndCallAction';
const AUDIO_ON_EVENT = 'RNCallKeepDidActivateAudioSession';
const AUDIO_OFF_EVENT = 'RNCallKeepDidDeactivateAudioSession';

/**
 * Reduce RNCallKeep delayed events to one decision, in event order.
 * "answer, then end" for the same call means: the call is over, do not connect.
 */
export function summarizeInitialCallKeepEvents(
  events: unknown,
): InitialEventsSummary {
  const summary: InitialEventsSummary = {answerUUID: null, endedUUIDs: [], audioActivated: false};
  if (!Array.isArray(events)) {
    return summary;
  }
  const answered: string[] = [];
  const ended = new Set<string>();
  for (const raw of events) {
    const event = raw as CallKeepInitialEvent | null;
    if (event?.name === AUDIO_ON_EVENT) {
      summary.audioActivated = true;
      continue;
    }
    if (event?.name === AUDIO_OFF_EVENT) {
      summary.audioActivated = false;
      continue;
    }
    const uuid = event?.data?.callUUID ? String(event.data.callUUID) : '';
    if (!uuid) {
      continue;
    }
    if (event?.name === ANSWER_EVENT) {
      ended.delete(uuid);
      const idx = answered.indexOf(uuid);
      if (idx >= 0) {
        answered.splice(idx, 1);
      }
      answered.push(uuid);
    } else if (event?.name === END_EVENT) {
      ended.add(uuid);
      const idx = answered.indexOf(uuid);
      if (idx >= 0) {
        answered.splice(idx, 1);
      }
    }
  }
  summary.answerUUID = answered.length ? answered[answered.length - 1] : null;
  summary.endedUUIDs = Array.from(ended);
  return summary;
}

type GateState = 'inflight' | 'done';

export type AnswerGate = {
  /** true = caller owns the answer for this call; false = already running or done. */
  begin(uuid: string): boolean;
  /** ok=true keeps the call marked as answered; ok=false allows a new attempt. */
  finish(uuid: string, ok: boolean): void;
  isInFlight(uuid: string): boolean;
  isDone(uuid: string): boolean;
  /** Forget a call (it ended). */
  reset(uuid?: string | null): void;
};

/** One answer per call: prevents a second RTCPeerConnection for the same call. */
export function createAnswerGate(maxEntries = 20): AnswerGate {
  const states = new Map<string, GateState>();
  return {
    begin(uuid) {
      if (!uuid || states.has(uuid)) {
        return false;
      }
      states.set(uuid, 'inflight');
      while (states.size > maxEntries) {
        const oldest = states.keys().next().value as string;
        states.delete(oldest);
      }
      return true;
    },
    finish(uuid, ok) {
      if (!uuid) {
        return;
      }
      if (ok) {
        states.set(uuid, 'done');
      } else {
        states.delete(uuid);
      }
    },
    isInFlight(uuid) {
      return states.get(uuid) === 'inflight';
    },
    isDone(uuid) {
      return states.get(uuid) === 'done';
    },
    reset(uuid) {
      if (uuid) {
        states.delete(uuid);
      } else {
        states.clear();
      }
    },
  };
}

/**
 * Pause before offer-fetch attempt number `attempt` (1-based; 1 means none).
 * After a long background the network and the token refresh need a few seconds:
 * 0.5, 1, 2, 3, 3, 3 ... s, about 25 s over 10 attempts.
 */
export function offerRetryDelayMs(attempt: number): number {
  if (attempt <= 1) {
    return 0;
  }
  const steps = [500, 1000, 2000];
  return steps[attempt - 2] ?? 3000;
}

export const OFFER_FETCH_MAX_ATTEMPTS = 10;

export type ResumeSnapshot = {
  pendingAnswerUUID: string | null;
  activeCallUUID: string | null;
  callState: string;
  hasPeer: boolean;
  answerInFlight: boolean;
  answerDone: boolean;
};

/**
 * What to do when the app becomes active:
 * 'answer' - an answered call has no connection yet, start (or restart) the answer;
 * 'none'   - nothing to do.
 */
export function decideOnResume(s: ResumeSnapshot): {
  action: 'answer' | 'none';
  uuid: string | null;
} {
  const uuid = s.pendingAnswerUUID || s.activeCallUUID;
  if (!uuid || s.answerInFlight || s.answerDone) {
    return {action: 'none', uuid: null};
  }
  if (s.pendingAnswerUUID) {
    return {action: 'answer', uuid};
  }
  if (s.callState === 'answered' && !s.hasPeer) {
    return {action: 'answer', uuid};
  }
  return {action: 'none', uuid: null};
}
