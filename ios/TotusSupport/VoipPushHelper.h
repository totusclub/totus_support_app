//
//  VoipPushHelper.h
//  TotusSupport
//
//  Мост делегата PushKit из Swift в react-native-voip-push-notification (Objective-C).
//

#import <Foundation/Foundation.h>
#import <PushKit/PushKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface VoipPushHelper : NSObject

+ (void)didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(PKPushType)type;
+ (void)didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type completion:(void (^)(void))completion;
+ (void)addCompletionHandler:(NSString *)uuid completionHandler:(void (^)(void))completionHandler;
/// APNs-токен обычных (alert) пушей — из AppDelegate didRegisterForRemoteNotificationsWithDeviceToken.
/// JS читает его через NativeModules.TotusApns.getToken() (src/push/remotePush.ts).
+ (void)setApnsDeviceToken:(NSData *)deviceToken;

@end

NS_ASSUME_NONNULL_END
