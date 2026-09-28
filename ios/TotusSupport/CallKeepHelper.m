#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import "RNCallKeep.h"
#import "CallKeepHelper.h"

// Порт totus_APP/ios/totusClubApp/CallKeepHelper.m (без поиска RCTBridge — он не нужен:
// reportNewIncomingCall — метод класса RNCallKeep и работает в выгруженном приложении).
@implementation CallKeepHelper

+ (void)reportIncomingCall:(NSString *)callId
                    handle:(NSString *)handle
                callerName:(NSString *)callerName
                  hasVideo:(BOOL)hasVideo
                   payload:(NSDictionary *)payload
                completion:(void (^)(void))completion {
    NSString *safeCallId = (callId.length > 0) ? callId : [[NSUUID UUID] UUIDString];
    NSString *safeHandle = (handle.length > 0) ? handle : @"totus";
    NSString *safeName = (callerName.length > 0) ? callerName : @"Входящий звонок";

    // SDP offer большой — в payload CallKit его не передаём (JS получит offer с сервера / из сокета)
    NSMutableDictionary *safePayload = payload ? [payload mutableCopy] : [NSMutableDictionary dictionary];
    [safePayload removeObjectForKey:@"offer"];

    SEL reportSelector = @selector(reportNewIncomingCall:handle:handleType:hasVideo:localizedCallerName:supportsHolding:supportsDTMF:supportsGrouping:supportsUngrouping:fromPushKit:payload:withCompletionHandler:);

    if ([RNCallKeep respondsToSelector:reportSelector]) {
        [RNCallKeep reportNewIncomingCall:safeCallId
                                   handle:safeHandle
                               handleType:@"generic"
                                 hasVideo:hasVideo
                      localizedCallerName:safeName
                          supportsHolding:NO
                             supportsDTMF:NO
                         supportsGrouping:NO
                       supportsUngrouping:NO
                              fromPushKit:YES
                                  payload:safePayload
                    withCompletionHandler:completion];
        NSLog(@"✅ CallKeepHelper: reported incoming call %@", safeCallId);
        return;
    }

    NSLog(@"⚠️ CallKeepHelper: RNCallKeep.reportNewIncomingCall unavailable");
    if (completion) {
        completion();
    }
}

@end
