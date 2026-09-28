# Totus Support

Мобильное приложение службы поддержки Totus Club (React Native 0.79, iOS + Android).
Сотрудник поддержки (учётная запись с ролью `agent`) видит пользователей, их диалоги и звонки, отвечает в реальном времени и звонит пользователям.

Референсы:

- `tosmedia/calling_v2` — панель агента (Next.js). Из неё перенесена логика поддержки: вход агента, Support Chat (REST + Socket.IO), список пользователей, звонок по loyalty ID, карточка звонка, проверка STUN/TURN.
- `tosmedia/totus_APP` — клиентское RN-приложение. Из него перенесён VoIP-движок: WebRTC, CallKeep, PushKit/FCM, InCallManager.

Backend один — **calling_api_v2** (`https://voip.totus.club`). Протокол не менялся, моков нет.

## Возможности

| Раздел | Что умеет | Backend |
|---|---|---|
| **Вход** | e-mail + пароль агента, agent-JWT (12 ч) + refresh (30 д), автообновление токена, выход при истёкшей сессии | `POST /api/web/login`, `POST api.totus.club/api/auth/refresh` |
| **Чаты** | список диалогов: непрочитанные первыми; фильтры «Все / Ждут ответа / Ждут пользователя / Мои / Закрытые»; поиск по имени, e-mail, телефону, ID; бесконечная прокрутка; pull-to-refresh; онлайн-статус | `GET /api/support/chats`, `GET /api/support/summary` |
| **Диалог** | история с подгрузкой вверх, разделители по дням, «печатает…», отметки «прочитано», карточка заказа из `meta`, ответ с `clientMsgId` (без дублей), «Позвонить», «Взять себе / Снять», «Закрыть / Открыть заново» | `/api/support/chats/:id*`; сокет `support:*` |
| **Real-time** | `support:message`, `support:chat-updated`, `support:read`, `support:typing`, `user-status`; фолбэк-поллинг (список 30 с, диалог 10 с) | Socket.IO, комнаты `support:staff`, `chat:<id>` |
| **Пользователи** | все пользователи платформы, онлайн / VoIP, звонок, переход в диалог, «Доступ / Заблок.» | `GET /api/users`, `PATCH /api/users/:id/access` |
| **Звонки** | исходящие по loyalty ID, входящие (приложение открыто, в фоне или закрыто), экран звонка: микрофон, динамик, таймер; свёрнутая плашка; CallKit (iOS) / ConnectionService (Android) | `/api/register-device`, `/api/calls*`, `/api/ice-servers`, сокет `offer / answer / ice-candidate / call-state`, VoIP-push (APNs) / FCM data-push |
| **История звонков** | входящие, исходящие, пропущенные, отклонённые; длительность; «перезвонить»; переход в диалог | журнал на устройстве (см. ниже) |
| **Профиль** | карточка агента, состояние подключений, сводка, проверка STUN/TURN, настройки батареи и уведомлений, выход | `GET /api/ice-servers` |
| **Уведомления** | локальные уведомления о новом сообщении пользователя и о пропущенном звонке, бейдж непрочитанных на иконке | notifee |

Тема оформления (светлая или тёмная) следует системной. Токены цветов — из дизайн-системы TOTUS (`calling_v2/app/globals.css`).

## Структура

```
index.js                     фоновые обработчики звонков (FCM, CallKeep headless) + регистрация App
App.tsx                      провайдеры: Auth → SupportChat → Call → навигация
src/config/server.ts         VOIP_BASE_URL, API_BASE_URL, ADMIN_BASE_URL
src/api/                     http (JWT + refresh), auth, users, supportChat, calls, voipAuth
src/realtime/supportSocket.ts  Socket.IO чата поддержки (порт calling_v2)
src/voip/VoipService.ts      VoIP-движок (порт totus_APP): WebRTC, CallKeep, PushKit, FCM, сигнализация
src/voip/CallService.ts      вход для фоновых FCM/CallKeep-событий Android
src/voip/diagnostics.ts      проверка STUN/TURN
src/state/                   AuthContext, SupportChatContext, CallContext (+ журнал звонков)
src/history/callHistory.ts   история звонков (AsyncStorage, по агенту)
src/push/localNotifications.ts  notifee: каналы, уведомления, тапы
src/screens/                 Login, Chats, Chat, Users, Calls, Profile
src/components/              Icon, ui, CallOverlay
ios/TotusSupport/            AppDelegate (PushKit → CallKit), CallKeepHelper, VoipPushHelper
android/                     ConnectionService CallKeep, разрешения, адаптивная иконка
```

## Запуск

Требования: Node ≥ 18, JDK 17, Android Studio (SDK 35), Xcode 16 + CocoaPods.

```bash
npm install                 # postinstall создаст gradlew / gradle-wrapper.jar / debug.keystore
cd ios && bundle install && bundle exec pod install && cd ..
npm run typecheck
npm test
npm run android             # или npm run ios
```

### Firebase

На Android FCM нужен обязательно: по нему приходят входящие звонки, когда приложение в фоне или закрыто. В **том же Firebase-проекте**, что и Totus Club, добавьте Android-приложение `club.totus.support` и положите файл `google-services.json` в `android/app/`.

