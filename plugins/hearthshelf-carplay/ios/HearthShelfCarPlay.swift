import AVFoundation
import Foundation
import MediaPlayer
import React
import UIKit

/// A book/episode row surfaced in the CarPlay browse lists. Playable rows carry
/// the ABS item id (a "podId/episodeId" pair for podcast episodes); the real
/// stream URL is resolved lazily via a play session when the row is tapped.
struct CarBook {
  let id: String
  let title: String
  let subtitle: String
  // Title with a leading article dropped, for alphabetical sorting (matches the
  // web/phone library). Defaults to the title when ABS gives no ignore-prefix.
  var sortKey: String = ""
}

/// A CarPlay browse node. Mirrors the Android Auto browse tree (childrenOf):
/// root tabs -> library drill-downs -> playable book lists.
enum CarNode {
  case continueListening
  case new
  case libraryRoot
  case discoverRoot
  case books(libraryId: String)
  case series(libraryId: String)
  case seriesItems(libraryId: String, seriesId: String)
  case podcasts(libraryId: String)
  case podcastEpisodes(podcastId: String)
  case discoverShelf(shelfId: String)
}

/// A resolved browse node's children: either sub-folders (browsable) or a list
/// of playable books. The scene delegate turns these into CPListItems.
enum CarChildren {
  case folders([(node: CarNode, title: String)])
  case books([CarBook])
}

@objc(HearthShelfAuto)
final class HearthShelfAuto: RCTEventEmitter {
  /// The live module instance, for the CarPlay scene delegate. RCTBridge.current()
  /// is nil under the bridgeless New Architecture (the only architecture on
  /// SDK 57), so the scene layer cannot resolve modules through the bridge -
  /// the instance registers itself here instead.
  static weak var shared: HearthShelfAuto?

  private struct Chapter {
    let title: String
    let start: Double
    let end: Double
  }

  private let defaults = UserDefaults.standard
  private let player = AVPlayer()
  private var hasListeners = false
  private var progressTimer: Timer?
  private var chapters: [Chapter] = []
  private var bookTitle = ""
  private var bookAuthor = ""
  private var artworkUri = ""
  private var shownChapterIndex = -1
  private var currentRate: Float = 1
  private var skipBackSec = 15
  private var skipForwardSec = 30

