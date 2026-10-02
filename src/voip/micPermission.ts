// Ранний запрос доступа к микрофону (iOS).
//
// Зачем: без разрешения первый ответ на звонок из CallKit / с экрана блокировки
// сбрасывается — getUserMedia не может показать системный запрос, пока приложение
// не на экране, и звонок завершается с ошибкой (аудит calling flow, A6, 02.10.2026).
//
// Как: после входа, только когда приложение на экране (AppState 'active'),
// спрашиваем статус через permissions из react-native-webrtc и, если iOS ещё
// не спрашивал, показываем системный запрос. Аудиосессия при этом не трогается
// (в отличие от getUserMedia), идущий звонок не мешает.
// Холодный старт из VoIP-пуша (приложение в фоне) — ждём первого 'active'.
// Android: RECORD_AUDIO уже запрашивается в VoipService при init — здесь ничего не делаем.
import {AppState, Platform} from 'react-native';
import {permissions} from 'react-native-webrtc';

export type MicPermissionStatus = 'granted' | 'denied' | 'prompt' | 'unknown';

const TAG = '[mic-permission]';

let lastStatus: MicPermissionStatus = 'unknown';
let inFlight: Promise<MicPermissionStatus> | null = null;
let waitForActive: {remove(): void} | null = null;

function normalize(value: unknown): MicPermissionStatus {
  return value === 'granted' || value === 'denied' || value === 'prompt' ? value : 'unknown';
}

/** Последний известный статус (для диагностики и будущего индикатора в профиле). */
export function getMicPermissionStatus(): MicPermissionStatus {
  return lastStatus;
}

/** Текущий статус без запроса у пользователя. */
export async function queryMicPermission(): Promise<MicPermissionStatus> {
  try {
    lastStatus = normalize(await permissions.query({name: 'microphone'}));
  } catch (e) {
    console.warn(TAG, 'query failed', e);
    lastStatus = 'unknown';
  }
  return lastStatus;
}

function requestNow(): Promise<MicPermissionStatus> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const current = await queryMicPermission();
    if (current !== 'prompt') {
      if (current === 'denied') console.warn(TAG, 'denied — calls will have no audio until allowed in Settings');
      return current;
    }
    try {
      const granted = await permissions.request({name: 'microphone'});
      lastStatus = granted ? 'granted' : 'denied';
    } catch (e) {
      console.warn(TAG, 'request failed', e);
      lastStatus = 'unknown';
    }
    console.log(TAG, 'requested, status', lastStatus);
    return lastStatus;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Запросить доступ к микрофону, как только приложение будет на экране.
 * Безопасно вызывать много раз: один запрос за раз, один ожидающий слушатель.
 */
export function ensureMicPermissionWhenActive(): void {
  if (Platform.OS !== 'ios') return;
  if (AppState.currentState === 'active') {
    void requestNow();
    return;
  }
  if (waitForActive) return;
  waitForActive = AppState.addEventListener('change', state => {
    if (state !== 'active') return;
    cancelMicPermissionRequest();
    void requestNow();
  });
}

/** Выход из аккаунта: не спрашивать доступ после выхода. */
export function cancelMicPermissionRequest(): void {
  if (waitForActive) {
    waitForActive.remove();
    waitForActive = null;
  }
}
