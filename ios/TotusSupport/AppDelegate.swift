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
  private var launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  private var didStartReactNative = false
  /// Must stay alive for the process lifetime. The voip-push library keeps
  /// PKPushRegistry in a local variable, so iOS drops it and incoming pushes never arrive.
  private var voipRegistry: PKPushRegistry?

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

    // PushKit до старта JS, чтобы VoIP-пуш разбудил выгруженное приложение.
    // Registry держим сильной ссылкой: локальный объект библиотеки освобождается сразу.
    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    voipRegistry = registry

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    self.launchOptions = launchOptions

    // UIKit instantiates this class by name from Info.plist. Without a live
    // reference the linker drops it, and iOS 27 then shows an empty window.
    _ = SceneDelegate.self

    return true
  }

  /// Called from SceneDelegate. Xcode 27 / iOS 27 SDK refuses to launch apps that
  /// create a UIWindow from the app delegate instead of a UIWindowScene.
  func startReactNative(in window: UIWindow) {
    guard !didStartReactNative, let factory = reactNativeFactory else { return }
    didStartReactNative = true
    self.window = window
    factory.startReactNative(
      withModuleName: "TotusSupport",
      in: window,
      launchOptions: launchOptions
    )
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

/// Lives in this file so it is compiled with AppDelegate. A separate
/// SceneDelegate.swift was left out of the Xcode build, and UIKit then
/// logged "could not load class TotusSupport.SceneDelegate".
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    window.frame = windowScene.coordinateSpace.bounds
    window.backgroundColor = .systemBackground
    self.window = window
    window.makeKeyAndVisible()
    appDelegate.startReactNative(in: window)

    if let url = connectionOptions.urlContexts.first?.url {
      _ = RCTLinkingManager.application(
        UIApplication.shared,
        open: url,
        options: [:]
      )
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    _ = RCTLinkingManager.application(
      UIApplication.shared,
      open: url,
      options: [:]
    )
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