- Без этого файла Android-сборка не пройдёт. FCM-токен служит deviceId устройства в calling_api_v2 — так же, как в totus_APP: без него нельзя ни позвонить, ни принять звонок.
- Backend шлёт FCM через Firebase Admin SDK того же проекта (`FIREBASE_CREDENTIALS_PATH`), поэтому менять calling_api_v2 для Android не нужно.

На iOS Firebase не обязателен: звонки идут через PushKit, чат — через сокет. Если позже понадобится FCM, добавьте iOS-приложение `club.totus.support` в Firebase и перетащите `GoogleService-Info.plist` в Xcode (target TotusSupport). AppDelegate инициализирует Firebase, только если этот файл есть.

### Apple (iOS)

1. App ID `club.totus.support` (Team `C6258722D6`, как у Totus Club). Включить Push Notifications и Background Modes: Voice over IP, Audio, Remote notifications.
2. APNs-ключ `.p8` общий для команды — новый ключ не нужен.
3. VoIP-пуши: calling_api_v2 должен отправлять их с topic `club.totus.support.voip`. Это делает **PR calling_api_v2 #7** (`lib/apnTopics.js`): пока его не смержили, iOS-приложение принимает звонки, только когда открыто или недавно свёрнуто (по сокету).
4. Debug-сборки получают sandbox-токен, а сервер работает с `APN_PRODUCTION=1`. Поэтому VoIP-пуши в закрытое приложение проверять на TestFlight-сборке — так же, как у клиентского приложения.

### Android

- `minSdk 26` (Android 8.0), новая архитектура выключена, как в totus_APP. Причина: callkeep, incall-manager и webrtc работают через bridge.
- Для релизной подписи создайте `android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`). Файл в git не попадает.
- На устройстве сотрудника: разрешить уведомления, отключить оптимизацию батареи (кнопка в «Профиле») и включить аккаунт звонков Totus Support, если система спросит.

## Как устроены звонки

Протокол совпадает с calling_v2 и totus_APP:

1. **Регистрация.** После входа `initVoipAndCallKeep(loyaltyId агента)`:
   - iOS отправляет PushKit-токен, Android — FCM-токен: `POST /api/register-device {deviceId: токен, voipToken: токен, loyaltyId, platform}`;
   - по сокету уходит `registerDevice`.
2. **Исходящий.** Создаётся локальный offer, затем `POST /api/calls {callId, toLoyaltyId, fromDeviceId, fromLoyaltyId, offer}`. Сервер будит пользователя VoIP-пушем или FCM, либо отправляет offer в его сокет. Ответ приходит в сокет (`answer`), а если сокета нет — HTTP-поллингом `GET /api/calls/:id`. ICE идёт через `POST /api/calls/:id/candidate` и сокет.
3. **Входящий.** Пользователь звонит в поддержку по loyalty ID аккаунта поддержки (в totus_APP это `SUPPORT_LOYALTY_ID`). Сервер присылает:
   - `offer` + `call-state: ringing` в сокет;
   - на iOS VoIP-пуш: AppDelegate сразу показывает CallKit;
   - на Android FCM `incoming_call`: CallKeep показывает системный экран.

   После ответа создаётся answer, затем `POST /api/calls/:id/answer` и `answer` в сокет.
4. **Завершение.** `POST /api/calls/:id/end` (или `/reject`), собеседнику уходит `call-state: ended`. Если агент звонил пользователю и тот не ответил, хаб уведомлений сам отправит ему `missed_call`.

## Важно знать (ограничения backend)

- **Одно устройство на учётную запись.** calling_api_v2 хранит у пользователя один `voipToken` и один `socketId`. Звонки получает устройство, которое зарегистрировалось последним. Поэтому для приложения лучше завести отдельную agent-учётку на каждого сотрудника, а учётку, на которую звонят из клиентского приложения (`SUPPORT_LOYALTY_ID`), держать на том устройстве, которое должно принимать входящие. Если та же учётка открыта в веб-панели calling_v2, веб-панель перезапишет токен при входе.
- **Выход из приложения** вызывает `POST /api/unregister-device`: сервер очищает токен учётки, и она перестаёт получать звонки на это устройство. Так же ведёт себя totus_APP.
- **Пуши о сообщениях сотрудникам backend не отправляет.** Хаб уведомлений адресован пользователям. Приложение показывает локальное уведомление, пока жив сокет: приложение открыто или недавно свёрнуто. Звонки приходят и в закрытое приложение.
- **История звонков хранится на устройстве.** Backend держит звонки только в памяти (`Map calls`) и журнал не отдаёт — ни calling_v2, ни totus_APP истории с сервера не получают. Каждая запись — реальный звонок через VoIP-движок. Номер собеседника берётся из `GET /api/calls/:id`.
- **Диалог создаёт пользователь.** API поддержки не позволяет сотруднику начать диалог первым: `support_chats` создаётся при первом обращении пользователя. Пользователю без диалога можно позвонить.

## Проверки

- `npm run typecheck` — TypeScript (strict).
- `npm test` — юнит-тесты утилит (`__tests__/`).
- Ручной сценарий:
  1. Вход агентом → «Чаты»: видны диалоги.
  2. Из клиентского приложения пользователь пишет в поддержку → сообщение появляется сразу, работает «печатает…».
  3. Ответ → у пользователя сообщение и отметка прочтения.
  4. «Позвонить» → звонок в клиентском приложении.
  5. Пользователь звонит в поддержку при свёрнутом или закрытом Support → CallKit / системный экран → разговор.
  6. «Звонки» → записи с длительностью.
