// Локальные уведомления Support App (notifee).
//
// calling_api_v2 не шлёт пуши сотрудникам о новых сообщениях пользователей (хаб уведомлений
// адресован пользователям). Поэтому уведомление о сообщении создаётся на устройстве, пока жив
// сокет чата: приложение открыто или недавно свёрнуто (Android держит JS-процесс дольше).
// Тап по уведомлению открывает диалог (data.chatId).
import notifee, {AndroidImportance, EventType, type Event} from '@notifee/react-native';
import {Platform} from 'react-native';

export const CHANNEL_SUPPORT = 'support_chat';
export const CHANNEL_MISSED = 'missed_calls';

let channelsReady = false;
let pressHandler: ((data: Record<string, string>) => void) | null = null;
let pendingPress: Record<string, string> | null = null;

export async function ensureNotificationChannels(): Promise<void> {
  if (channelsReady) return;
  if (Platform.OS === 'android') {
    await notifee.createChannel({
      id: CHANNEL_SUPPORT,
      name: 'Сообщения пользователей',
      importance: AndroidImportance.HIGH,
      sound: 'default',
    });
    await notifee.createChannel({
      id: CHANNEL_MISSED,
      name: 'Пропущенные звонки',
      importance: AndroidImportance.HIGH,
      sound: 'default',
    });
  }
  channelsReady = true;
}

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const settings = await notifee.requestPermission();
    return (settings.authorizationStatus ?? 0) >= 1;
  } catch {
    return false;
  }
}

export async function showMessageNotification(params: {
  chatId: number;
  title: string;
  body: string;
}): Promise<void> {
  try {
    await ensureNotificationChannels();
    await notifee.displayNotification({
      id: `support-chat-${params.chatId}`,
      title: params.title,
      body: params.body.length > 160 ? `${params.body.slice(0, 160)}…` : params.body,
      data: {chatId: String(params.chatId), route: 'chat'},
      android: {
        channelId: CHANNEL_SUPPORT,
        pressAction: {id: 'default'},
        smallIcon: 'ic_notification',
      },
      ios: {sound: 'default', threadId: `support-chat-${params.chatId}`},
    });
  } catch (e) {
    console.warn('[notify] message notification failed', e);
  }
}

export async function showMissedCallNotification(params: {
  callId: string;
  name: string;
}): Promise<void> {
  try {
    await ensureNotificationChannels();
    await notifee.displayNotification({
      id: `missed-${params.callId}`,
      title: 'Пропущенный звонок',
      body: params.name,
      data: {route: 'calls', callId: params.callId},
      android: {channelId: CHANNEL_MISSED, pressAction: {id: 'default'}, smallIcon: 'ic_notification'},
      ios: {sound: 'default'},
    });
  } catch (e) {
    console.warn('[notify] missed call notification failed', e);
  }
}

export async function cancelChatNotification(chatId: number): Promise<void> {
  try {
    await notifee.cancelNotification(`support-chat-${chatId}`);
  } catch {
    /* ignore */
  }
}

export async function setBadgeCount(n: number): Promise<void> {
  try {
    await notifee.setBadgeCount(Math.max(0, n));
  } catch {
    /* ignore */
  }
}

function handleEvent({type, detail}: Event) {
  if (type !== EventType.PRESS) return;
  const data = (detail.notification?.data || {}) as Record<string, string>;
  if (pressHandler) pressHandler(data);
  else pendingPress = data;
}

/** Фоновые события notifee (index.js): тап, когда приложение свёрнуто/выгружено. */
export async function handleNotifeeBackgroundEvent(event: Event): Promise<void> {
  handleEvent(event);
}

/** Навигация по тапу (регистрирует RootNavigator). */
export function setNotificationPressHandler(handler: ((data: Record<string, string>) => void) | null): void {
  pressHandler = handler;
  if (handler && pendingPress) {
    const data = pendingPress;
    pendingPress = null;
    handler(data);
  }
}

export function subscribeForegroundNotificationEvents(): () => void {
  // Холодный старт по тапу
  notifee
    .getInitialNotification()
    .then(initial => {
      if (initial?.notification?.data) {
        handleEvent({type: EventType.PRESS, detail: {notification: initial.notification}} as Event);
      }
    })
    .catch(() => {});
  return notifee.onForegroundEvent(handleEvent);
}
