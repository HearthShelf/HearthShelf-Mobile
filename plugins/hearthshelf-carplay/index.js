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

    // Modern CarPlay (carplay-audio entitlement, iOS 14+) is scene-based. The
    // app must declare a UIApplicationSceneManifest with a CarPlay scene role so
    // the OS knows which delegate class owns the car surface.
    //
    // CRITICAL: declaring ANY UISceneConfigurations opts the WHOLE app into the
    // scene lifecycle, so iOS also requires a UIWindowSceneSessionRoleApplication
    // (the phone window) role - otherwise it never creates a window and the phone
    // launches to a BLACK SCREEN (expo's AppDelegate window path is ignored once
    // a scene manifest exists). So we declare BOTH roles. The phone window role
    // carries NO custom UISceneDelegateClassName, so UIKit uses the default
    // UIWindowScene and expo's AppDelegate still drives the phone UI; only the
    // CarPlay role is delegate-managed.
    const manifest = plist.UIApplicationSceneManifest || {}
    manifest.UIApplicationSupportsMultipleScenes = true
    const roles = manifest.UISceneConfigurations || {}
    roles.CPTemplateApplicationSceneSessionRoleApplication = [
      {
        UISceneClassName: 'CPTemplateApplicationScene',
        UISceneConfigurationName: 'HearthShelfCarPlay',
        UISceneDelegateClassName: 'HearthShelfCarPlaySceneDelegate',
      },
    ]
    roles.UIWindowSceneSessionRoleApplication = [
      {
        UISceneClassName: 'UIWindowScene',
        UISceneConfigurationName: 'HearthShelfPhone',
      },
    ]
    manifest.UISceneConfigurations = roles
    plist.UIApplicationSceneManifest = manifest
    return cfg
  })
}

function addCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    if (process.env.HEARTHSHELF_IOS_CARPLAY_ENTITLEMENT === '1') {
      cfg.modResults['com.apple.developer.carplay-audio'] = true
    }
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
