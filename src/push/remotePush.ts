// Пуши о сообщениях пользователей, когда приложение свёрнуто или экран заблокирован (iOS).
//
// Раньше уведомление создавалось только на устройстве (localNotifications.ts), пока жив сокет
// чата. На iPhone iOS усыпляет приложение через несколько секунд после блокировки экрана —
// сокет рвётся, и сотрудник не узнавал о новых сообщениях.
//
// Теперь: APNs-токен обычных пушей (AppDelegate → VoipPushHelper → NativeModules.TotusApns)
// регистрируется на calling_api_v2: POST /api/support/push-device. Сервер (lib/staffPush.js)
// шлёт пуш о каждом сообщении пользователя, если приложение не на экране (support:presence
// в supportSocket.ts). На экране уведомление по-прежнему показывает само приложение.
//
// Окружение APNs: сборка из Xcode (Debug) — sandbox, TestFlight / App Store — production.
// Android: пока без изменений (локальные уведомления, пока жив процесс).
import {NativeModules, Platform} from 'react-native';
import {VOIP_BASE_URL} from '../config/server';
import {authFetch} from '../api/http';

const BUNDLE_ID = 'club.totus.support';
const TOKEN_WAIT_MS = 15_000;
const TOKEN_POLL_MS = 500;

type ApnsModule = {
  registerForRemote?: () => void;
  getToken?: () => Promise<string | null>;
};

const native: ApnsModule | undefined = (NativeModules as any).TotusApns;

let registeredToken: string | null = null;
let registering: Promise<string | null> | null = null;

/** Токен, зарегистрированный на сервере (null — пушей о сообщениях на этом устройстве нет). */
export function getRegisteredPushToken(): string | null {
  return registeredToken;
}

/** Сервер шлёт этому устройству пуши о сообщениях — локальное уведомление в фоне не нужно. */
export function isRemotePushActive(): boolean {
  return !!registeredToken;
}

function apnsEnvironment(): 'sandbox' | 'production' {
  return __DEV__ ? 'sandbox' : 'production';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForApnsToken(): Promise<string | null> {
  if (!native?.getToken) return null;
  native.registerForRemote?.();
  const started = Date.now();
  while (Date.now() - started < TOKEN_WAIT_MS) {
    try {
      const token = await native.getToken();
      if (token) return token;
    } catch {
      return null;
    }
    await sleep(TOKEN_POLL_MS);
  }
  return null;
}

/**
 * Зарегистрировать устройство для пушей о сообщениях (после входа / восстановления сессии,
 * при возврате в приложение — токен мог смениться). Ошибки не роняют вход.
 */
export function registerRemotePush(): Promise<string | null> {
  if (Platform.OS !== 'ios') return Promise.resolve(null);
  if (registering) return registering;
  registering = (async () => {
    const token = await waitForApnsToken();
    if (!token) {
      console.warn('[push] APNs-токен не получен — пуши о сообщениях на этом iPhone недоступны');
      return null;
    }
    try {
      const resp = await authFetch(`${VOIP_BASE_URL}/api/support/push-device`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token, platform: 'ios', environment: apnsEnvironment(), bundleId: BUNDLE_ID}),
      });
      if (!resp.ok) {
        console.warn('[push] push-device register failed', resp.status);
        return registeredToken;
      }
      registeredToken = token;
      return token;
    } catch (e) {
      console.warn('[push] push-device register error', e);
      return registeredToken;
    }
  })().finally(() => {
    registering = null;
  });
  return registering;
}

/** Выход: снять только это устройство (до очистки токенов сессии). */
export async function unregisterRemotePush(): Promise<void> {
  const token = registeredToken;
  registeredToken = null;
  if (!token) return;
  try {
    await authFetch(`${VOIP_BASE_URL}/api/support/push-device`, {
      method: 'DELETE',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token}),
    });
  } catch {
    /* сервер удалит мёртвый токен сам при следующей отправке */
  }
}
