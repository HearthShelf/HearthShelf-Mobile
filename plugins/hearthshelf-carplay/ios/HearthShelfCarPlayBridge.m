#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(HearthShelfAuto, RCTEventEmitter)

RCT_EXTERN_METHOD(setSession:(NSString *)serverUrl
                  token:(NSString *)token
                  skipBackSec:(nonnull NSNumber *)skipBackSec
                  skipForwardSec:(nonnull NSNumber *)skipForwardSec)
RCT_EXTERN_METHOD(setDiscover:(NSString *)json)
RCT_EXTERN_METHOD(setNotePopsEnabled:(BOOL)enabled)
RCT_EXTERN_METHOD(setSleepShake:(BOOL)enabled
                  minutes:(nonnull NSNumber *)minutes
                  timerActive:(BOOL)timerActive
                  hapticLevel:(NSString *)hapticLevel)
RCT_EXTERN_METHOD(clearSession)

RCT_EXTERN_METHOD(load:(NSString *)url
                  startSec:(nonnull NSNumber *)startSec
                  title:(NSString *)title
                  author:(NSString *)author
                  artworkUri:(NSString *)artworkUri
                  chaptersJson:(NSString *)chaptersJson
                  autoPlay:(BOOL)autoPlay)
RCT_EXTERN_METHOD(play)
RCT_EXTERN_METHOD(pause)
RCT_EXTERN_METHOD(seekTo:(nonnull NSNumber *)sec)
RCT_EXTERN_METHOD(setRate:(nonnull NSNumber *)rate)
RCT_EXTERN_METHOD(setVolume:(nonnull NSNumber *)volume)
RCT_EXTERN_METHOD(stop)

@end
