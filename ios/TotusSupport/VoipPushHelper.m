//
//  VoipPushHelper.m
//  TotusSupport
//
//  Мост делегата PushKit из Swift в react-native-voip-push-notification (из totus_APP).
//

#import "VoipPushHelper.h"
#import "RNVoipPushNotificationManager.h"
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

// APNs-токен обычных пушей (сообщения пользователей сотрудникам, calling_api_v2 lib/staffPush.js).
// Хранится здесь, а не в отдельном файле: новый .m пришлось бы добавлять в проект Xcode.
static NSString *gApnsToken = nil;

@implementation VoipPushHelper

+ (void)didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(PKPushType)type {
    [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:type];
}

+ (void)didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type completion:(void (^)(void))completion {
    NSString *uuid = payload.dictionaryPayload[@"uuid"];
    if (uuid) {
        [RNVoipPushNotificationManager addCompletionHandler:uuid completionHandler:completion];
    }

    [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:type];

    if (!uuid && completion) {
        completion();
    }
}

+ (void)addCompletionHandler:(NSString *)uuid completionHandler:(void (^)(void))completionHandler {
    [RNVoipPushNotificationManager addCompletionHandler:uuid completionHandler:completionHandler];
}

+ (void)setApnsDeviceToken:(NSData *)deviceToken {
    const unsigned char *bytes = (const unsigned char *)deviceToken.bytes;
    NSMutableString *hex = [NSMutableString stringWithCapacity:deviceToken.length * 2];
    for (NSUInteger i = 0; i < deviceToken.length; i++) {
        [hex appendFormat:@"%02x", bytes[i]];
    }
    @synchronized ([VoipPushHelper class]) {
        gApnsToken = [hex copy];
    }
}

@end

// NativeModules.TotusApns — APNs-токен для JS (src/push/remotePush.ts).
@interface TotusApnsModule : NSObject <RCTBridgeModule>
@end

@implementation TotusApnsModule

RCT_EXPORT_MODULE(TotusApns);

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

/// Повторная регистрация (токен мог смениться; iOS вызовет didRegister… снова).
RCT_EXPORT_METHOD(registerForRemote) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [[UIApplication sharedApplication] registerForRemoteNotifications];
    });
}

/// hex-строка токена или null, пока iOS его не выдала.
RCT_REMAP_METHOD(getToken, getTokenWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
    NSString *token = nil;
    @synchronized ([VoipPushHelper class]) {
        token = gApnsToken;
    }
    resolve(token ?: (id)[NSNull null]);
}

@end
