const path = require('path')
const { getSentryExpoConfig } = require('@sentry/react-native/metro')

const projectRoot = __dirname
const coreRoot = path.resolve(projectRoot, 'packages/core')

const config = getSentryExpoConfig(projectRoot)

// Keep Metro out of the native build output. android/app/build alone is >1 GB of
// Gradle intermediates and .cxx artifacts; crawling and hashing it on every
// bundle pins a CPU and stalls the bundle partway through. None of it is JS
// source Metro should resolve. Block the build/.cxx/.gradle trees (not all of
// android/ - the config plugin and a few source files legitimately live there).
const nativeBuildBlock = [
  /[\\/]android[\\/]app[\\/]build[\\/].*/,
  /[\\/]android[\\/]app[\\/]\.cxx[\\/].*/,
  /[\\/]android[\\/]\.gradle[\\/].*/,
  /[\\/]android[\\/]build[\\/].*/,
  /[\\/]ios[\\/]build[\\/].*/,
  /[\\/]ios[\\/]Pods[\\/].*/,
]
config.resolver.blockList = Array.isArray(config.resolver.blockList)
  ? [...config.resolver.blockList, ...nativeBuildBlock]
  : config.resolver.blockList
    ? [config.resolver.blockList, ...nativeBuildBlock]
    : nativeBuildBlock

// Watch the submodule source so edits to core rebundle.
config.watchFolders = [...(config.watchFolders || []), coreRoot]

// Map the bare specifier to the source entry, and let deep imports
// (`@hearthshelf/core/lib/...`) fall through to the src tree.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  '@hearthshelf/core': path.resolve(coreRoot, 'src'),
}

// core's relative specifiers carry an explicit .ts extension; make sure Metro
// treats .ts/.tsx as resolvable source (default for Expo, set defensively).
config.resolver.sourceExts = Array.from(new Set([...config.resolver.sourceExts, 'ts', 'tsx']))

// Redirect react-native's deprecated core `PushNotificationIOS` to an inert shim.
// Its real module constructs a NativeEventEmitter with an unlinked native module
// at import time, which crashes when the `react-native` barrel getter is forced by
// wildcard interop (see src/shims/PushNotificationIOS.js for the full story).
const pushNotifShim = path.resolve(projectRoot, 'src/shims/PushNotificationIOS.js')
const upstreamResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (/Libraries[\\/]PushNotificationIOS[\\/]PushNotificationIOS$/.test(moduleName)) {
    return { type: 'sourceFile', filePath: pushNotifShim }
  }
  const resolver = upstreamResolveRequest || context.resolveRequest
  return resolver(context, moduleName, platform)
}

module.exports = config
