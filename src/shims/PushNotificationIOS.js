// Shim for react-native's deprecated core `PushNotificationIOS`.
//
// RN 0.85 keeps a `PushNotificationIOS` getter on the `react-native` barrel that,
// when evaluated on iOS, constructs `new NativeEventEmitter(NativePushNotificationManagerIOS)`
// at module top level. That native manager is not linked in this Expo build (we use
// expo-notifications, not RN core push), so the constructor throws the
// "NativeEventEmitter() requires a non-null argument" invariant and takes the app down.
//
// The getter gets evaluated involuntarily: any wildcard interop over the barrel
// (`_interopRequireWildcard`, emitted by Metro for some dynamic `import()`s)
// enumerates every own-enumerable property, invoking the getter as a side effect.
//
// We never use this module, so map it (via metro.config.js resolver) to this inert
// object. Keeping it side-effect-free means forcing the getter is harmless.
const noop = () => {}

module.exports = {
  default: {
    presentLocalNotification: noop,
    scheduleLocalNotification: noop,
    cancelAllLocalNotifications: noop,
    removeAllDeliveredNotifications: noop,
    getDeliveredNotifications: (cb) => cb([]),
    removeDeliveredNotifications: noop,
    setApplicationIconBadgeNumber: noop,
    getApplicationIconBadgeNumber: (cb) => cb(0),
    cancelLocalNotifications: noop,
    getScheduledLocalNotifications: (cb) => cb([]),
    addEventListener: noop,
    removeEventListener: noop,
    requestPermissions: () => Promise.resolve({ alert: false, badge: false, sound: false }),
    abandonPermissions: noop,
    checkPermissions: (cb) => cb({ alert: false, badge: false, sound: false }),
    getInitialNotification: () => Promise.resolve(null),
  },
}
