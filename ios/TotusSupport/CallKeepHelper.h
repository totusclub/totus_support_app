#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Сообщает CallKit о входящем звонке прямо из PushKit (до запуска JS).
/// iOS завершает приложение, если VoIP-пуш не превратился в CallKit-звонок.
@interface CallKeepHelper : NSObject

+ (void)reportIncomingCall:(NSString *)callId
                    handle:(NSString *)handle
                callerName:(NSString *)callerName
                  hasVideo:(BOOL)hasVideo
                   payload:(NSDictionary *)payload
                completion:(void (^)(void))completion;

@end

NS_ASSUME_NONNULL_END
