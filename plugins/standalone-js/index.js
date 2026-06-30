/**
 * Expo config plugin: make debug APKs embed their JS bundle instead of loading
 * it from Metro over USB.
 *
 * A normal RN debug build loads JS from the Metro dev server, so the app dies the
 * moment you unplug from the PC - useless for an untethered in-car test or for
 * handing a build to a tester. React Native's gradle plugin only bundles JS for
 * variants listed in `react { debuggableVariants }`; by default that's [debug],
 * which means debug is NOT bundled. Setting it to [] makes the debug variant
 * bundle its JS (while keeping the debug signing key Clerk's assetlinks trusts).
 *
 * This was previously a manual edit to the gitignored android/app/build.gradle
 * (see TESTING.md), lost on every `expo prebuild`. As a config plugin it is
 * reapplied automatically. Gated by env so day-to-day Metro dev is unaffected:
 *   HEARTHSHELF_STANDALONE_DEBUG=1 npx expo prebuild --platform android
 */
const { withAppBuildGradle } = require('expo/config-plugins')

module.exports = function withStandaloneJs(config) {
  if (process.env.HEARTHSHELF_STANDALONE_DEBUG !== '1') return config

  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents

    // Idempotency: only bail if a REAL (uncommented) assignment is already
    // present. The RN template ships a commented `// debuggableVariants = []`
    // example line, so a naive substring check matches that and does nothing -
    // leaving debug unbundled and the APK unable to find its JS at runtime.
    // Require a line where the assignment is the first non-space token.
    if (/^\s*debuggableVariants\s*=/m.test(src)) return cfg

    // Inject a real assignment as the first statement inside the react { } block.
    // (Editing the commented example is brittle; an explicit insert is clearer
    // and survives template wording changes.)
    if (/react\s*\{/.test(src)) {
      src = src.replace(/react\s*\{/, 'react {\n    debuggableVariants = []')
    } else {
      // No react block (unexpected for an RN app); append a minimal one.
      src += '\nreact {\n    debuggableVariants = []\n}\n'
    }

    cfg.modResults.contents = src
    return cfg
  })
}
