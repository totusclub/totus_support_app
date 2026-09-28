import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import PushKit
import FirebaseCore
import FirebaseMessaging

/// Totus Support — AppDelegate.
/// VoIP-часть перенесена из totus_APP (AppDelegate.swift): PushKit-пуш от calling_api_v2 сразу
/// превращается в CallKit-звонок (CallKeepHelper), затем JS (VoipService) подключает WebRTC.
@main
class AppDelegate: UIResponder, UIApplicationDelegate, PKPushRegistryDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Firebase на iOS нужен только для FCM-уведомлений; без GoogleService-Info.plist
    // приложение работает (звонки идут через PushKit, чат — через сокет).
    if FirebaseApp.app() == nil,
       Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
      FirebaseApp.configure()
    }

    // Регистрация PushKit при запуске — обязательна, чтобы VoIP-пуш дошёл до выгруженного
    // приложения ещё до старта JS (react-native-voip-push-notification: delegate = AppDelegate).
    RNVoipPushNotificationManager.voipRegistration()

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "TotusSupport",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  // MARK: - Links

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return RCTLinkingManager.application(app, open: url, options: options)
  }

  // MARK: - APNs (FCM)

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    if FirebaseApp.app() != nil {
      Messaging.messaging().setAPNSToken(deviceToken, type: .unknown)
    }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    print("❌ APNs registration failed: \(error.localizedDescription)")
  }

  // MARK: - PKPushRegistryDelegate

  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    // Токен уходит в JS (VoipService → POST /api/register-device, platform=ios)
    VoipPushHelper.didUpdate(pushCredentials, forType: type)
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    // Payload calling_api_v2 (index.js, POST /api/calls):
    // { callId, uuid, handle, callerName, caller_name, from, toLoyaltyId, offer }
    let dict = (payload.dictionaryPayload as? [String: Any]) ?? [:]

    let callId = (dict["callId"] as? String)
      ?? (dict["uuid"] as? String)
      ?? (dict["callUUID"] as? String)
      ?? UUID().uuidString
    let handle = (dict["handle"] as? String)
      ?? (dict["from"] as? String)
      ?? callId
    let callerName = (dict["callerName"] as? String)
      ?? (dict["caller_name"] as? String)
      ?? "Входящий звонок"

    // Отдать пуш библиотеке (событие 'notification' в JS: VoipService кэширует offer)
    VoipPushHelper.didReceiveIncomingPush(with: payload, forType: type) {}

    // Всегда сообщаем CallKit до completion — иначе iOS завершит процесс.
    CallKeepHelper.reportIncomingCall(
      callId,
      handle: handle,
      callerName: callerName,
      hasVideo: false,
      payload: dict
    ) {
      completion()
    }
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    print("📱 PKPushRegistry: VoIP token invalidated — iOS перерегистрирует автоматически")
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
