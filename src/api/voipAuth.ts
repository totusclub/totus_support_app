// Совместимый слой для VoipService (перенесён из totus_APP/src/modules/api/voipAuth.ts).
// В Support App источник токена — agent-JWT из src/api/http.ts (вход POST /api/web/login),
// а не redux-persist клиентского приложения.
import {authFetch, getAccessToken, storeTokens, clearTokens} from './http';

/** Для совместимости с кодом VoipService: null — выход, строка — новый access-токен. */
export function setVoipAccessToken(token: string | null | undefined): void {
  if (token) {
    storeTokens(token).catch(() => {});
  } else {
    // VoipService вызывает setVoipAccessToken(null) в cleanupVoipOnLogout —
    // токены чистит AuthContext.logout(); здесь ничего не удаляем, чтобы не
    // потерять refresh при повторной инициализации.
  }
}

export async function getVoipAccessToken(): Promise<string | null> {
  return getAccessToken();
}

/** fetch() с Bearer-токеном (и refresh на 401) для voip.totus.club. */
export function voipFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return authFetch(url, init);
}

/**
 * Опция `auth` для io(): функциональная форма вызывается socket.io-client при каждом
 * (пере)подключении, поэтому обновлённый после refresh токен подхватывается сам.
 */
export function voipSocketAuth(cb: (data: Record<string, unknown>) => void): void {
  getAccessToken()
    .then(token => cb(token ? {token} : {}))
    .catch(() => cb({}));
}

export {clearTokens};