  override init() {
    super.init()
    HearthShelfAuto.shared = self
    configureAudioSession()
    configureRemoteCommands()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(playerItemDidReachEnd),
      name: .AVPlayerItemDidPlayToEndTime,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc
  private func playerItemDidReachEnd(_ notification: Notification) {
    guard let endedItem = notification.object as? AVPlayerItem,
      endedItem === player.currentItem
    else {
      return
    }
    DispatchQueue.main.async {
      self.progressTimer?.invalidate()
      self.progressTimer = nil
      self.emitState(false)
      self.emitEnded()
    }
  }

  @objc
  override static func requiresMainQueueSetup() -> Bool {
    true
  }

  override func supportedEvents() -> [String]! {
    // Must declare every event the shared JS (PlayerHost) subscribes to, or
    // RCTEventEmitter throws on addListener. onEnded fires from CarPlay; the
    // onCar* pair is Android Auto handoff (never emitted on iOS) but still has
    // to be declared so the cross-platform listener setup is valid here.
    ["onProgress", "onState", "onTogglePlay", "onJump", "onEnded", "onCarActive", "onCarLoaded"]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  @objc(setSession:token:skipBackSec:skipForwardSec:)
  func setSession(_ serverUrl: String, token: String, skipBackSec: NSNumber, skipForwardSec: NSNumber) {
    defaults.set(serverUrl, forKey: "hs.carplay.serverUrl")
    defaults.set(token, forKey: "hs.carplay.token")
    defaults.set(skipBackSec.intValue, forKey: "hs.carplay.skipBackSec")
    defaults.set(skipForwardSec.intValue, forKey: "hs.carplay.skipForwardSec")
    self.skipBackSec = skipBackSec.intValue
    self.skipForwardSec = skipForwardSec.intValue
    MPRemoteCommandCenter.shared().skipBackwardCommand.preferredIntervals = [skipBackSec]
    MPRemoteCommandCenter.shared().skipForwardCommand.preferredIntervals = [skipForwardSec]
    HearthShelfCarPlaySceneDelegate.reloadActiveRoot()
  }

  @objc(setDiscover:)
  func setDiscover(_ json: String) {
    defaults.set(json, forKey: "hs.carplay.discover")
    HearthShelfCarPlaySceneDelegate.reloadActiveRoot()
  }

  @objc(setNotePopsEnabled:)
  func setNotePopsEnabled(_ enabled: Bool) {
    defaults.set(enabled, forKey: "hs.carplay.notePopsEnabled")
  }

  @objc
  func clearSession() {
    defaults.removeObject(forKey: "hs.carplay.serverUrl")
    defaults.removeObject(forKey: "hs.carplay.token")
    defaults.removeObject(forKey: "hs.carplay.discover")
    stop()
    HearthShelfCarPlaySceneDelegate.reloadActiveRoot()
  }

  @objc(load:startSec:title:author:artworkUri:chaptersJson:)
  func load(
    _ url: String,
    startSec: NSNumber,
    title: String,
    author: String,
    artworkUri: String,
    chaptersJson: String
  ) {
    DispatchQueue.main.async {
      self.bookTitle = title
      self.bookAuthor = author
      self.artworkUri = artworkUri
      self.chapters = self.parseChapters(chaptersJson)
      self.shownChapterIndex = self.chapterIndex(at: startSec.doubleValue)

      guard let mediaUrl = URL(string: url) else {
        return
      }

      self.configureAudioSession()
      self.player.replaceCurrentItem(with: AVPlayerItem(url: mediaUrl))
      self.player.seek(to: CMTime(seconds: startSec.doubleValue, preferredTimescale: 600))
      self.player.rate = self.currentRate
      self.startProgressTimer()
      self.updateNowPlaying()
      self.emitState(true)
    }
  }

  @objc
  func play() {
    DispatchQueue.main.async {
      self.player.rate = self.currentRate
      self.startProgressTimer()
      self.updateNowPlaying()
      self.emitState(true)
    }
  }

  @objc
  func pause() {
    DispatchQueue.main.async {
      self.player.pause()
      self.updateNowPlaying()
      self.emitState(false)
    }
  }

  @objc(seekTo:)
  func seekTo(_ sec: NSNumber) {
    DispatchQueue.main.async {
      let wasPlaying = self.player.rate > 0
      self.player.seek(to: CMTime(seconds: sec.doubleValue, preferredTimescale: 600)) { _ in
        if wasPlaying {
          self.player.rate = self.currentRate
        }
        self.updateNowPlaying()
      }
    }
  }

  @objc(setRate:)
  func setRate(_ rate: NSNumber) {
    DispatchQueue.main.async {
      self.currentRate = max(0.5, min(3, rate.floatValue))
      if self.player.rate > 0 {
        self.player.rate = self.currentRate
      }
      self.updateNowPlaying()
    }
  }

  @objc(setVolume:)
  func setVolume(_ volume: NSNumber) {
    DispatchQueue.main.async {
      self.player.volume = max(0, min(1, volume.floatValue))
    }
  }

  @objc
  func stop() {
    DispatchQueue.main.async {
      self.progressTimer?.invalidate()
      self.progressTimer = nil
      self.player.pause()
      self.player.replaceCurrentItem(with: nil)
      self.chapters = []
      self.shownChapterIndex = -1
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      self.emitState(false)
    }
  }

  private func configureAudioSession() {
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio, options: [])
      try session.setActive(true)
    } catch {
      // Audio session activation can fail in simulator/headless CI; the player
      // still compiles and will retry when playback is requested on device.
    }
  }

