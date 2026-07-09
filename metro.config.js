// Metro config: resolve the `@hearthshelf/core` alias to the git-submodule
// TypeScript source at packages/core/src. tsconfig paths handle typecheck/IDE
// only - Metro does not read them, so the bundler alias lives here. Matches the
// dual-consume model documented in packages/core/src/index.ts (bundlers compile
// the .ts source directly; the self-hosted server imports the compiled dist).
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const coreRoot = path.resolve(projectRoot, 'packages/core')

const config = getDefaultConfig(projectRoot)

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
config.resolver.sourceExts = Array.from(
  new Set([...config.resolver.sourceExts, 'ts', 'tsx'])
)

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
