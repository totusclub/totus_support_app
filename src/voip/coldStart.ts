// iOS: запуск VoIP-движка сразу при старте JS, без ожидания экрана.
//
// Когда VoIP-пуш будит закрытое приложение, AppDelegate запускает React Native в фоне
// (без окна: телефон может быть заблокирован, приложение никто не открывал).
// Здесь движок звонков поднимается из сохранённой сессии агента до монтирования UI,
// чтобы ответ в CallKit («Ответить» на экране блокировки) сразу соединял звонок.
// AuthContext позже вызовет initCallKeep() — движок уже поднят, сработает resumeVoipAfterLogin.
import {Platform} from 'react-native';
import {restoreSession} from '../api/auth';
import {initVoipAndCallKeep, isVoipEngineInitialized} from './VoipService';

let started = false;

export async function bootstrapVoipFromStoredSession(): Promise<void> {
  // Android будится своим путём (FCM data-push + headless-задача CallKeep в index.js).
  if (Platform.OS !== 'ios' || started || isVoipEngineInitialized()) {
    return;
  }
  started = true;
  try {
    const user = await restoreSession(); // AsyncStorage: доступен на экране блокировки после первой разблокировки
    const loyaltyId = user?.loyaltyId || (user as any)?.loyalty_id;
    if (!loyaltyId) {
      return; // не вошёл — звонки не принимаем (как и раньше)
    }
    if (!isVoipEngineInitialized()) {
      initVoipAndCallKeep(String(loyaltyId));
    }
  } catch (e) {
    started = false;
    console.warn('[voip] cold-start bootstrap failed', e);
  }
}