  private func configureRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    center.playCommand.addTarget { [weak self] _ in
      self?.play()
      return .success
    }
    center.pauseCommand.addTarget { [weak self] _ in
      self?.pause()
      return .success
    }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      self?.emitTogglePlay()
      return .success
    }
    center.skipBackwardCommand.preferredIntervals = [NSNumber(value: skipBackSec)]
    center.skipBackwardCommand.addTarget { [weak self] _ in
      self?.emitJump(Double(-(self?.skipBackSec ?? 15)))
      return .success
    }
    center.skipForwardCommand.preferredIntervals = [NSNumber(value: skipForwardSec)]
    center.skipForwardCommand.addTarget { [weak self] _ in
      self?.emitJump(Double(self?.skipForwardSec ?? 30))
      return .success
    }
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let ev = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      self?.seekTo(NSNumber(value: ev.positionTime))
      return .success
    }
  }

  private func startProgressTimer() {
    progressTimer?.invalidate()
    progressTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self else {
        return
      }
      let position = self.player.currentTime().seconds
      guard position.isFinite else {
        return
      }
      self.emitProgress(position)
      self.refreshChapterSubtitle(position: position)
    }
  }

  private func updateNowPlaying() {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: bookTitle,
      MPMediaItemPropertyArtist: subtitleForCurrentChapter(),
      MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime().seconds,
      MPNowPlayingInfoPropertyPlaybackRate: player.rate,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: currentRate,
    ]
    let duration = player.currentItem?.duration.seconds ?? 0
    if duration.isFinite, duration > 0 {
      info[MPMediaItemPropertyPlaybackDuration] = duration
    }
    if let url = URL(string: artworkUri) {
      loadArtwork(url: url) { artwork in
        var next = info
        if let artwork {
          next[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = next
      }
    } else {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
  }

  private func refreshChapterSubtitle(position: Double) {
    let idx = chapterIndex(at: position)
    if idx != shownChapterIndex {
      shownChapterIndex = idx
      updateNowPlaying()
    } else if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
      info[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
  }

  private func subtitleForCurrentChapter() -> String {
    if chapters.indices.contains(shownChapterIndex) {
      return "\(bookAuthor) · \(chapters[shownChapterIndex].title)"
    }
    return bookAuthor
  }

  private func parseChapters(_ json: String) -> [Chapter] {
    guard let data = json.data(using: .utf8),
      let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else {
      return []
    }
    return arr.enumerated().map { idx, obj in
      Chapter(
        title: obj["title"] as? String ?? "Chapter \(idx + 1)",
        start: obj["start"] as? Double ?? 0,
        end: obj["end"] as? Double ?? 0
      )
    }
  }

  private func chapterIndex(at position: Double) -> Int {
    chapters.firstIndex { position >= $0.start && position < $0.end } ?? -1
  }

  private func loadArtwork(url: URL, completion: @escaping (MPMediaItemArtwork?) -> Void) {
    URLSession.shared.dataTask(with: url) { data, _, _ in
      guard let data, let image = UIImage(data: data) else {
        DispatchQueue.main.async { completion(nil) }
        return
      }
      let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
      DispatchQueue.main.async { completion(artwork) }
    }.resume()
  }

  // ---- CarPlay browse: shared data layer (mirrors Android Auto's childrenOf) ----

  /// Resolve one browse node's children off the main thread and hand them back.
  /// The scene delegate calls this for every list it pushes.
  func loadChildren(for node: CarNode, completion: @escaping (CarChildren) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      let result = self.childrenOf(node)
      DispatchQueue.main.async { completion(result) }
    }
  }

  /// The four root tabs, matching Android Auto: Continue / New / Library / Discover.
  func rootTabs() -> [(node: CarNode, title: String)] {
    [
      (.continueListening, "Continue"),
      (.new, "New"),
      (.libraryRoot, "Library"),
      (.discoverRoot, "Discover"),
    ]
  }

  private func childrenOf(_ node: CarNode) -> CarChildren {
    switch node {
    case .continueListening:
      var seen = Set<String>()
      var items = [CarBook]()
      for b in fetchBooks(path: "/api/me/items-in-progress", key: "libraryItems") where seen.insert(b.id).inserted {
        items.append(b)
      }
      for b in continueSeries() where seen.insert(b.id).inserted {
        items.append(b)
      }
      return .books(items)

    case .new:
      return .books(recentlyAdded())

    case .libraryRoot:
      var folders = [(node: CarNode, title: String)]()
      let books = bookLibraries()
      let pods = podcastLibraries()
      for lib in books {
        let prefix = books.count > 1 ? "\(lib.name) - " : ""
        folders.append((.books(libraryId: lib.id), "\(prefix)Books"))
        folders.append((.series(libraryId: lib.id), "\(prefix)Series"))
      }
      for lib in pods {
        let label = pods.count > 1 ? "\(lib.name) Podcasts" : "Podcasts"
        folders.append((.podcasts(libraryId: lib.id), label))
      }
      return .folders(folders)

    case .books(let libraryId):
      return .books(libraryItems(libraryId: libraryId))

    case .series(let libraryId):
      let folders = seriesList(libraryId: libraryId).map {
        (node: CarNode.seriesItems(libraryId: libraryId, seriesId: $0.id), title: $0.name)
      }
      return .folders(folders)

    case .seriesItems(let libraryId, let seriesId):
      return .books(seriesItems(libraryId: libraryId, seriesId: seriesId))

    case .podcasts(let libraryId):
      let folders = podcasts(libraryId: libraryId).map {
        (node: CarNode.podcastEpisodes(podcastId: $0.id), title: $0.title)
      }
      return .folders(folders)

    case .podcastEpisodes(let podcastId):
      return .books(podcastEpisodes(podcastId: podcastId))

    case .discoverRoot:
      let folders = discoverShelves().map {
        (node: CarNode.discoverShelf(shelfId: $0.id), title: $0.label)
      }
      return .folders(folders)

    case .discoverShelf(let shelfId):
      let shelf = discoverShelves().first { $0.id == shelfId }
      return .books(shelf?.items ?? [])
    }
  }

  // ---- ABS fetch helpers (synchronous; called on a background queue) ----

  private struct Library {
    let id: String
    let name: String
    let mediaType: String
  }

  private func allLibraries() -> [Library] {
    guard let data = requestSync(path: "/api/libraries"),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let libraries = obj["libraries"] as? [[String: Any]]
    else {
      return []
    }
    return libraries.map {
      Library(
        id: $0["id"] as? String ?? "",
        name: $0["name"] as? String ?? "Library",
        mediaType: $0["mediaType"] as? String ?? "book"
      )
    }
  }

  private func bookLibraries() -> [Library] {
    allLibraries().filter { $0.mediaType == "book" }
  }

  private func podcastLibraries() -> [Library] {
    allLibraries().filter { $0.mediaType == "podcast" }
  }

  private func fetchBooks(path: String, key: String) -> [CarBook] {
    guard let data = requestSync(path: path),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return []
    }
    let raw = (obj[key] as? [[String: Any]]) ?? (obj["results"] as? [[String: Any]]) ?? []
    return raw.map { carBook(from: $0) }
  }

  private func recentlyAdded() -> [CarBook] {
    var out = [CarBook]()
    for lib in bookLibraries() {
      out.append(
        contentsOf: fetchBooks(
          path: "/api/libraries/\(encodePath(lib.id))/items?limit=25&minified=1&sort=addedAt&desc=1",
          key: "results"
        )
      )
    }
    return out
  }

  private func libraryItems(libraryId: String) -> [CarBook] {
    fetchBooks(
      path: "/api/libraries/\(encodePath(libraryId))/items?limit=100&minified=1",
      key: "results"
    )
    .sorted { $0.sortKey.localizedCaseInsensitiveCompare($1.sortKey) == .orderedAscending }
  }

  private func seriesList(libraryId: String) -> [(id: String, name: String)] {
    guard let data = requestSync(path: "/api/libraries/\(encodePath(libraryId))/series?limit=200"),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let results = obj["results"] as? [[String: Any]]
    else {
      return []
    }
    return results
      .map {
        (
          id: $0["id"] as? String ?? "",
          name: $0["name"] as? String ?? "Series",
          sortKey: ($0["nameIgnorePrefix"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? ($0["name"] as? String ?? "Series")
        )
      }
      .sorted { $0.sortKey.localizedCaseInsensitiveCompare($1.sortKey) == .orderedAscending }
      .map { (id: $0.id, name: $0.name) }
  }

  private func seriesItems(libraryId: String, seriesId: String) -> [CarBook] {
    guard let data = requestSync(path: "/api/libraries/\(encodePath(libraryId))/series?limit=200"),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let results = obj["results"] as? [[String: Any]]
    else {
      return []
    }
    for series in results where (series["id"] as? String) == seriesId {
      let books = (series["books"] as? [[String: Any]]) ?? []
      return books.map { carBook(from: $0) }
    }
    return []
  }

  /// Next-up entries: for each series the listener has started, the first book
  /// they haven't. Mirrors Android's continueSeries heuristic.
  private func continueSeries() -> [CarBook] {
    let inProgress = Set(
      fetchBooks(path: "/api/me/items-in-progress", key: "libraryItems").map { $0.id }
    )
    if inProgress.isEmpty {
      return []
    }
    var out = [CarBook]()
    var seenSeries = Set<String>()
    for lib in bookLibraries() {
      guard let data = requestSync(path: "/api/libraries/\(encodePath(lib.id))/series?limit=200"),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let results = obj["results"] as? [[String: Any]]
      else {
        continue
      }
      for series in results {
        let books = ((series["books"] as? [[String: Any]]) ?? []).map { carBook(from: $0) }
        if !books.contains(where: { inProgress.contains($0.id) }) {
          continue
        }
        guard let next = books.first(where: { !inProgress.contains($0.id) }) else {
          continue
        }
        if seenSeries.insert(series["id"] as? String ?? "").inserted {
          out.append(next)
        }
      }
    }
    return out
  }

  private struct Podcast {
    let id: String
    let title: String
  }

  private func podcasts(libraryId: String) -> [Podcast] {
    guard let data = requestSync(path: "/api/libraries/\(encodePath(libraryId))/items?limit=200&minified=1"),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let results = obj["results"] as? [[String: Any]]
    else {
      return []
    }
    return results.map {
      let meta = ($0["media"] as? [String: Any])?["metadata"] as? [String: Any]
      return Podcast(id: $0["id"] as? String ?? "", title: meta?["title"] as? String ?? "Podcast")
    }
  }

  /// Episodes of a podcast, newest first. The play route takes item id + episode
  /// id, so each CarBook carries a "podId/episodeId" id that playById splits.
  private func podcastEpisodes(podcastId: String) -> [CarBook] {
    guard let data = requestSync(path: "/api/items/\(encodePath(podcastId))?expanded=1"),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let media = obj["media"] as? [String: Any]
    else {
      return []
    }
    let podTitle = (media["metadata"] as? [String: Any])?["title"] as? String ?? ""
    let eps = (media["episodes"] as? [[String: Any]]) ?? []
    return eps.map {
      CarBook(
        id: "\(podcastId)/\($0["id"] as? String ?? "")",
        title: $0["title"] as? String ?? "Episode",
        subtitle: podTitle
      )
    }
    .reversed()
  }

  private func carBook(from obj: [String: Any]) -> CarBook {
    let media = obj["media"] as? [String: Any]
    let metadata = media?["metadata"] as? [String: Any]
    let title = metadata?["title"] as? String ?? obj["title"] as? String ?? "Untitled"
    let sortKey = (metadata?["titleIgnorePrefix"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? title
    return CarBook(
      id: obj["id"] as? String ?? "",
      title: title,
      subtitle: metadata?["authorName"] as? String ?? "",
      sortKey: sortKey
    )
  }

  /// Artwork URL for a browse row's cover (token-bearing so CarPlay can load it).
  func coverUrl(itemId: String) -> URL? {
    // Podcast episodes carry "podId/episodeId"; the cover route wants the item id.
    let id = itemId.split(separator: "/").first.map(String.init) ?? itemId
    return mediaUrl(path: "/api/items/\(encodePath(id))/cover")
  }

  // ---- Playback resolution (called by the scene delegate on tap) ----

  /// The car selected a playable row. Create an ABS play session, then hand the
  /// real stream URL + resume position + chapters to `load`. Books use a plain
  /// id; podcast episodes use "podId/episodeId".
  func playById(_ rawId: String, completion: @escaping (Bool) -> Void) {
    let itemId = rawId.split(separator: "/").first.map(String.init) ?? rawId
    let episodeId = rawId.contains("/") ? String(rawId.split(separator: "/")[1]) : nil
    let playPath =
      episodeId != nil
      ? "/api/items/\(encodePath(itemId))/play/\(encodePath(episodeId!))"
      : "/api/items/\(encodePath(itemId))/play"

    request(path: playPath, method: "POST", body: startPlayBody()) { data in
      guard let data,
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let tracks = obj["audioTracks"] as? [[String: Any]],
        let track = tracks.first,
        let contentUrl = track["contentUrl"] as? String,
        let url = self.mediaUrl(path: contentUrl)
      else {
        DispatchQueue.main.async { completion(false) }
        return
      }

      let chapters = ((obj["chapters"] as? [[String: Any]]) ?? []).map {
        [
          "title": $0["title"] as? String ?? "",
          "start": $0["start"] as? Double ?? 0,
          "end": $0["end"] as? Double ?? 0,
        ]
      }
      let chapterData = try? JSONSerialization.data(withJSONObject: chapters)
      let chapterJson = chapterData.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
      DispatchQueue.main.async {
        self.load(
          url.absoluteString,
          startSec: NSNumber(value: obj["currentTime"] as? Double ?? 0),
          title: obj["displayTitle"] as? String ?? "Untitled",
          author: obj["displayAuthor"] as? String ?? "",
          artworkUri: self.coverUrl(itemId: itemId)?.absoluteString ?? "",
          chaptersJson: chapterJson
        )
        completion(true)
      }
    }
  }

  // ---- HTTP ----

  /// Synchronous ABS GET for the browse data layer, which already runs on a
  /// background queue (loadChildren). Returns nil on any failure.
  private func requestSync(path: String) -> Data? {
    guard let serverUrl = defaults.string(forKey: "hs.carplay.serverUrl"),
      let token = defaults.string(forKey: "hs.carplay.token"),
      let url = URL(string: serverUrl + path)
    else {
      return nil
    }
    var req = URLRequest(url: url)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.timeoutInterval = 8
    let semaphore = DispatchSemaphore(value: 0)
    var result: Data?
    URLSession.shared.dataTask(with: req) { data, response, _ in
      if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
        result = data
      }
      semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 10)
    return result
  }

  private func request(
    path: String,
    method: String = "GET",
    body: Data? = nil,
    completion: @escaping (Data?) -> Void
  ) {
    guard let serverUrl = defaults.string(forKey: "hs.carplay.serverUrl"),
      let token = defaults.string(forKey: "hs.carplay.token"),
      let url = URL(string: serverUrl + path)
    else {
      completion(nil)
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let body {
      req.httpBody = body
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    URLSession.shared.dataTask(with: req) { data, response, _ in
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        completion(nil)
        return
      }
      completion(data)
    }.resume()
  }

  private func startPlayBody() -> Data? {
    let body: [String: Any] = [
      "deviceInfo": [
        "deviceId": "hearthshelf-ios-carplay",
        "clientName": "HearthShelf iOS",
        "clientVersion": "0.0.1",
      ],
      "supportedMimeTypes": ["audio/mpeg", "audio/mp4", "audio/aac", "audio/flac", "audio/ogg"],
    ]
    return try? JSONSerialization.data(withJSONObject: body)
  }

  private func mediaUrl(path: String) -> URL? {
    guard let serverUrl = defaults.string(forKey: "hs.carplay.serverUrl"),
      let token = defaults.string(forKey: "hs.carplay.token")
    else {
      return nil
    }
    let separator = path.contains("?") ? "&" : "?"
    let encodedToken = encodeQuery(token)
    return URL(string: "\(serverUrl)\(path)\(separator)token=\(encodedToken)")
  }

  private struct DiscoverShelf {
    let id: String
    let label: String
    let items: [CarBook]
  }

  private func discoverShelves() -> [DiscoverShelf] {
    guard let raw = defaults.string(forKey: "hs.carplay.discover"),
      let data = raw.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let shelves = obj["shelves"] as? [[String: Any]]
    else {
      return []
    }
    return shelves.map { shelf in
      let items = (shelf["items"] as? [[String: Any]] ?? []).map {
        CarBook(
          id: $0["id"] as? String ?? "",
          title: $0["title"] as? String ?? "Untitled",
          subtitle: $0["author"] as? String ?? ""
        )
      }
      return DiscoverShelf(
        id: shelf["id"] as? String ?? "",
        label: shelf["label"] as? String ?? "Discover",
        items: items
      )
    }
  }

  private func emitProgress(_ position: Double) {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onProgress", body: ["position": position])
  }

  private func emitState(_ isPlaying: Bool) {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onState", body: ["isPlaying": isPlaying])
  }

  private func emitTogglePlay() {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onTogglePlay", body: [:])
  }

  private func emitJump(_ delta: Double) {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onJump", body: ["delta": delta])
  }

  private func emitEnded() {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onEnded", body: [:])
  }
}

private func encodePath(_ value: String) -> String {
  value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
}

private func encodeQuery(_ value: String) -> String {
  var allowed = CharacterSet.urlQueryAllowed
  allowed.remove(charactersIn: "&+=?")
  return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}
