import AVFoundation
import CoreMotion
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
  // KVO tokens for the current item's load status and the player's stall state.
  // Held so they can be torn down when the item is replaced (load/stop) - a
  // dangling observer on a deallocated item crashes.
  private var itemStatusObs: NSKeyValueObservation?
  private var timeControlObs: NSKeyValueObservation?
  private var observedItem: AVPlayerItem?
  // Set true once we've reported a failure for the current item, so a status
  // change plus a failedToPlayToEndTime notification don't double-toast.
  private var didReportError = false
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
  // When true, the CarPlay/lock-screen progress bar shows the CURRENT CHAPTER's
  // elapsed/length instead of the whole book, matching the phone and Android Auto.
  // Pushed from JS (the per-book "chapter progress" setting) via setChapterProgress.
  private var chapterProgress = true
  // KVO on the current item's duration: a freshly-created AVPlayerItem reports
  // an indefinite duration, so at load() time MPMediaItemPropertyPlaybackDuration
  // is unknown and CarPlay hides the scrubber until something else refreshes it
  // (previously only the first pause did). Observing duration lets us refresh
  // Now Playing the instant AVFoundation resolves it, so the bar shows on play.
  private var durationObs: NSKeyValueObservation?

  // ---- shake-to-extend the sleep timer (native, works while locked) ----
  // iOS suspends the JS thread when the phone locks, so the JS DeviceMotion
  // listener stopped detecting shakes (and firing the haptic) with the screen
  // off. This mirrors Android's native path: CoreMotion keeps delivering while
  // audio plays (the app's `audio` background mode keeps the process alive), we
  // fire the haptic natively, then emit onShakeExtend so JS adds the minutes.
  private let motionManager = CMMotionManager()
  private let motionQueue = OperationQueue()
  private var shakeRunning = false
  private var lastShakeAt: TimeInterval = 0
  private var shakeEnabled = false
  private var shakeTimerActive = false
  private var shakeMinutes = 5
  private var hapticLevel = "minimal"
  /// Shake magnitude (g, gravity removed via userAcceleration) that counts as a
  /// shake. Android uses 18 m/s^2 ~= 1.83g; 1.8g here is the matched threshold.
  private let shakeThresholdG = 1.8
  private let shakeCooldownSec: TimeInterval = 3.0

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
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(playerItemFailedToEnd),
      name: .AVPlayerItemFailedToPlayToEndTime,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(playerItemPlaybackStalled),
      name: .AVPlayerItemPlaybackStalled,
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

  /// AVFoundation gave up mid-stream (the item couldn't finish playing - e.g. the
  /// signed stream URL's token expired between load and this point, or the network
  /// dropped). The userInfo error carries the reason.
  @objc
  private func playerItemFailedToEnd(_ notification: Notification) {
    guard let item = notification.object as? AVPlayerItem, item === player.currentItem else {
      return
    }
    let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
    let message = error?.localizedDescription ?? "Playback stopped unexpectedly"
    DispatchQueue.main.async { self.reportPlaybackError(message) }
  }

  /// Playback stalled with no more buffered data. On its own this is just
  /// buffering (AVPlayer will resume when data returns), so we don't treat it as a
  /// hard error - timeControlStatus tells buffering from a genuine failure.
  @objc
  private func playerItemPlaybackStalled(_ notification: Notification) {
    guard let item = notification.object as? AVPlayerItem, item === player.currentItem else {
      return
    }
    // A stall on a healthy item is recoverable buffering; only escalate if the
    // item is already failed (status observer will also catch this).
    if item.status == .failed {
      let message = item.error?.localizedDescription ?? "Playback stalled"
      DispatchQueue.main.async { self.reportPlaybackError(message) }
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
    // to be declared so the cross-platform listener setup is valid here. onError
    // surfaces a failed AVPlayerItem load (expired token, network stall,
    // unplayable format) so JS can toast it and drop the optimistic playing state.
    // onCarPlayRequest: a CarPlay browse row was tapped - JS opens the ABS session
    // (online/offline/resume all handled there) and drives the shared player, so
    // the car and phone stay one player with one session. onCarRateCycle /
    // onCarChapter / onCarBookmark are the CPNowPlayingTemplate custom buttons,
    // routed through the same store commands the phone uses.
    [
      "onProgress", "onState", "onTogglePlay", "onJump", "onEnded", "onError", "onCarActive",
      "onCarLoaded", "onShakeExtend", "onCarPlayRequest", "onCarRateCycle", "onCarChapter",
      "onCarBookmark",
    ]
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

  /// JS pushes the per-book "chapter progress" setting: when on, the car/lock
  /// screen scrubber tracks the current chapter, not the whole book.
  @objc(setChapterProgress:)
  func setChapterProgress(_ enabled: Bool) {
    DispatchQueue.main.async {
      self.chapterProgress = enabled
      self.updateNowPlaying()
    }
  }

  // ---- CarPlay browse -> JS (a tapped row) ----
  // The scene delegate calls this when a browse row is tapped. Rather than open
  // an ABS session natively (a second session that fights the phone's and can't
  // see downloads), we hand the item id to JS. playItemById() owns the session,
  // resume position, and offline/local-file resolution; it then drives THIS
  // shared player via load(). Books are a plain id; podcast episodes are
  // "podId/episodeId" (playItemById splits it the same way native did).
  func requestCarPlay(_ rawId: String) {
    DispatchQueue.main.async { self.emitCarPlayRequest(rawId) }
  }

  private func emitCarPlayRequest(_ itemId: String) {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onCarPlayRequest", body: ["itemId": itemId])
  }

  // ---- CarPlay now-playing buttons -> JS ----
  // Each custom button routes through the store command the phone player uses, so
  // speed/chapter/bookmark behave identically on the car and the phone.
  func emitCarRateCycle() {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onCarRateCycle", body: [:])
  }

  func emitCarChapter(_ direction: Int) {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onCarChapter", body: ["direction": direction])
  }

  func emitCarBookmark() {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onCarBookmark", body: [:])
  }

  // ---- shake-to-extend: gate pushed from JS ----
  // JS calls this when the setting, the minutes, whether a duration/clock timer
  // is live, or the haptic level changes. We (un)subscribe CoreMotion to match,
  // exactly like Android's setSleepShake -> evaluateShake.
  @objc(setSleepShake:minutes:timerActive:hapticLevel:)
  func setSleepShake(_ enabled: Bool, minutes: NSNumber, timerActive: Bool, hapticLevel: String) {
    self.shakeEnabled = enabled
    self.shakeMinutes = minutes.intValue
    self.shakeTimerActive = timerActive
    self.hapticLevel = hapticLevel
    evaluateShake()
  }

  /// True when a shake should currently add time: setting on, a duration/clock
  /// sleep timer live (pushed from JS), and audio actually playing. (No car gate
  /// on iOS - the CarPlay scene shares this same player.)
  private func shakeConditionsMet() -> Bool {
    shakeEnabled && shakeTimerActive && player.rate > 0
  }

  /// (Un)subscribe the accelerometer to match the current gate. Cheap to call on
  /// every play/pause/load/stop; only touches CoreMotion when the state flips.
  private func evaluateShake() {
    let want = shakeConditionsMet()
    if want && !shakeRunning {
      guard motionManager.isDeviceMotionAvailable else {
        return
      }
      motionManager.deviceMotionUpdateInterval = 0.1
      motionManager.startDeviceMotionUpdates(to: motionQueue) { [weak self] motion, _ in
        guard let self, let motion else {
          return
        }
        self.handleMotion(motion)
      }
      shakeRunning = true
    } else if !want && shakeRunning {
      motionManager.stopDeviceMotionUpdates()
      shakeRunning = false
    }
  }

  /// userAcceleration is gravity-removed (in g), so a still phone reads ~0 and a
  /// deliberate shake spikes past the threshold - the CoreMotion analog of
  /// Android's TYPE_LINEAR_ACCELERATION stream.
  private func handleMotion(_ motion: CMDeviceMotion) {
    let a = motion.userAcceleration
    let mag = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot()
    if mag < shakeThresholdG {
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastShakeAt < shakeCooldownSec {
      return
    }
    // Re-check the gate at fire time (playback/timer can flip between ticks).
    if !shakeConditionsMet() {
      return
    }
    lastShakeAt = now
    // Strong native buzz first, so the confirmation is felt instantly even with
    // the screen off - before the JS bridge round-trip adds the minutes.
    buzzConfirm()
    let mins = shakeMinutes
    DispatchQueue.main.async { self.emitShakeExtend(mins) }
  }

  /// A firm buzz the instant a shake is accepted, fired natively (not via the JS
  /// haptics module) so it lands with the screen off. Silent only when Haptics is
  /// Off. UINotificationFeedbackGenerator(.success) is the closest system analog to
  /// Android's double-pulse confirm.
  private func buzzConfirm() {
    if hapticLevel == "off" {
      return
    }
    DispatchQueue.main.async {
      let generator = UINotificationFeedbackGenerator()
      generator.prepare()
      generator.notificationOccurred(.success)
    }
  }

  private func emitShakeExtend(_ minutes: Int) {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onShakeExtend", body: ["minutes": minutes])
  }

  @objc
  func clearSession() {
    defaults.removeObject(forKey: "hs.carplay.serverUrl")
    defaults.removeObject(forKey: "hs.carplay.token")
    defaults.removeObject(forKey: "hs.carplay.discover")
    stop()
    HearthShelfCarPlaySceneDelegate.reloadActiveRoot()
  }

  // NOTE: the selector (load:startSec:...:autoPlay:) MUST match the JS call in
  // PlayerHost exactly - 7 args including autoPlay. React Native's bridge
  // dispatches by selector arity; a 6-arg native method silently never fires for
  // a 7-arg JS call, which looks like "play does nothing / no audio / frozen
  // scrubber" because the item is never loaded. The Android HearthShelfPlayerService
  // load() has the same 7-arg shape.
  @objc(load:startSec:title:author:artworkUri:chaptersJson:autoPlay:)
  func load(
    _ url: String,
    startSec: NSNumber,
    title: String,
    author: String,
    artworkUri: String,
    chaptersJson: String,
    autoPlay: Bool
  ) {
    DispatchQueue.main.async {
      self.bookTitle = title
      self.bookAuthor = author
      self.artworkUri = artworkUri
      self.chapters = self.parseChapters(chaptersJson)
      self.shownChapterIndex = self.chapterIndex(at: startSec.doubleValue)

      guard let mediaUrl = URL(string: url) else {
        self.reportPlaybackError("Could not open the audio for this book")
        return
      }

      self.configureAudioSession()
      let item = AVPlayerItem(url: mediaUrl)
      self.observeItem(item)
      self.player.replaceCurrentItem(with: item)
      self.player.seek(to: CMTime(seconds: startSec.doubleValue, preferredTimescale: 600))
      if autoPlay {
        self.player.rate = self.currentRate
        self.startProgressTimer()
      }
      self.updateNowPlaying()
      self.emitState(autoPlay)
      self.evaluateShake()
    }
  }

  @objc
  func play() {
    DispatchQueue.main.async {
      self.player.rate = self.currentRate
      self.startProgressTimer()
      self.updateNowPlaying()
      self.emitState(true)
      self.evaluateShake()
    }
  }

  @objc
  func pause() {
    DispatchQueue.main.async {
      self.player.pause()
      self.updateNowPlaying()
      self.emitState(false)
      self.evaluateShake()
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
      self.teardownItemObservers()
      self.player.pause()
      self.player.replaceCurrentItem(with: nil)
      self.chapters = []
      self.shownChapterIndex = -1
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      self.emitState(false)
      self.evaluateShake()
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

  // ---- playback error observation ----
  // AVPlayer fails silently: replaceCurrentItem never throws, and a bad load
  // (expired ?token= 401, network stall, unplayable format) just leaves the item
  // in .failed with no audio. Without this, the UI shows "playing" over silence
  // and nothing reaches JS. We watch the item's status/error and the player's
  // stall state, then emit onError so PlayerHost can toast and stop the
  // optimistic playing state.

  /// Attach status/stall observers to a freshly-created item, replacing any from
  /// the previous load. Must run on the main thread (called from load()).
  private func observeItem(_ item: AVPlayerItem) {
    teardownItemObservers()
    observedItem = item
    didReportError = false

    itemStatusObs = item.observe(\.status, options: [.new]) { [weak self] observedItem, _ in
      guard let self else {
        return
      }
      if observedItem.status == .failed {
        let message = observedItem.error?.localizedDescription ?? "This book could not be played"
        DispatchQueue.main.async { self.reportPlaybackError(message) }
      }
    }

    // A fresh item's duration is indefinite until AVFoundation loads it; without
    // MPMediaItemPropertyPlaybackDuration CarPlay hides the scrubber. Refresh Now
    // Playing the moment duration resolves so the bar appears on play, not only
    // after the first pause.
    durationObs = item.observe(\.duration, options: [.new]) { [weak self] observedItem, _ in
      guard let self else {
        return
      }
      if observedItem.duration.isNumeric {
        DispatchQueue.main.async { self.updateNowPlaying() }
      }
    }

    // timeControlStatus distinguishes buffering (.waitingToPlayAtSpecifiedRate
    // with a reason) from a genuine stop. A wait with no forward progress and a
    // failed item is a failure; a wait while evaluating/buffering is normal.
    timeControlObs = player.observe(\.timeControlStatus, options: [.new]) {
      [weak self] observedPlayer, _ in
      guard let self else {
        return
      }
      if observedPlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate,
        observedPlayer.currentItem?.status == .failed
      {
        let message =
          observedPlayer.currentItem?.error?.localizedDescription ?? "Playback could not continue"
        DispatchQueue.main.async { self.reportPlaybackError(message) }
      }
    }
  }

  private func teardownItemObservers() {
    itemStatusObs?.invalidate()
    itemStatusObs = nil
    timeControlObs?.invalidate()
    timeControlObs = nil
    durationObs?.invalidate()
    durationObs = nil
    observedItem = nil
  }

  /// Emit a single onError per failed item, and drop the optimistic playing state
  /// so the UI stops showing "playing" over silence. Guarded so a status change
  /// plus a failedToPlayToEndTime/stall notification don't double-fire.
  private func reportPlaybackError(_ message: String) {
    if didReportError {
      return
    }
    didReportError = true
    progressTimer?.invalidate()
    progressTimer = nil
    player.pause()
    emitState(false)
    emitError(message)
    evaluateShake()
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
      guard let self, let ev = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      // positionTime is on the DISPLAYED timeline. In chapter mode that's relative
      // to the current chapter's start, so convert back to an absolute book time
      // before seeking; otherwise it's already absolute.
      var target = ev.positionTime
      if self.chapterProgress, self.chapters.indices.contains(self.shownChapterIndex) {
        target += self.chapters[self.shownChapterIndex].start
      }
      self.seekTo(NSNumber(value: target))
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

  /// The (elapsed, duration) pair to show on the car/lock-screen scrubber for a
  /// given absolute book position. When chapterProgress is on and the current
  /// position falls inside a chapter, both are relative to that chapter (matching
  /// the phone and Android Auto); otherwise they're whole-book. Duration is nil
  /// when unknown (a fresh item), so callers omit the key and CarPlay simply
  /// hasn't got a bar yet rather than showing a wrong one.
  private func displayedTiming(at rawPosition: Double) -> (elapsed: Double, duration: Double?) {
    // currentTime() is NaN before the item is ready; clamp so we never write NaN
    // into Now Playing (which would leave the scrubber in an undefined state).
    let position = rawPosition.isFinite ? rawPosition : 0
    let bookDuration = player.currentItem?.duration.seconds
    let bookDur = (bookDuration?.isFinite == true && (bookDuration ?? 0) > 0) ? bookDuration : nil
    if chapterProgress, chapters.indices.contains(shownChapterIndex) {
      let ch = chapters[shownChapterIndex]
      let end = ch.end > ch.start ? ch.end : (bookDur ?? ch.end)
      let len = end - ch.start
      if len > 0 {
        return (max(0, position - ch.start), len)
      }
    }
    return (position, bookDur)
  }

  private func updateNowPlaying() {
    let timing = displayedTiming(at: player.currentTime().seconds)
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: bookTitle,
      MPMediaItemPropertyArtist: subtitleForCurrentChapter(),
      MPNowPlayingInfoPropertyElapsedPlaybackTime: timing.elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: player.rate,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: currentRate,
    ]
    if let duration = timing.duration {
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
      // Crossing a chapter boundary changes the subtitle AND (in chapter mode) the
      // scrubber's baseline/length, so a full rebuild is needed, not just a tick.
      shownChapterIndex = idx
      updateNowPlaying()
    } else if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
      let timing = displayedTiming(at: position)
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = timing.elapsed
      if let duration = timing.duration {
        info[MPMediaItemPropertyPlaybackDuration] = duration
      }
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

  private func emitError(_ message: String) {
    guard hasListeners else {
      return
    }
    sendEvent(withName: "onError", body: ["message": message])
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
