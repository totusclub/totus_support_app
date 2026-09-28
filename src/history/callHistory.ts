// История звонков сотрудника поддержки.
//
// calling_api_v2 хранит звонки только в памяти процесса (Map calls) и не отдаёт журнал —
// ни панель calling_v2, ни клиентское приложение истории с сервера не получают.
// Поэтому журнал ведётся на устройстве: каждая запись — реальный звонок, прошедший через
// VoipService (callId = id звонка на сервере). Хранится в AsyncStorage, до 500 записей.
import AsyncStorage from '@react-native-async-storage/async-storage';

export type CallDirection = 'incoming' | 'outgoing';
export type CallOutcome =
  | 'answered' // был разговор
  | 'missed' // входящий, не отвечен
  | 'rejected' // входящий, отклонён сотрудником
  | 'no_answer' // исходящий, абонент не ответил / отклонил
  | 'failed'; // не удалось начать

export interface CallRecord {
  callId: string;
  direction: CallDirection;
  peerName: string;
  peerLoyaltyId: string | null;
  startedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  durationSec: number;
  outcome: CallOutcome;
}

const KEY_PREFIX = 'support:callHistory:';
const MAX_RECORDS = 500;

let ownerKey = `${KEY_PREFIX}anon`;
let cache: CallRecord[] | null = null;
let loading: Promise<CallRecord[]> | null = null;
const listeners = new Set<(list: CallRecord[]) => void>();

/** История — своя для каждого агента (по id), чтобы при смене аккаунта не смешивалась. */
export function setHistoryOwner(agentId: number | null): void {
  const next = `${KEY_PREFIX}${agentId ?? 'anon'}`;
  if (next !== ownerKey) {
    ownerKey = next;
    cache = null;
    loading = null;
  }
}

async function load(): Promise<CallRecord[]> {
  if (cache) return cache;
  if (!loading) {
    const key = ownerKey;
    loading = (async () => {
      let list: CallRecord[] = [];
      try {
        const raw = await AsyncStorage.getItem(key);
        list = raw ? (JSON.parse(raw) as CallRecord[]) : [];
      } catch {
        list = [];
      }
      if (key === ownerKey && !cache) cache = list;
      return cache || list;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

async function save(list: CallRecord[]): Promise<void> {
  cache = list.slice(0, MAX_RECORDS);
  listeners.forEach(l => l(cache!));
  try {
    await AsyncStorage.setItem(ownerKey, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

export async function getCallHistory(): Promise<CallRecord[]> {
  return load();
}

export function subscribeCallHistory(listener: (list: CallRecord[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Все изменения журнала выполняются строго по очереди (иначе два upsert в одном тике
// читают одну и ту же копию списка и второй затирает первый).
let queue: Promise<void> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  queue = queue.then(op, op).catch(() => {});
  return queue;
}

/** Добавить или обновить запись по callId (новые — сверху). */
export function upsertCallRecord(patch: Partial<CallRecord> & {callId: string}): Promise<void> {
  return enqueue(() => upsertNow(patch));
}

async function upsertNow(patch: Partial<CallRecord> & {callId: string}): Promise<void> {
  const list = [...(await load())];
  const idx = list.findIndex(r => r.callId === patch.callId);
  if (idx === -1) {
    const rec: CallRecord = {
      direction: 'incoming',
      peerName: 'Пользователь',
      peerLoyaltyId: null,
      startedAt: Date.now(),
      answeredAt: null,
      endedAt: null,
      durationSec: 0,
      outcome: 'missed',
      ...patch,
    };
    list.unshift(rec);
  } else {
    list[idx] = {...list[idx], ...patch};
  }
  await save(list);
}

export function clearCallHistory(): Promise<void> {
  return enqueue(() => save([]));
}

export function outcomeLabel(r: CallRecord): string {
  switch (r.outcome) {
    case 'answered':
      return r.direction === 'incoming' ? 'Входящий' : 'Исходящий';
    case 'missed':
      return 'Пропущенный';
    case 'rejected':
      return 'Отклонён';
    case 'no_answer':
      return 'Нет ответа';
    case 'failed':
      return 'Не удалось позвонить';
    default:
      return '';
  }
}
