import CarPlay
import Foundation
import UIKit

/// CarPlay scene delegate for the modern CarPlay framework
/// (com.apple.developer.carplay-audio, iOS 14+).
///
/// Builds the browse UI as a CPTabBarTemplate whose four tabs mirror Android
/// Auto's root (Continue / New / Library / Discover). Each tab is a CPListTemplate;
/// drill-downs (Library -> Books/Series/Podcasts -> items) push more list
/// templates. Tapping a playable row resolves an ABS play session via the shared
/// HearthShelfAuto native module and shows the now-playing screen.
///
/// Browse data + playback both live on the HearthShelfAuto RCTEventEmitter (the
/// same instance the phone UI drives), so the car and phone share one player and
/// one ABS session.
@available(iOS 14.0, *)
final class HearthShelfCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  var interfaceController: CPInterfaceController?

  // The connected scene's delegate, so setSession/setDiscover can rebuild the
  // root tabs when the JS layer hands over new credentials or a Discover
  // snapshot after the car has already connected.
  private static weak var active: HearthShelfCarPlaySceneDelegate?

  // The four root tab list templates, kept so a reload can refresh their content
  // in place without tearing down the tab bar.
  private var tabTemplates: [CPListTemplate] = []
  private var tabNodes: [CarNode] = []

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    self.interfaceController = interfaceController
    HearthShelfCarPlaySceneDelegate.active = self
    setupNowPlayingButtons()
    setupTabs()
  }

  /// Add the custom Now Playing buttons CPNowPlayingTemplate.shared doesn't
  /// provide by default (it only renders the transport row + the two skip-interval
  /// buttons). Speed / previous-chapter / next-chapter / bookmark each route back
  /// through JS (via HearthShelfAuto) to the same store commands the phone uses,
  /// so the car matches the phone. Configured once on connect; the rate label
  /// refreshes as JS pushes new rates through Now Playing info.
  private func setupNowPlayingButtons() {
    let template = CPNowPlayingTemplate.shared

    let rateButton = CPNowPlayingPlaybackRateButton { [weak self] _ in
      self?.module?.emitCarRateCycle()
    }
    let prevChapter = CPNowPlayingImageButton(
      image: nowPlayingIcon("backward.end")
    ) { [weak self] _ in
      self?.module?.emitCarChapter(-1)
    }
    let nextChapter = CPNowPlayingImageButton(
      image: nowPlayingIcon("forward.end")
    ) { [weak self] _ in
      self?.module?.emitCarChapter(1)
    }
    let bookmark = CPNowPlayingImageButton(
      image: nowPlayingIcon("bookmark")
    ) { [weak self] _ in
      self?.module?.emitCarBookmark()
    }

    template.updateNowPlayingButtons([prevChapter, rateButton, bookmark, nextChapter])
  }

  /// An SF Symbol sized for a CarPlay Now Playing button. Falls back to an empty
  /// image if the symbol is unavailable, so the button still renders (tappable).
  private func nowPlayingIcon(_ systemName: String) -> UIImage {
    let config = UIImage.SymbolConfiguration(pointSize: 28, weight: .medium)
    return UIImage(systemName: systemName, withConfiguration: config) ?? UIImage()
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    self.interfaceController = nil
    if HearthShelfCarPlaySceneDelegate.active === self {
      HearthShelfCarPlaySceneDelegate.active = nil
    }
  }

  /// Called by HearthShelfAuto when the session or Discover snapshot changes, so
  /// the already-connected car reflects new sign-in state / shelves.
  static func reloadActiveRoot() {
    DispatchQueue.main.async {
      active?.refreshTabs()
    }
  }

  /// The shared native module instance (browse data + playback), so the car
  /// drives the exact player the phone UI uses. Resolved via the module's own
  /// static registration - RCTBridge.current() is nil under the bridgeless New
  /// Architecture, so bridge-based lookup can never find it. Nil until React
  /// Native instantiates the module (first JS access); setupTabs retries.
  private var module: HearthShelfAuto? {
    HearthShelfAuto.shared
  }

  private func setupTabs() {
    guard let module else {
      // Bridge not ready yet (car connected before JS booted). Show a single
      // placeholder tab and retry shortly.
      let loading = CPListTemplate(title: "HearthShelf", sections: [])
      loading.emptyViewSubtitleVariants = ["Loading..."]
      interfaceController?.setRootTemplate(
        CPTabBarTemplate(templates: [loading]), animated: false, completion: nil
      )
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
        self?.setupTabs()
      }
      return
    }

    let tabs = module.rootTabs()
    tabNodes = tabs.map { $0.node }
    tabTemplates = tabs.map { tab in
      let template = CPListTemplate(title: tab.title, sections: [])
      template.tabTitle = tab.title
      return template
    }
    let tabBar = CPTabBarTemplate(templates: tabTemplates)
    interfaceController?.setRootTemplate(tabBar, animated: false, completion: nil)

    // Populate each tab's content.
    for (index, node) in tabNodes.enumerated() {
      loadInto(tabTemplates[index], node: node)
    }
  }

  /// Re-fetch each root tab's children into the existing tab templates.
  private func refreshTabs() {
    guard !tabTemplates.isEmpty else {
      setupTabs()
      return
    }
    for (index, node) in tabNodes.enumerated() {
      loadInto(tabTemplates[index], node: node)
    }
  }

  /// Fetch a node's children and fill the given list template. Folder children
  /// push a fresh list when tapped; playable rows resolve + start playback.
  private func loadInto(_ template: CPListTemplate, node: CarNode) {
    module?.loadChildren(for: node) { [weak self, weak template] children in
      guard let self, let template else {
        return
      }
      template.updateSections([self.section(for: children)])
    }
  }

  private func section(for children: CarChildren) -> CPListSection {
    switch children {
    case .folders(let folders):
      let items = folders.map { folder -> CPListItem in
        let item = CPListItem(text: folder.title, detailText: nil)
        item.accessoryType = .disclosureIndicator
        item.handler = { [weak self] _, completion in
          self?.pushList(title: folder.title, node: folder.node)
          completion()
        }
        return item
      }
      return CPListSection(items: items)

    case .books(let books):
      let items = books.map { book -> CPListItem in
        let item = CPListItem(text: book.title, detailText: book.subtitle)
        self.attachCover(to: item, itemId: book.id)
        item.handler = { [weak self] _, completion in
          self?.play(book: book, completion: completion)
        }
        return item
      }
      return CPListSection(items: items)
    }
  }

  /// Push a new list template for a folder drill-down and populate it async.
  private func pushList(title: String, node: CarNode) {
    let template = CPListTemplate(title: title, sections: [])
    template.emptyViewSubtitleVariants = ["Loading..."]
    interfaceController?.pushTemplate(template, animated: true, completion: nil)
    loadInto(template, node: node)
  }

  /// A browse row was tapped. Hand the item id to JS (playItemById owns the ABS
  /// session, resume position, and offline/local-file resolution) and show the
  /// Now Playing screen. The shared native player is driven by JS's load(), so
  /// the car and phone stay one player with one session - no native second
  /// session, and downloaded books play from their local files.
  private func play(book: CarBook, completion: @escaping () -> Void) {
    module?.requestCarPlay(book.id)
    interfaceController?.pushTemplate(
      CPNowPlayingTemplate.shared, animated: true, completion: nil
    )
    completion()
  }

  /// Load a row's cover art off the main thread and set it on the list item.
  private func attachCover(to item: CPListItem, itemId: String) {
    guard let url = module?.coverUrl(itemId: itemId) else {
      return
    }
    URLSession.shared.dataTask(with: url) { data, _, _ in
      guard let data, let image = UIImage(data: data) else {
        return
      }
      DispatchQueue.main.async {
        item.setImage(image)
      }
    }.resume()
  }
}
