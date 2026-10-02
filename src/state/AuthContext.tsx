// Сессия сотрудника поддержки: вход (agent), восстановление при запуске, выход.
// После входа поднимаются VoIP (CallKeep + регистрация устройства на calling_api_v2)
// и сокет чата поддержки.
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {AppState} from 'react-native';
import {
  type AgentUser,
  clearSession,
  login as apiLogin,
  restoreSession,
} from '../api/auth';
import {ensureFreshAccessToken, loadTokens, setSessionExpiredHandler} from '../api/http';
import {initCallKeep} from '../voip/CallService';
import {cleanupVoipOnLogout} from '../voip/VoipService';
import {cancelMicPermissionRequest, ensureMicPermissionWhenActive} from '../voip/micPermission';
import {connectSupportSocket, disconnectSupportSocket} from '../realtime/supportSocket';
import {setHistoryOwner} from '../history/callHistory';
import {
  ensureNotificationChannels,
  requestNotificationPermission,
  setBadgeCount,
} from '../push/localNotifications';

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: AuthStatus;
  user: AgentUser | null;
  /** Причина последнего выхода (истёкшая сессия) — показывается на экране входа. */
  notice: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  status: 'loading',
  user: null,
  notice: null,
  login: async () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

async function startServices(user: AgentUser) {
  setHistoryOwner(user.id);
  // Сокеты получают комнаты только при живом токене — обновляем его до подключения
  await ensureFreshAccessToken().catch(() => false);
  const loyaltyId = user.loyaltyId || (user as any).loyalty_id;
  if (loyaltyId) {
    initCallKeep(loyaltyId).catch(e => console.warn('[auth] initCallKeep failed', e));
  } else {
    console.warn('[auth] у агента нет loyaltyId — звонки недоступны');
  }
  connectSupportSocket();
  ensureNotificationChannels().catch(() => {});
  requestNotificationPermission().catch(() => {});
  // iOS: доступ к микрофону заранее, пока приложение на экране — иначе первый ответ
  // на звонок из CallKit / с экрана блокировки сбрасывается (нельзя показать запрос)
  ensureMicPermissionWhenActive();
}

export function AuthProvider({children}: {children: React.ReactNode}) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AgentUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const userRef = useRef<AgentUser | null>(null);
  userRef.current = user;

  const loggingOut = useRef(false);

  const logout = useCallback(async (reason?: string) => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    cancelMicPermissionRequest();
    try {
      await cleanupVoipOnLogout();
    } catch (e) {
      console.warn('[auth] cleanupVoipOnLogout failed', e);
    }
    disconnectSupportSocket();
    await clearSession();
    setBadgeCount(0).catch(() => {});
    setHistoryOwner(null);
    setUser(null);
    setNotice(reason || null);
    setStatus('signedOut');
    loggingOut.current = false;
  }, []);

  // Восстановление сессии при запуске (в т.ч. холодный старт из VoIP-пуша)
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadTokens();
      const restored = await restoreSession();
      if (!alive) return;
      if (restored) {
        setUser(restored);
        setStatus('signedIn');
        startServices(restored).catch(e => console.warn('[auth] startServices failed', e));
      } else {
        setStatus('signedOut');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // refresh не удался → выход с пояснением
  useEffect(() => {
    setSessionExpiredHandler(() => {
      if (userRef.current) {
        logout('Сессия истекла. Войдите снова').catch(() => {});
      }
    });
    return () => setSessionExpiredHandler(null);
  }, [logout]);

  // Возврат в приложение: обновить токен (если истекает) и переподключить сокет чата
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active' || !userRef.current) return;
      ensureFreshAccessToken()
        .catch(() => false)
        .then(refreshed => {
          if (!userRef.current) return;
          if (refreshed) disconnectSupportSocket(); // новое соединение уйдёт с новым токеном
          connectSupportSocket();
        });
    });
    // Длинная смена: освежать токен заранее, пока приложение открыто
    const timer = setInterval(() => {
      if (!userRef.current || AppState.currentState !== 'active') return;
      ensureFreshAccessToken(900)
        .catch(() => false)
        .then(refreshed => {
          if (refreshed && userRef.current) {
            disconnectSupportSocket();
            connectSupportSocket();
          }
        });
    }, 10 * 60 * 1000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const u = await apiLogin(email, password);
    setUser(u);
    setNotice(null);
    setStatus('signedIn');
    startServices(u).catch(e => console.warn('[auth] startServices failed', e));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({status, user, notice, login, logout: () => logout()}),
    [status, user, notice, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
