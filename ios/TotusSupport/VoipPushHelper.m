//
//  VoipPushHelper.m
//  TotusSupport
//
//  Мост делегата PushKit из Swift в react-native-voip-push-notification (из totus_APP).
//

#import "VoipPushHelper.h"
#import "RNVoipPushNotificationManager.h"

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

@end
