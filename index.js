/**
 * @format
 * Точка входа. Фоновые обработчики звонков регистрируются ДО монтирования UI —
 * иначе входящий звонок в закрытое приложение (FCM data-push / CallKeep) не обработается.
 */
import {AppRegistry} from 'react-native';
import notifee from '@notifee/react-native';
import App from './App';
import {name as appName} from './app.json';
import {
  handleBackgroundCallKeepEvent,
  registerAndroidCallBackgroundHandlers,
} from './src/voip/CallService';
import {bootstrapVoipFromStoredSession} from './src/voip/coldStart';
import {handleNotifeeBackgroundEvent} from './src/push/localNotifications';

// Android: FCM data-push «incoming_call» от calling_api_v2 (фон и выгруженное приложение)
registerAndroidCallBackgroundHandlers();

// iOS: VoIP-пуш запустил JS в фоне (закрытое приложение / экран блокировки) —
// поднять движок звонков сразу, чтобы «Ответить» в CallKit соединял без открытия приложения.
bootstrapVoipFromStoredSession();

// Тап по локальному уведомлению (сообщение / пропущенный звонок), когда приложение в фоне
notifee.onBackgroundEvent(handleNotifeeBackgroundEvent);

// Android: headless-задача CallKeep (действия «Ответить» / «Завершить» при выгруженном JS).
// Входящие FCM-пуши обрабатывает setBackgroundMessageHandler выше — здесь их не дублируем.
AppRegistry.registerHeadlessTask('RNCallKeepBackgroundMessage', () => async message => {
  await handleBackgroundCallKeepEvent(message);
});

AppRegistry.registerComponent(appName, () => App);
