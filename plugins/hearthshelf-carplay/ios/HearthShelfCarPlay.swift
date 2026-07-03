import AVFoundation
import Foundation
import MediaPlayer
import React
import UIKit

@objc(HearthShelfAuto)
final class HearthShelfAuto: RCTEventEmitter, MPPlayableContentDataSource, MPPlayableContentDelegate {
  private struct Chapter {
    let title: String
    let start: Double
    let end: Double
  }

  private struct CarItem {
    let id: String
    let title: String
    let subtitle: String
    let playable: Bool
  }

  private enum Node {
    case continueListening
    case discoverShelf(String)
    case library(String)
  }

  private let defaults = UserDefaults.standard
  private let player = AVPlayer()
  private let playableContent = MPPlayableContentManager.shared()
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
  private var roots: [CarItem] = []
  private var libraryRoots: [CarItem] = []
  private var childrenByRoot: [String: [CarItem]] = [:]
  private var rootNodes: [String: Node] = [:]

  override init() {
    super.init()
    configureAudioSession()
    configureRemoteCommands()
    playableContent.dataSource = self
    playableContent.delegate = self
    rebuildRoot()
  }

  @objc
  override static func requiresMainQueueSetup() -> Bool {
    true
  }

  override func supportedEvents() -> [String]! {
    ["onProgress", "onState", "onTogglePlay", "onJump"]
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
    reloadCarPlay()
  }

