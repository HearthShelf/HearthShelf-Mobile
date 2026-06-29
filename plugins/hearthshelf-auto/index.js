/**
 * Expo config plugin: wires the native Android Auto (MediaLibraryService) car
 * surface into the generated android/ project so it survives `expo prebuild`.
 *
 * It:
 *  1. copies the Kotlin service + bridge module into the app package,
 *  2. declares the MediaLibraryService in AndroidManifest with category.MEDIA
 *     (so Android Auto lists HearthShelf as a media app),
 *  3. adds the media3 + guava deps the service needs,
 *  4. registers the Expo native module package.
 */
const {
  withAndroidManifest,
  withAppBuildGradle,
  withMainApplication,
  withDangerousMod,
  AndroidConfig,
} = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

const PKG = 'com.hearthshelf.mobile'
const SERVICE = `${PKG}.HearthShelfAutoService`

function copyKotlin(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'plugins', 'hearthshelf-auto', 'android')
      const dest = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...PKG.split('.')
      )
      fs.mkdirSync(dest, { recursive: true })
      for (const f of ['HearthShelfAutoService.kt', 'HearthShelfAutoModule.kt']) {
        fs.copyFileSync(path.join(src, f), path.join(dest, f))
      }
      // The automotive_app_desc declares HearthShelf to Android Auto as MEDIA.
      const resXml = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'res', 'xml'
      )
      fs.mkdirSync(resXml, { recursive: true })
      fs.copyFileSync(
        path.join(src, 'automotive_app_desc.xml'),
        path.join(resXml, 'automotive_app_desc.xml')
      )
      return cfg
    },
  ])
}

function addManifestService(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults)
    app.service = app.service || []
    const already = app.service.find(
      (s) => s.$ && s.$['android:name'] === SERVICE
    )
    if (!already) {
      app.service.push({
        $: {
          'android:name': SERVICE,
          'android:exported': 'true',
          'android:foregroundServiceType': 'mediaPlayback',
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'androidx.media3.session.MediaLibraryService' } },
              { $: { 'android:name': 'androidx.media3.session.MediaSessionService' } },
              { $: { 'android:name': 'android.media.browse.MediaBrowserService' } },
            ],
          },
        ],
      })
    }

    // The car.application meta-data + automotive_app_desc is what makes Android
    // Auto actually LIST the app (a discoverable MediaBrowserService alone is not
    // enough). Without it the app never appears in the AA launcher.
    app['meta-data'] = app['meta-data'] || []
    const hasCarMeta = app['meta-data'].find(
      (m) => m.$ && m.$['android:name'] === 'com.google.android.gms.car.application'
    )
    if (!hasCarMeta) {
      app['meta-data'].push({
        $: {
          'android:name': 'com.google.android.gms.car.application',
          'android:resource': '@xml/automotive_app_desc',
        },
      })
    }
    return cfg
  })
}

function addGradleDeps(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes('androidx.media3:media3-session')) return cfg
    const dep = `
dependencies {
    implementation "androidx.media3:media3-session:1.4.1"
    implementation "androidx.media3:media3-exoplayer:1.4.1"
    implementation "com.google.guava:guava:33.3.1-android"
}
`
    cfg.modResults.contents += dep
    return cfg
  })
}

function registerPackage(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents
    if (src.includes('HearthShelfAutoPackage()')) return cfg
    // Inject into the `packages.apply { ... }` block where the template leaves
    // a hint comment for custom packages.
    src = src.replace(
      /(PackageList\(this\)\.packages\.apply\s*\{)/,
      `$1\n          add(HearthShelfAutoPackage())`
    )
    cfg.modResults.contents = src
    return cfg
  })
}

module.exports = function withHearthShelfAuto(config) {
  config = copyKotlin(config)
  config = addManifestService(config)
  config = addGradleDeps(config)
  config = registerPackage(config)
  return config
}
