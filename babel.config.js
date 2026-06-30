module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    // react-native-worklets/plugin powers reanimated 4 worklets and MUST be last.
    plugins: ['react-native-worklets/plugin'],
  }
}
