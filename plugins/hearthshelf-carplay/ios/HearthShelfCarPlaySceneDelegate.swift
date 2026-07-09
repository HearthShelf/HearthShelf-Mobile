import CarPlay
import Foundation

/// Minimal CarPlay scene delegate for the modern CarPlay framework
/// (com.apple.developer.carplay-audio, iOS 14+).
///
/// This is a stub: it satisfies the UIApplicationSceneManifest CarPlay scene
/// role so the entitlement is wired and a car connection succeeds without
/// crashing. It currently sets an empty root list. The real browse templates
/// (tab bar, library/continue lists, now-playing) that replace the legacy
/// MPPlayableContentManager tree live in a later pass.
@available(iOS 14.0, *)
final class HearthShelfCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  var interfaceController: CPInterfaceController?

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    self.interfaceController = interfaceController
    let root = CPListTemplate(title: "HearthShelf", sections: [])
    interfaceController.setRootTemplate(root, animated: false, completion: nil)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    self.interfaceController = nil
  }
}
