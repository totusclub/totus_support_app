// Авторизованные запросы Support App к voip.totus.club — порт calling_v2/lib/http.ts
// на AsyncStorage (SECURITY_JWT_PLAN_RU.md, волна 3).
//
// Токены агента (agent-JWT, общий JWT_SECRET с totus_API) выдаёт POST /api/web/login:
//   accessToken — 12 ч, refreshToken — 30 д.
// authFetch добавляет `Authorization: Bearer …` ко всем запросам на VOIP_BASE_URL;
// на 401 — один общий refresh через totus_API /api/auth/refresh и повтор;
// если refresh не удался — сессия завершается (onSessionExpired → экран входа).
//
// Токены держатся в памяти (быстрый синхронный доступ для Socket.IO) и в AsyncStorage
// (для холодного старта из VoIP-пуша/CallKeep, когда UI ещё не смонтирован).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {API_BASE_URL, VOIP_BASE_URL} from '../config/server';

const TOKEN_KEY = 'support:accessToken';
const REFRESH_KEY = 'support:refreshToken';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let sessionExpiredHandler: (() => void) | null = null;

/** Загрузить токены из AsyncStorage (идемпотентно). */
export function loadTokens(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const [[, a], [, r]] = await AsyncStorage.multiGet([TOKEN_KEY, REFRESH_KEY]);
        accessToken = accessToken || a || null;
        refreshToken = refreshToken || r || null;
      } catch {
        /* storage недоступен — работаем без сохранённых токенов */
      } finally {
        loaded = true;
      }
    })();
  }
  return loadPromise;
}

export function getAccessTokenSync(): string | null {
  return accessToken;
}

export async function getAccessToken(): Promise<string | null> {
  await loadTokens();
  return accessToken;
}

export async function getRefreshToken(): Promise<string | null> {
  await loadTokens();
  return refreshToken;
}

export async function storeTokens(access?: string | null, refresh?: string | null): Promise<void> {
  if (access) accessToken = access;
  if (refresh) refreshToken = refresh;
  loaded = true;
  const pairs: [string, string][] = [];
  if (access) pairs.push([TOKEN_KEY, access]);
  if (refresh) pairs.push([REFRESH_KEY, refresh]);
  if (pairs.length) {
    try {
      await AsyncStorage.multiSet(pairs);
    } catch {
      /* не критично: токен останется в памяти до перезапуска */
    }
  }
}

export async function clearTokens(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  loaded = true;
  try {
    await AsyncStorage.multiRemove([TOKEN_KEY, REFRESH_KEY]);
  } catch {
    /* ignore */
  }
}

/** Разбор payload JWT без проверки подписи (её делает сервер). */
export function decodeJwt(token: string | null): Record<string, any> | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    const json = base64Decode(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function isTokenAlive(token: string | null): boolean {
  const payload = decodeJwt(token);
  return !!payload && typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
}

/** Вызывается, когда refresh не удался (UI переходит на экран входа). */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

type RefreshResult = {token: string | null; rejected: boolean};
let refreshPromise: Promise<RefreshResult> | null = null;

/**
 * Обновить access-токен (один запрос на все параллельные 401).
 * rejected = true — сервер отверг refresh-токен (сессия действительно закончилась);
 * false при сетевой ошибке — сессию не завершаем, повторим позже.
 */
function doRefresh(): Promise<RefreshResult> {
  if (!refreshPromise) {
    refreshPromise = (async (): Promise<RefreshResult> => {
      const rt = await getRefreshToken();
      if (!rt) return {token: null, rejected: true};
      try {
        const resp = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({refreshToken: rt}),
        });
        if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
          return {token: null, rejected: true};
        }
        if (!resp.ok) return {token: null, rejected: false};
        const data = await resp.json();
        if (!data?.accessToken) return {token: null, rejected: true};
        await storeTokens(data.accessToken, data.refreshToken);
        return {token: data.accessToken as string, rejected: false};
      } catch {
        return {token: null, rejected: false};
      }
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function refreshAccessToken(): Promise<string | null> {
  return (await doRefresh()).token;
}

/**
 * Обновить access-токен заранее, если он истёк или истекает в течение `marginSec`.
 * Возвращает true, если токен был обновлён (сокеты стоит переподключить: комнаты
 * support:staff / u:<id> сервер выдаёт только при валидном токене в handshake).
 */
export async function ensureFreshAccessToken(marginSec = 300): Promise<boolean> {
  const token = await getAccessToken();
  const payload = decodeJwt(token);
  const exp = payload && typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  if (token && exp - marginSec * 1000 > Date.now()) return false;
  const next = await refreshAccessToken();
  return !!next;
}

function isVoipUrl(url: string): boolean {
  return url.startsWith(VOIP_BASE_URL);
}

/** fetch с Bearer для voip.totus.club. Сигнатура совпадает с fetch. */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!isVoipUrl(url)) return fetch(url, init);

  const withToken = (token: string | null): RequestInit => {
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) || {}),
    };
    if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
    return {...init, headers};
  };

  let token = await getAccessToken();
  // Заранее обновляем протухший токен, чтобы не ловить 401 (особенно при входящем звонке)
  if (token && !isTokenAlive(token)) {
    token = (await refreshAccessToken()) || token;
  }
  let resp = await fetch(url, withToken(token));
  if (resp.status !== 401 || !token) return resp;

  const r = await doRefresh();
  if (r.token) {
    resp = await fetch(url, withToken(r.token));
    if (resp.status !== 401) return resp;
    sessionExpiredHandler?.();
    return resp;
  }
  // Сеть недоступна — не разлогиниваем; сервер отверг refresh — сессия закончилась
  if (r.rejected) sessionExpiredHandler?.();
  return resp;
}

// ---------------------------------------------------------------------------
// base64 без зависимостей (atob нет в старых движках Hermes)
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Decode(input: string): string {
  const str = input.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const v = B64.indexOf(str.charAt(i));
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // UTF-8 → строка
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f));
    else if (b < 0xf0)
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
    else {
      const cp =
        ((b & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}
