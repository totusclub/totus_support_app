// Socket.IO-клиент чата поддержки (события support:*) — порт calling_v2/lib/support-chat-socket.ts.
//
// Отдельное соединение с тем же namespace voip.totus.club, что и сигнализация звонков
// (у VoipService свой сокет: registerDevice / offer / answer / …). По agent-JWT сервер
// кладёт этот сокет в комнаты `u:<userId>` и `support:staff`.
// auth задан функцией — токен читается заново при каждом (пере)подключении.
// Отправка сообщений — REST (src/api/supportChat.ts); сокет — доставка, typing и read.
// support:presence — приложение на экране или свёрнуто: на экране сервер не шлёт этому iPhone
// пуш о сообщении (уведомление показывает само приложение), свёрнуто — шлёт (lib/staffPush.js).
import io, {Socket} from 'socket.io-client';
import {AppState, type AppStateStatus} from 'react-native';
import {VOIP_BASE_URL} from '../config/server';
import {ensureFreshAccessToken, getAccessToken, getAccessTokenSync} from '../api/http';
import {getRegisteredPushToken} from '../push/remotePush';
import type {SupportChat, SupportMessage} from '../api/supportChat';

export interface SupportMessageEvent {
  chat: SupportChat;
  message: SupportMessage;
}
export interface SupportChatUpdatedEvent {
  chat: SupportChat;
}
export interface SupportReadEvent {
  chatId: number;
  by: 'user' | 'staff';
  lastMessageId: number | null;
  chat: SupportChat;
}
export interface SupportTypingEvent {
  chatId: number;
  from: 'user' | 'staff';
  typing: boolean;
}

export interface SupportServerEvents {
  'support:message': SupportMessageEvent;
  'support:chat-updated': SupportChatUpdatedEvent;
  'support:read': SupportReadEvent;
  'support:typing': SupportTypingEvent;
  /** Служебное: состояние соединения. */
  'support:connection': boolean;
  /** Статус пользователя (broadcast сервера звонков: io.emit('user-status')). */
  'user-status': {loyaltyId: string; online: boolean};
}

export type SupportServerEventName = keyof SupportServerEvents;
export type SupportClientEventName =
  | 'support:subscribe'
  | 'support:unsubscribe'
  | 'support:typing'
  | 'support:read'
  | 'support:presence';

type Handler<E extends SupportServerEventName> = (payload: SupportServerEvents[E]) => void;

let socket: Socket | null = null;
const handlers: {[E in SupportServerEventName]?: Set<Handler<E>>} = {};
let appStateSub: {remove: () => void} | null = null;

function presenceState(state: AppStateStatus = AppState.currentState): 'foreground' | 'background' {
  return state === 'active' ? 'foreground' : 'background';
}

/** Сообщить серверу, на экране ли приложение (и токен пушей этого iPhone). */
export function updateSupportPresence(state?: AppStateStatus): void {
  if (!socket || !socket.connected) return;
  socket.emit('support:presence', {state: presenceState(state), pushToken: getRegisteredPushToken()});
}

function dispatch<E extends SupportServerEventName>(event: E, payload: SupportServerEvents[E]) {
  const set = handlers[event] as Set<Handler<E>> | undefined;
  if (!set) return;
  set.forEach(h => {
    try {
      h(payload);
    } catch (e) {
      console.error('[support-socket] handler error', event, e);
    }
  });
}

const RELAYED: Exclude<SupportServerEventName, 'support:connection'>[] = [
  'support:message',
  'support:chat-updated',
  'support:read',
  'support:typing',
  'user-status',
];

/** Подключить сокет чата (идемпотентно). Без токена ничего не делает. */
export function connectSupportSocket(): Socket | null {
  if (socket) {
    if (!socket.connected) socket.connect();
    return socket;
  }
  if (!getAccessTokenSync()) return null;

  socket = io(VOIP_BASE_URL, {
    transports: ['websocket'],
    // Токен обновляется перед каждым (пере)подключением: комнаты support:staff / u:<id>
    // сервер выдаёт только при валидном JWT в handshake.
    auth: cb => {
      ensureFreshAccessToken()
        .catch(() => false)
        .then(() => getAccessToken())
        .then(token => cb(token ? {token} : {}))
        .catch(() => cb({}));
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  socket.on('connect', () => {
    updateSupportPresence();
    dispatch('support:connection', true);
  });
  if (!appStateSub) {
    // Свернули / заблокировали экран — сразу «background», чтобы сервер начал слать пуши
    appStateSub = AppState.addEventListener('change', s => updateSupportPresence(s));
  }
  socket.on('disconnect', () => dispatch('support:connection', false));
  socket.on('connect_error', (e: Error) => {
    console.warn('[support-socket] connect_error', e?.message);
    // Отказ middleware (AUTH_MODE=enforce, протухший токен) socket.io сам не повторяет —
    // переподключаемся вручную с паузой (auth-колбэк возьмёт свежий токен).
    const s0 = socket;
    if (s0 && !s0.active) {
      setTimeout(() => {
        if (socket === s0 && !s0.connected) s0.connect();
      }, 5000);
    }
  });
  RELAYED.forEach(event => {
    socket?.on(event, (payload: any) => dispatch(event, payload));
  });
  return socket;
}

/** Отключить и забыть сокет (выход). Подписчики остаются. */
export function disconnectSupportSocket(): void {
  if (!socket) return;
  appStateSub?.remove();
  appStateSub = null;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  dispatch('support:connection', false);
}

export function isSupportSocketConnected(): boolean {
  return !!socket && socket.connected;
}

export function onSupportEvent<E extends SupportServerEventName>(event: E, handler: Handler<E>): () => void {
  let set = handlers[event] as Set<Handler<E>> | undefined;
  if (!set) {
    set = new Set<Handler<E>>();
    (handlers as any)[event] = set;
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}

/** Отправить событие серверу (с необязательным ack). Без соединения — тихо пропускает. */
export function emitSupport(
  event: SupportClientEventName,
  payload: Record<string, unknown>,
  ack?: (result: any) => void,
): boolean {
  if (!socket || !socket.connected) return false;
  if (ack) socket.emit(event, payload, ack);
  else socket.emit(event, payload);
  return true;
}