  @objc(setDiscover:)
  func setDiscover(_ json: String) {
    defaults.set(json, forKey: "hs.carplay.discover")
    reloadCarPlay()
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
    reloadCarPlay()
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

  func numberOfChildItems(at indexPath: IndexPath) -> Int {
    if indexPath.count == 0 {
      return roots.count
    }
    guard let root = rootItem(at: indexPath) else {
      return 0
    }
    return childrenByRoot[root.id]?.count ?? 0
  }

  func contentItem(at indexPath: IndexPath) -> MPContentItem? {
    let item: CarItem?
    if indexPath.count == 1 {
      item = roots[safe: indexPath[0]]
    } else if indexPath.count == 2, let root = roots[safe: indexPath[0]] {
      item = childrenByRoot[root.id]?[safe: indexPath[1]]
    } else {
      item = nil
    }
    guard let carItem = item else {
      return nil
    }
    let content = MPContentItem(identifier: carItem.id)
    content.title = carItem.title
    content.subtitle = carItem.subtitle
    content.isPlayable = carItem.playable
    content.isContainer = !carItem.playable
    return content
  }

  func playableContentManager(
    _ contentManager: MPPlayableContentManager,
    initiatePlaybackOfContentItemAt indexPath: IndexPath,
    completionHandler: @escaping (Error?) -> Void
  ) {
    guard indexPath.count == 2,
      let root = roots[safe: indexPath[0]],
      let item = childrenByRoot[root.id]?[safe: indexPath[1]],
      item.playable
    else {
      completionHandler(nil)
      return
    }
    playItemById(item.id, completion: completionHandler)
  }

  func playableContentManager(
    _ contentManager: MPPlayableContentManager,
    beginLoadingChildItemsAt indexPath: IndexPath,
    completionHandler: @escaping (Error?) -> Void
  ) {
    if indexPath.count == 0 {
      rebuildRoot()
      completionHandler(nil)
      return
    }
    guard let root = rootItem(at: indexPath), let node = rootNodes[root.id] else {
      completionHandler(nil)
      return
    }
    loadChildren(for: root, node: node, completion: completionHandler)
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
    let duration = player.currentItem?.asset.duration.seconds ?? 0
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

  private func rebuildRoot() {
    var nextRoots = [CarItem]()
    var nextNodes = [String: Node]()

    let continueId = "root:continue"
    nextRoots.append(CarItem(id: continueId, title: "Continue Listening", subtitle: "", playable: false))
    nextNodes[continueId] = .continueListening

    for shelf in discoverShelves() {
      let id = "root:discover:\(shelf.id)"
      nextRoots.append(CarItem(id: id, title: shelf.label, subtitle: "", playable: false))
      nextNodes[id] = .discoverShelf(shelf.id)
      childrenByRoot[id] = shelf.items.map {
        CarItem(id: $0.id, title: $0.title, subtitle: $0.author, playable: true)
      }
    }

    for library in libraryRoots {
      nextRoots.append(library)
      nextNodes[library.id] = .library(library.id.replacingOccurrences(of: "root:library:", with: ""))
    }

    roots = nextRoots
    rootNodes = nextNodes
  }

  private func reloadCarPlay() {
    DispatchQueue.main.async {
      self.rebuildRoot()
      self.playableContent.reloadData()
    }
    fetchLibraries()
  }

  private func rootItem(at indexPath: IndexPath) -> CarItem? {
    guard indexPath.count >= 1 else {
      return nil
    }
    return roots[safe: indexPath[0]]
  }

  private func loadChildren(
    for root: CarItem,
    node: Node,
    completion: @escaping (Error?) -> Void
  ) {
    switch node {
    case .continueListening:
      fetchItems(path: "/api/me/items-in-progress") { [weak self] result in
        self?.childrenByRoot[root.id] = result
        completion(nil)
      }
    case .discoverShelf:
      completion(nil)
    case .library(let libraryId):
      fetchItems(path: "/api/libraries/\(encodePath(libraryId))/items?page=0&limit=50&minified=1") {
        [weak self] result in
        self?.childrenByRoot[root.id] = result
        completion(nil)
      }
    }
  }

  private func fetchItems(path: String, completion: @escaping ([CarItem]) -> Void) {
    request(path: path) { data in
      guard let data,
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        completion([])
        return
      }
      let rawItems = (obj["libraryItems"] as? [[String: Any]]) ?? (obj["results"] as? [[String: Any]]) ?? []
      completion(rawItems.map { self.carItem(from: $0) })
    }
  }

  private func fetchLibraries() {
    request(path: "/api/libraries") { [weak self] data in
      guard let self,
        let data,
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let libraries = obj["libraries"] as? [[String: Any]]
      else {
        return
      }
      let next = libraries.map {
        CarItem(
          id: "root:library:\($0["id"] as? String ?? "")",
          title: $0["name"] as? String ?? "Library",
          subtitle: "",
          playable: false
        )
      }
      DispatchQueue.main.async {
        self.libraryRoots = next
        self.rebuildRoot()
        self.playableContent.reloadData()
      }
    }
  }

  private func carItem(from obj: [String: Any]) -> CarItem {
    let media = obj["media"] as? [String: Any]
    let metadata = media?["metadata"] as? [String: Any]
    return CarItem(
      id: obj["id"] as? String ?? "",
      title: metadata?["title"] as? String ?? obj["title"] as? String ?? "Untitled",
      subtitle: metadata?["authorName"] as? String ?? "",
      playable: true
    )
  }

  private func playItemById(_ itemId: String, completion: @escaping (Error?) -> Void) {
    request(path: "/api/items/\(encodePath(itemId))/play", method: "POST", body: startPlayBody()) {
      data in
      guard let data,
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let tracks = obj["audioTracks"] as? [[String: Any]],
        let track = tracks.first,
        let contentUrl = track["contentUrl"] as? String,
        let url = self.mediaUrl(path: contentUrl)
      else {
        DispatchQueue.main.async { completion(nil) }
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
        completion(nil)
      }
    }
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

  private func coverUrl(itemId: String) -> URL? {
    mediaUrl(path: "/api/items/\(encodePath(itemId))/cover")
  }

  private func discoverShelves() -> [(id: String, label: String, items: [CarItem])] {
    guard let raw = defaults.string(forKey: "hs.carplay.discover"),
      let data = raw.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let shelves = obj["shelves"] as? [[String: Any]]
    else {
      return []
    }
    return shelves.map { shelf in
      let id = shelf["id"] as? String ?? ""
      let label = shelf["label"] as? String ?? "Discover"
      let items = (shelf["items"] as? [[String: Any]] ?? []).map {
        CarItem(
          id: $0["id"] as? String ?? "",
          title: $0["title"] as? String ?? "Untitled",
          subtitle: $0["author"] as? String ?? "",
          playable: true
        )
      }
      return (id: id, label: label, items: items)
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
}

private extension Array {
  subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
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
