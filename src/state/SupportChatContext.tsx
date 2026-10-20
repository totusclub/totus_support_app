// Глобальное состояние чата поддержки — порт calling_v2/components/SupportChatProvider.tsx:
// счётчик непрочитанного (бейдж вкладки и иконки приложения), состояние сокета,
// уведомление о новом сообщении пользователя, когда диалог не открыт или приложение свёрнуто.
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {AppState} from 'react-native';
import {chatUserName, getSummary, type SupportSummary} from '../api/supportChat';
import {isSupportSocketConnected, onSupportEvent} from '../realtime/supportSocket';
import {setBadgeCount, showMessageNotification, cancelChatNotification} from '../push/localNotifications';
import {isRemotePushActive} from '../push/remotePush';
import {useAuth} from './AuthContext';

const SUMMARY_POLL_MS = 30_000;
const NOTIFY_THROTTLE_MS = 3_000;

interface SupportChatContextValue {
  summary: SupportSummary | null;
  unreadTotal: number;
  connected: boolean;
  refreshSummary: () => Promise<void>;
  /** Открытый сейчас диалог (ChatScreen) — по нему не показываем уведомления. */
  setActiveChatId: (id: number | null) => void;
}

const Ctx = createContext<SupportChatContextValue>({
  summary: null,
  unreadTotal: 0,
  connected: false,
  refreshSummary: async () => {},
  setActiveChatId: () => {},
});

export function useSupportChat(): SupportChatContextValue {
  return useContext(Ctx);
}

export function SupportChatProvider({children}: {children: React.ReactNode}) {
  const {status} = useAuth();
  const signedIn = status === 'signedIn';
  const [summary, setSummary] = useState<SupportSummary | null>(null);
  const [connected, setConnected] = useState(false);
  const activeChatRef = useRef<number | null>(null);
  const lastNotifyRef = useRef(0);

  const refreshSummary = useCallback(async () => {
    try {
      const s = await getSummary();
      setSummary(s);
      setBadgeCount(s.unreadTotal || 0).catch(() => {});
    } catch {
      /* 503 до миграции / сеть — оставляем прежнее значение */
    }
  }, []);

  const setActiveChatId = useCallback((id: number | null) => {
    activeChatRef.current = id;
    if (id) cancelChatNotification(id).catch(() => {});
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setSummary(null);
      setConnected(false);
      return;
    }
    setConnected(isSupportSocketConnected());
    refreshSummary();

    const offConn = onSupportEvent('support:connection', ok => {
      setConnected(ok);
      if (ok) refreshSummary();
    });

    const offMessage = onSupportEvent('support:message', ({chat, message}) => {
      if (message.senderRole !== 'user') return;
      refreshSummary();
      const appActive = AppState.currentState === 'active';
      const viewing = appActive && activeChatRef.current === chat.id;
      if (viewing) return;
      // Свёрнуто, а сервер шлёт пуши этому iPhone — второе (локальное) уведомление не нужно
      if (!appActive && isRemotePushActive()) return;
      const now = Date.now();
      if (now - lastNotifyRef.current < NOTIFY_THROTTLE_MS && appActive) return;
      lastNotifyRef.current = now;
      showMessageNotification({chatId: chat.id, title: chatUserName(chat), body: message.body}).catch(
        () => {},
      );
    });

    const offUpdated = onSupportEvent('support:chat-updated', () => refreshSummary());
    const offRead = onSupportEvent('support:read', ({by}) => {
      if (by === 'staff') refreshSummary();
    });

    const timer = setInterval(refreshSummary, SUMMARY_POLL_MS);
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') refreshSummary();
    });

    return () => {
      offConn();
      offMessage();
      offUpdated();
      offRead();
      clearInterval(timer);
      sub.remove();
    };
  }, [signedIn, refreshSummary]);

  const value = useMemo<SupportChatContextValue>(
    () => ({
      summary,
      unreadTotal: summary?.unreadTotal || 0,
      connected,
      refreshSummary,
      setActiveChatId,
    }),
    [summary, connected, refreshSummary, setActiveChatId],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
