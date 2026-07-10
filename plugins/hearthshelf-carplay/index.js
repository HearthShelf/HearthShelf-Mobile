/**
 * Expo config plugin: wires the native iOS media controller + CarPlay audio
 * surface into the generated ios/ project so it survives `expo prebuild`.
 *
 * The native module intentionally uses the same JS name as Android:
 * `HearthShelfAuto`. PlayerHost can drive one cross-platform native player,
 * while the platform-specific code owns the OS media session.
 */
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

function copySwift(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectName = cfg.modRequest.projectName
      const src = path.join(cfg.modRequest.projectRoot, 'plugins', 'hearthshelf-carplay', 'ios')
      const dest = path.join(cfg.modRequest.platformProjectRoot, projectName)
      fs.mkdirSync(dest, { recursive: true })
      for (const f of [
        'HearthShelfCarPlay.swift',
        'HearthShelfCarPlaySceneDelegate.swift',
        'HearthShelfPhoneSceneDelegate.swift',
        'HearthShelfCarPlayBridge.m',
      ]) {
        fs.copyFileSync(path.join(src, f), path.join(dest, f))
      }
      return cfg
    },
  ])
}

function addSourceFiles(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const projectName = cfg.modRequest.projectName
    const group = project.findPBXGroupKey({ name: projectName })
    for (const file of [
      'HearthShelfCarPlay.swift',
      'HearthShelfCarPlaySceneDelegate.swift',
      'HearthShelfPhoneSceneDelegate.swift',
      'HearthShelfCarPlayBridge.m',
    ]) {
      // copySwift writes these into ios/<projectName>/. Register the Xcode file
      // reference with an explicit SOURCE_ROOT-relative path so Xcode resolves
      // it to ios/<projectName>/<file> deterministically. A bare filename was
      // resolving against ios/ (the project root) instead of the project's
      // source group, so the archive step could not find the file.
      const projectPath = `${projectName}/${file}`
      if (!project.hasFile(projectPath)) {
        project.addSourceFile(
          projectPath,
          { target: project.getFirstTarget().uuid, sourceTree: 'SOURCE_ROOT' },
          group
        )
      }
    }
    return cfg
  })
}

function addInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults
    const modes = new Set([...(plist.UIBackgroundModes || []), 'audio'])
    plist.UIBackgroundModes = Array.from(modes)

    // CoreMotion (CMMotionManager device-motion) drives native shake-to-extend so
    // a shake registers with the phone locked. iOS requires a usage string or the
    // motion API is denied. Only set if absent, so an app.config.js value wins.
    if (!plist.NSMotionUsageDescription) {
      plist.NSMotionUsageDescription =
        'HearthShelf uses motion to let you shake the phone to add time to the sleep timer.'
    }

    // Modern CarPlay (carplay-audio entitlement, iOS 14+) is scene-based. The
    // app must declare a UIApplicationSceneManifest with a CarPlay scene role so
    // the OS knows which delegate class owns the car surface.
    //
    // CRITICAL: declaring ANY UISceneConfigurations opts the WHOLE app into the
    // scene lifecycle. Two hard-won rules (each cost a broken TestFlight build):
    //
    // 1. The phone window role MUST have a real scene delegate that attaches a
    //    window to the scene. Expo's AppDelegate builds the RN window the
    //    pre-scene way (didFinishLaunchingWithOptions) and never scene-attaches
    //    it, and a window role with no delegate leaves the scene empty - either
    //    way the phone launches to a BLACK SCREEN. HearthShelfPhoneSceneDelegate
    //    adopts the AppDelegate's window into the scene.
    //
    // 2. UISceneDelegateClassName must be the RUNTIME class name. These are
    //    plain Swift classes, so their runtime name is module-qualified -
    //    $(PRODUCT_MODULE_NAME).ClassName (Xcode expands the variable at build
    //    time). A bare class name fails NSClassFromString and the scene
    //    delegate silently never instantiates.
    const manifest = plist.UIApplicationSceneManifest || {}
    // Required for the CarPlay scene and the phone scene to run simultaneously.
    manifest.UIApplicationSupportsMultipleScenes = true
    const roles = manifest.UISceneConfigurations || {}
    roles.CPTemplateApplicationSceneSessionRoleApplication = [
      {
        UISceneClassName: 'CPTemplateApplicationScene',
        UISceneConfigurationName: 'HearthShelfCarPlay',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).HearthShelfCarPlaySceneDelegate',
      },
    ]
    roles.UIWindowSceneSessionRoleApplication = [
      {
        UISceneClassName: 'UIWindowScene',
        UISceneConfigurationName: 'HearthShelfPhone',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).HearthShelfPhoneSceneDelegate',
      },
    ]
    manifest.UISceneConfigurations = roles
    plist.UIApplicationSceneManifest = manifest
    return cfg
  })
}

function addCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    // A signed build needs the CarPlay entitlement or the app never appears in
    // the CarPlay app grid. The App ID / provisioning profile has the CarPlay
    // Audio capability enabled, so it signs cleanly. Unsigned simulator/CI builds
    // (CODE_SIGNING_ALLOWED=NO) never validate entitlements, so it's harmless there.
    cfg.modResults['com.apple.developer.carplay-audio'] = true
    return cfg
  })
}

module.exports = function withHearthShelfCarPlay(config) {
  config = copySwift(config)
  config = addSourceFiles(config)
  config = addInfoPlist(config)
  config = addCarPlayEntitlement(config)
  return config
}
