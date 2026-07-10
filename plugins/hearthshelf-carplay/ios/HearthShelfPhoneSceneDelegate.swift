import Foundation
import React
import UIKit

/// Phone window scene delegate.
///
/// Declaring a UIApplicationSceneManifest (required for the CarPlay scene) opts
/// the ENTIRE app into the UIScene lifecycle. Expo's generated AppDelegate is
/// pre-scene: it builds the React Native window in didFinishLaunchingWithOptions
/// and never attaches it to a scene. Under the scene lifecycle a window with no
/// windowScene is never rendered - the phone launches to a black screen. A
/// window role WITHOUT a delegate does not fix this either: UIKit creates the
/// UIWindowScene but nobody attaches a window to it (verified on TestFlight).
///
/// This delegate bridges the two worlds: didFinishLaunchingWithOptions always
/// runs before the first scene connects, so Expo's fully-built window already
/// exists - we adopt it into the connecting scene and make it key.
///
/// It also forwards URL opens and universal links: under the scene lifecycle
/// UIKit delivers those to the scene delegate, NOT the AppDelegate methods that
/// Expo/React Native wire up (application(_:open:options:) and
/// application(_:continue:restorationHandler:) stop being called).
final class HearthShelfPhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard session.role == .windowApplication, let windowScene = scene as? UIWindowScene else {
      return
    }

    // Adopt the React Native window Expo's AppDelegate already created. The
    // windowScene == nil guard keeps a second window scene (iPad multi-window)
    // from stealing the window that the first scene owns.
    if let appWindow = UIApplication.shared.delegate?.window ?? nil,
      appWindow.windowScene == nil
    {
      appWindow.windowScene = windowScene
      appWindow.makeKeyAndVisible()
      window = appWindow
    }

    // Cold-start deep links arrive in connectionOptions under the scene
    // lifecycle (NOT in launchOptions). Replay them after a short delay so the
    // JS url listeners exist by the time the event fires. Best effort - the
    // invite flow also persists its token, so a missed event self-heals there.
    let urls = connectionOptions.urlContexts.map { $0.url }
    let activities = connectionOptions.userActivities
    if !urls.isEmpty || !activities.isEmpty {
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
        for url in urls {
          RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
        }
        for activity in activities {
          RCTLinkingManager.application(UIApplication.shared, continue: activity) { _ in }
        }
      }
    }
  }

  /// Warm-app custom-scheme opens (hearthshelf://...).
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  /// Warm-app universal links (https://app.hearthshelf.com/invite?...).
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(UIApplication.shared, continue: userActivity) { _ in }
  }
}
