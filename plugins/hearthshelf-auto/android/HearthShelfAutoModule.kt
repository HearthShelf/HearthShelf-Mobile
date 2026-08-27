package com.hearthshelf.mobile

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bridge between JS and the native phone media engine (HearthShelfPlayerService,
 * a Media3 MediaSession + ExoPlayer) plus the Android Auto session handoff.
 *
 * - setSession/clearSession: hand the ABS server URL + token to the headless
 *   Android Auto service (unchanged).
 * - load/play/pause/seekTo/setRate/setVolume/stop: JS (PlayerHost) drives the
 *   phone ExoPlayer. The service owns the MediaSession so we control the
 *   notification / lock-screen chapter progress + custom skip icons.
 * - Native -> JS events (onProgress/onState/onTogglePlay/onJump) are emitted via
 *   DeviceEventManagerModule so the JS store stays the source of truth.
 *
 * Old-arch RN module (matches the existing style); registered via
 * HearthShelfAutoPackage in MainApplication (injected by the config plugin).
 */
class HearthShelfAutoModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx), LifecycleEventListener {

  override fun getName() = "HearthShelfAuto"

  init {
    emitter = { name, params -> sendEvent(name, params) }
    // Registered once, for the module's lifetime, so a start we had to defer (see
    // ensureService) can be retried on the next foreground edge. RN fires
    // onHostResume immediately here if the host is already resumed, so this also
    // covers a module created while the app is up front.
    ctx.addLifecycleEventListener(this)
  }

  private fun prefs() =
    ctx.getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)

  private fun sendEvent(name: String, params: WritableMap?) {
    if (!ctx.hasActiveReactInstance()) return
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(name, params)
  }

  // ---- Android Auto session handoff (unchanged) ----

  @ReactMethod
  fun setSession(serverUrl: String, token: String, skipBackSec: Int, skipForwardSec: Int) {
    prefs().edit()
      .putString("serverUrl", serverUrl)
      .putString("token", token)
      .putInt("skipBackSec", skipBackSec)
      .putInt("skipForwardSec", skipForwardSec)
      .apply()
  }

  /** Mirror the user's skipBack/skipForward settings into prefs so BOTH the phone
   *  notification service (HearthShelfPlayerService) and the car service honor them.
   *  setSession also writes these, but only while a car session is active; the phone
   *  notification is always live during playback, so JS pushes them here on change
   *  regardless of car mode. */
  @ReactMethod
  fun setSkipSeconds(skipBackSec: Int, skipForwardSec: Int) {
    prefs().edit()
      .putInt("skipBackSec", skipBackSec)
      .putInt("skipForwardSec", skipForwardSec)
      .apply()
  }

  /** Publish the phone's computed Discover feed for the car to browse. The car
   *  service can't run the TS taste engine, so JS hands it a ready snapshot:
   *  { shelves: [{ id, label, items: [{ id, title, author }] }] }. */
  @ReactMethod
  fun setDiscover(json: String) {
    prefs().edit().putString("discover", json).apply()
  }

  /**
   * Publish the downloaded books - local file paths, chapters, cover, saved
   * position - so the car has a browse tree and something to play with no network.
   * Everything the car surface does is otherwise a request to ABS, which is why an
   * offline car showed nothing at all. Shape:
   * { books: [{ id, title, sortKey, author, cover, duration, position, finished,
   *             addedAt, seriesId, seriesName, sequence,
   *             chapters: [{ title, start, end }],
   *             tracks: [{ uri, startOffset, duration }] }] }
   */
  @ReactMethod
  fun setOfflineLibrary(json: String) {
    prefs().edit().putString("offlineLibrary", json).apply()
  }

  /** Progress the car banked while playing downloads with no server, keyed
   *  "<itemId>@<startedAt>" (one entry per LISTEN, so a second listen of the same
   *  book doesn't overwrite the first), as { itemId, title, duration, currentTime,
   *  timeListening, startedAt, updatedAt }. JS folds these into its own
   *  pending-sync ledger. */
  @ReactMethod
  fun getOfflineProgress(promise: Promise) {
    promise.resolve(prefs().getString("offlineProgress", null) ?: "{}")
  }

  /** Drop the banked entries JS has taken ownership of. Only the keys passed in
   *  are removed, so a car listen that started after the read isn't lost. */
  @ReactMethod
  fun clearOfflineProgress(keysJson: String) {
    try {
      val raw = prefs().getString("offlineProgress", null) ?: return
      val all = JSONObject(raw)
      val keys = JSONArray(keysJson)
      for (i in 0 until keys.length()) all.remove(keys.getString(i))
      prefs().edit().putString("offlineProgress", all.toString()).apply()
    } catch (e: Exception) {
      // A corrupt ledger is not worth failing the launch over; the next car
      // session overwrites it.
    }
  }

  /** Bookmarks the car couldn't POST (offline), as
   *  [{ itemId, time, title, createdAt }]. JS pushes them on reconnect. */
  @ReactMethod
  fun getOfflineBookmarks(promise: Promise) {
    promise.resolve(prefs().getString("offlineBookmarks", null) ?: "[]")
  }

  /** Drop only the queued bookmarks JS has taken ownership of, keyed
   *  "<itemId>@<time>", so one queued mid-drain isn't lost. */
  @ReactMethod
  fun clearOfflineBookmarks(keysJson: String) {
    try {
      val raw = prefs().getString("offlineBookmarks", null) ?: return
      val taken = HashSet<String>()
      val keys = JSONArray(keysJson)
      for (i in 0 until keys.length()) taken.add(keys.getString(i))
      val kept = JSONArray()
      val arr = JSONArray(raw)
      for (i in 0 until arr.length()) {
        val b = arr.getJSONObject(i)
        if (!taken.contains("${b.optString("itemId")}@${b.optInt("time")}")) kept.put(b)
      }
      prefs().edit().putString("offlineBookmarks", kept.toString()).apply()
    } catch (e: Exception) {
      // Leave the queue alone rather than dropping bookmarks on a parse error.
    }
  }

  /**
   * Is the device in airplane mode? Sitting through a retry storm we KNOW can't
   * succeed is the worst version of a slow launch, so the app checks this first
   * and drops straight into offline mode instead.
   */
  @ReactMethod
  fun isAirplaneMode(promise: Promise) {
    promise.resolve(
      try {
        Settings.Global.getInt(ctx.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) != 0
      } catch (e: Exception) {
        false
      }
    )
  }

  /**
   * Java heap usage and live thread count, for memory-pressure breadcrumbs.
   *
   * Exists because an OOM stack cannot name what filled the heap. HS-MOBILEAPP-1C
   * died inside a React Fabric mount with zero app frames anywhere in the trace -
   * that frame is merely where the allocation happened to fail, and reasoning
   * backwards from it identified nothing. HS-MOBILEAPP-1K was only diagnosable
   * because its thread happened to be named `pool-12252-thread-1`, which gave the
   * count away by accident.
   *
   * threads is the cheap tell for the leak class we have actually hit: a service
   * or executor that is recreated and never shut down (see the io.shutdown() in
   * HearthShelfAutoService.onDestroy). A steady heap with a climbing thread count
   * says retention; both climbing together says ordinary bloat.
   *
   * Values are MB, and `limit` is the growth limit the OOM message quotes, so a
   * breadcrumb can be compared directly against a crash.
   */
  @ReactMethod
  fun getMemoryStats(promise: Promise) {
    promise.resolve(
      try {
        val rt = Runtime.getRuntime()
        val mb = 1024.0 * 1024.0
        Arguments.createMap().apply {
          putDouble("usedMb", (rt.totalMemory() - rt.freeMemory()) / mb)
          putDouble("totalMb", rt.totalMemory() / mb)
          putDouble("limitMb", rt.maxMemory() / mb)
          putInt("threads", Thread.activeCount())
        }
      } catch (e: Exception) {
        Arguments.createMap()
      }
    )
  }

  /** Mirror the notePops master on/off into the car service's prefs. The RN
   *  settings store persists to AsyncStorage (SQLite), which the headless Auto
   *  service can't read, so JS pushes the boolean here. See
   *  HearthShelfAutoService.notePopsEnabled. */
  @ReactMethod
  fun setNotePopsEnabled(enabled: Boolean) {
    prefs().edit().putBoolean("notePopsEnabled", enabled).apply()
  }

  /** Push the shake-to-extend sleep-timer state into prefs so the phone media
   *  service can run shake detection natively (works with the screen off / app
   *  backgrounded, which a JS accelerometer listener cannot). `timerActive` is
   *  true only while a duration/clock sleep timer is live. The service reads these
   *  live to gate the accelerometer; re-evaluate so a change takes effect now. */
  @ReactMethod
  fun setSleepShake(enabled: Boolean, minutes: Int, timerActive: Boolean, hapticLevel: String) {
    prefs().edit()
      .putBoolean("sleepShakeExtend", enabled)
      .putInt("sleepShakeMinutes", minutes)
      .putBoolean("sleepTimerActive", timerActive)
      .putString("hapticLevel", hapticLevel)
      .apply()
    HearthShelfPlayerService.instance?.evaluateShake()
  }

  /** Push the warning-beep settings + the live sleep timer's remaining playback
   *  seconds into prefs so the phone media service can fire the cues natively
   *  (works screen-off / backgrounded, like shake-to-extend). `remainingSec` is
   *  -1 when no duration/clock timer is armed. The service reads the toggles live
   *  each tick; a remaining push resets its per-timer cue state so an armed or
   *  extended timer re-fires. */
  @ReactMethod
  fun setSleepBeep(
    enabled: Boolean,
    at2min: Boolean,
    at1min: Boolean,
    atFinal: Boolean,
    sound: String,
    volume: Int,
    remainingSec: Double,
  ) {
    prefs().edit()
      .putBoolean("sleepBeepEnabled", enabled)
      .putBoolean("sleepBeepAt2min", at2min)
      .putBoolean("sleepBeepAt1min", at1min)
      .putBoolean("sleepBeepFinal", atFinal)
      .putString("sleepBeepSound", sound)
      .putInt("sleepBeepVolume", volume)
      .apply()
    HearthShelfPlayerService.instance?.updateSleepBeep(if (remainingSec >= 0) remainingSec else null)
  }

  @ReactMethod
  fun clearSession() {
    // The offline library goes too: with no session handed over, the car must not
    // keep serving this user's downloads. The banked offline progress/bookmarks do
    // NOT - they are unsynced user data, drained by JS at the next launch.
    prefs().edit()
      .remove("serverUrl").remove("token")
      .remove("skipBackSec").remove("skipForwardSec")
      .remove("discover")
      .remove("offlineLibrary")
      .apply()
    Handler(Looper.getMainLooper()).post {
      controller?.release()
      controller = null
    }
  }

  // ---- phone playback commands (drive HearthShelfPlayerService) ----

  // A MediaController connected to our own MediaSessionService. Media3 only posts
  // the media notification while a controller is connected, so we keep this alive
  // for the app's lifetime. We don't issue commands through it (JS drives the
  // ExoPlayer directly); its sole job is to make the notification appear.
  @Volatile private var controller: MediaController? = null
  @Volatile private var connecting = false

  // A start we could not legally perform, to be retried on the next foreground
  // edge. The load itself is NOT held here - it is already stashed in
  // HearthShelfPlayerService.pendingLoad for onCreate to drain, so this is only a
  // "we still owe the service a start" flag.
  @Volatile private var startDeferred = false

  /**
   * Start the media service if it isn't up yet.
   *
   * Android 12+ (API 31) forbids Context.startService from the background and
   * throws BackgroundServiceStartNotAllowedException. This used to escape into RN
   * and crash the app: JS would then believe it had handed a book to native while
   * no player existed, which the user experienced as a book that loads forever and
   * never plays.
   *
   * We do NOT reach for startForegroundService as a workaround. It is only legal
   * from the background in a few narrow exemptions we cannot count on here (17
   * minutes backgrounded, no visible task), and it carries a hard contract: the
   * service must call startForeground() within a few seconds or the system kills
   * the process with a ForegroundServiceDidNotStartInTimeException. Media3's
   * MediaSessionService only promotes itself once the player is actually ready to
   * play, which for a remote ABS stream means waiting on a network round-trip, and
   * not at all when autoPlay is false. Trading this crash for a timeout crash on a
   * slow connection would be strictly worse, so we stay on startService and treat
   * "not allowed right now" as a deferral.
   */
  private fun ensureService() {
    // Ask before throwing where we can. RN tracks the host activity's state, and a
    // resumed host is the case the OS lets through, so this keeps the normal
    // foreground path on exactly the call it has always made and reserves the catch
    // below for the races RN's view of lifecycle can't cover (resumed-but-finishing,
    // or a state flip between this check and the start).
    if (ctx.lifecycleState == LifecycleState.RESUMED) {
      if (tryStartService()) return
    }
    // No legal start right now. The load is safe in pendingLoad; remember that the
    // service still owes us a start and let onHostResume do it. Nothing is lost and
    // nothing polls.
    startDeferred = true
  }

  /** Attempt the service start. Returns true when it went through. */
  private fun tryStartService(): Boolean {
    return try {
      ctx.startService(Intent(ctx, HearthShelfPlayerService::class.java))
      startDeferred = false
      connectController()
      true
    } catch (e: Exception) {
      // BackgroundServiceStartNotAllowedException on API 31+, but catch broadly:
      // this runs on RN's native-modules thread, where anything thrown becomes an
      // unhandled app crash.
      false
    }
  }

  // ---- LifecycleEventListener ----
  //
  // The retry edge for a deferred start. Coming to the foreground is exactly the
  // condition that makes startService legal again, so one attempt here is enough -
  // if it somehow fails the flag stays set for the next resume, with no loop and no
  // duplicate start (tryStartService clears the flag, and the service itself is a
  // singleton whose onCreate drains pendingLoad once).
  override fun onHostResume() {
    if (!startDeferred) return
    // Only if there is still something to start. The service may have come up by
    // another route (a car session, a later foreground load) while we were away.
    if (HearthShelfPlayerService.instance != null) {
      startDeferred = false
      return
    }
    tryStartService()
  }

  override fun onHostPause() {}

  override fun onHostDestroy() {
    startDeferred = false
  }

  private fun connectController() {
    Handler(Looper.getMainLooper()).post {
      // Guard on the main thread so overlapping calls don't build duplicates.
      if (controller != null || connecting) return@post
      connecting = true
      try {
        val token = SessionToken(ctx, ComponentName(ctx, HearthShelfPlayerService::class.java))
        val future = MediaController.Builder(ctx, token).buildAsync()
        future.addListener({
          try {
            controller = future.get()
          } catch (e: Exception) {
            // Retry on the next command if the connection couldn't be built.
          } finally {
            connecting = false
          }
        }, MoreExecutors.directExecutor())
      } catch (e: Exception) {
        connecting = false
      }
    }
  }

  @ReactMethod
  fun load(
    url: String,
    startSec: Double,
    title: String,
    author: String,
    artworkUri: String,
    chaptersJson: String,
    autoPlay: Boolean
  ) {
    // The car owns playback: this book belongs in the CAR player, not the phone
    // service. Loading it here anyway is what produced audio the car knew nothing
    // about - Android Auto is bound to the car session, so it showed "tap to open
    // HearthShelf" over a book that was already playing, and every later transport
    // command (which DOES route to the car, below) hit a different player than the
    // one making sound. JS holds the item id the car needs, so ask it for one
    // rather than guessing from a token-bearing url. See HS-MOBILEAPP-18.
    //
    // Ahead of the stash below on purpose: parking this in pendingLoad would just
    // defer the same wrong outcome to whenever the phone service next starts.
    if (carPlayer != null) {
      emitCarNeedsBook()
      return
    }
    // Under the same lock the service's onCreate/onDestroy use, so we either hand
    // the load to a live service or stash it for onCreate to drain - never both,
    // never a lost/stale load.
    var svc: HearthShelfPlayerService? = null
    synchronized(HearthShelfPlayerService.lock) {
      svc = HearthShelfPlayerService.instance
      if (svc == null) {
        HearthShelfPlayerService.pendingLoad =
          HearthShelfPlayerService.PendingLoad(url, startSec, title, author, artworkUri, chaptersJson, autoPlay)
      }
    }
    val live = svc
    if (live != null) live.load(url, startSec, title, author, artworkUri, chaptersJson, autoPlay)
    else ensureService()
  }

  /**
   * Re-announce car ownership to a JS runtime that missed the connect edge.
   *
   * carActive is set in JS by onCarActive, which is emitted once, from onConnect.
   * A runtime that STARTS while Android Auto is already connected therefore never
   * learns the car is there and drives the phone player instead - the split that
   * HS-MOBILEAPP-18/19 were reported from. PlayerHost calls this on mount, so the
   * answer comes from the one place that actually knows (carPlayer), not from an
   * event that may have fired hours ago.
   *
   * Does NOT emit active=false when no car is attached. JS defaults to "no car"
   * and treats a false onCarActive as a HANDBACK, which pauses and re-resolves -
   * so announcing it here would interrupt a phone that is happily playing every
   * time the host remounts.
   *
   * But silence alone left a stuck belief uncorrectable. Swapping from USB
   * Android Auto to Bluetooth earbuds can route audio away without gearhead's
   * controller disconnecting, so onDisconnected never fires and JS stays
   * car-owned forever: the phone player stands down, every pause tap forwards to
   * a car that isn't there ("shows paused but doesn't pause"), the "playing in
   * car" banner sticks, and the reclaim recovery suppresses itself with "native
   * lost the track while the car owns playback" (HS-MOBILEAPP-W/X).
   *
   * So absence is now reported as its own event, onCarAbsent, which JS applies
   * ONLY to correct a stale carActive - clearing the flag without the handback's
   * pause/re-resolve. A JS runtime that already believes there is no car ignores
   * it, which is what makes it safe to send on every foreground.
   */
  @ReactMethod fun syncCarState() {
    val car = carPlayer
    if (car == null) {
      emitCarAbsent()
      return
    }
    emitCarActive(true)
    if (car.loadedItemId() != null) car.republishLoaded()
  }

  // When Android Auto owns playback (carPlayer != null), transport commands from
  // JS (phone UI or lock screen) drive the CAR player, and load is suppressed -
  // so the phone and car never both produce audio and the phone UI's controls
  // operate the one player that's actually playing. Otherwise they drive the
  // phone service as before.
  @ReactMethod fun play() {
    val car = carPlayer
    if (car != null) {
      // The car connects with an EMPTY player, and the handoff that fills it runs
      // on the takeover edge - which is too early when the app was launched (or
      // relaunched) into an already-connected car, because nothing was loaded yet
      // for that edge to hand over. play() then set playWhenReady on a player with
      // no media: silence, a frozen scrubber, and no way forward except tapping the
      // book on the car screen. Ask JS for the book instead. See HS-MOBILEAPP-19.
      if (car.loadedItemId() == null) emitCarNeedsBook() else car.play()
      return
    }
    val svc = HearthShelfPlayerService.instance
    // A reclaimed service (or one whose ExoPlayer was cleared) accepts play() and
    // does nothing - silently, with no error event. JS still believes the book is
    // loaded, so it never reloads and the user taps a dead button forever. Tell
    // JS instead, so it can reload the track and start over.
    //
    // No instance at all: answer here, since there is nothing to hop onto.
    if (svc == null) {
      emitPlaybackLost()
      return
    }
    // Otherwise the service decides on the main thread and calls back - asking it
    // synchronously from this (RN bridge) thread would throw, because ExoPlayer
    // verifies thread affinity on reads as well as writes. See
    // HearthShelfPlayerService.playOrReportLost.
    svc.playOrReportLost { emitPlaybackLost() }
  }
  @ReactMethod fun pause() {
    val car = carPlayer
    if (car != null) car.pause() else HearthShelfPlayerService.instance?.pausePlayer()
  }
  @ReactMethod fun seekTo(sec: Double) {
    val car = carPlayer
    if (car != null) car.seekTo(sec) else HearthShelfPlayerService.instance?.seekToSec(sec)
  }
  @ReactMethod fun setRate(rate: Double) {
    val car = carPlayer
    if (car != null) car.setRate(rate) else HearthShelfPlayerService.instance?.setRate(rate)
  }
  @ReactMethod fun setVolume(volume: Double) {
    // Volume (the sleep-timer fade) only applies to the phone player; the car
    // controls its own hardware volume.
    if (carPlayer == null) HearthShelfPlayerService.instance?.setVolume(volume)
  }
  @ReactMethod fun stop() {
    val car = carPlayer
    if (car != null) car.stop() else HearthShelfPlayerService.instance?.stopPlayer()
  }

  /**
   * Stand the PHONE player down, whoever owns playback.
   *
   * stop() routes by carPlayer, which is right for a transport tap but wrong for
   * the takeover handoff: there the intent is specifically "the phone stops now",
   * and routing it to the car pauses the CAR while the phone service plays on.
   * Both players then hold a book, and only the audio-focus fight between them
   * kept that from being heard twice.
   */
  @ReactMethod fun stopPhonePlayer() {
    HearthShelfPlayerService.instance?.stopPlayer()
  }

  /**
   * Load the book the phone was playing into the car player, at the phone's live
   * position. Called by JS on the car-takeover edge: the car connects with an
   * empty player, and without this Android Auto auto-plays the browse tree's
   * first item (the up-next queue head) instead of resuming the current book.
   * No-op when the car isn't the active player (nothing to take over).
   */
  @ReactMethod fun loadCarBook(itemId: String, positionSec: Double) {
    carPlayer?.loadBook(itemId, positionSec)
  }

  // RN NativeEventEmitter requires these no-op stubs on the module.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  /** The subset of car-player controls JS transport commands route to while
   *  Android Auto owns playback. Implemented by HearthShelfAutoService. */
  interface CarPlayer {
    fun play()
    fun pause()
    fun seekTo(sec: Double)
    fun setRate(rate: Double)
    fun stop()
    /** Load a book into the car player at the given absolute position, so the car
     *  resumes what the phone was playing instead of the browse tree's first item. */
    fun loadBook(itemId: String, positionSec: Double)
    /** The book the car has resolved, or null while its player is empty. Drives
     *  the "does a transport command have anything to act on" checks above. */
    fun loadedItemId(): String?
    /** Re-emit onCarLoaded for the loaded book, so a JS runtime that started after
     *  the car did can mirror what is already playing. */
    fun republishLoaded()
  }

  companion object {
    /** Set by the module so the service can emit events back to JS. */
    @Volatile var emitter: ((String, WritableMap?) -> Unit)? = null

    /** Non-null while the Android Auto service is the active player. Set by
     *  HearthShelfAutoService when a book is loaded in the car, cleared when the
     *  car session ends. Transport commands from JS route here when set. */
    @Volatile var carPlayer: CarPlayer? = null

    /** Tell JS whether the car is the active player, so PlayerHost stops driving
     *  (and stands down) the phone service while the car owns playback. */
    fun emitCarActive(active: Boolean) {
      val map = Arguments.createMap().apply { putBoolean("active", active) }
      emitter?.invoke("onCarActive", map)
    }

    /** Tell JS which book the car just loaded, so the phone UI can mirror it
     *  (title/author/cover/chapters/duration + absolute start position). */
    fun emitCarLoaded(
      itemId: String,
      title: String,
      author: String,
      artworkUri: String,
      durationSec: Double,
      positionSec: Double,
      chaptersJson: String,
    ) {
      val map = Arguments.createMap().apply {
        putString("itemId", itemId)
        putString("title", title)
        putString("author", author)
        putString("artworkUri", artworkUri)
        putDouble("duration", durationSec)
        putDouble("position", positionSec)
        putString("chapters", chaptersJson)
      }
      emitter?.invoke("onCarLoaded", map)
    }

    fun emitProgress(positionSec: Double) {
      val map = Arguments.createMap().apply { putDouble("position", positionSec) }
      emitter?.invoke("onProgress", map)
    }
    fun emitState(isPlaying: Boolean) {
      val map = Arguments.createMap().apply { putBoolean("isPlaying", isPlaying) }
      emitter?.invoke("onState", map)
    }
    /** True while the engine wants to play but has run out of buffered data
     *  (ExoPlayer STATE_BUFFERING with playWhenReady). Drives the UI's
     *  buffering ring around the play button. */
    fun emitBuffering(buffering: Boolean) {
      val map = Arguments.createMap().apply { putBoolean("buffering", buffering) }
      emitter?.invoke("onBuffering", map)
    }
    fun emitTogglePlay() {
      emitter?.invoke("onTogglePlay", Arguments.createMap())
    }
    fun emitJump(deltaSec: Double) {
      val map = Arguments.createMap().apply { putDouble("delta", deltaSec) }
      emitter?.invoke("onJump", map)
    }
    /** Chapter skip requested from a Bluetooth headset / car stereo's
     *  next-or-previous-track button on the PHONE session. JS owns chapter
     *  navigation (it holds the marks and decides that "next" from the last
     *  chapter finishes the book), so this only reports the intent.
     *
     *  Reuses the existing onCarChapter event, which JS already routes to
     *  skipChapterOrFinish - the Android Auto service does this natively in-car,
     *  so nothing was emitting it until now. */
    fun emitSkipChapter(direction: Int) {
      val map = Arguments.createMap().apply { putInt("direction", direction) }
      emitter?.invoke("onCarChapter", map)
    }
    /** A shake was detected while a sleep timer is winding down. JS adds the
     *  minutes to the live timer and shows the confirmation toast. */
    fun emitShakeExtend(minutes: Int) {
      val map = Arguments.createMap().apply { putInt("minutes", minutes) }
      emitter?.invoke("onShakeExtend", map)
    }
    // The current book reached its end. JS advances the up-next queue (server
    // owns the queue; JS plays its head) rather than the service picking a next
    // track, so the phone + car share one queue.
    fun emitEnded() {
      emitter?.invoke("onEnded", Arguments.createMap())
    }

    /**
     * A transport command arrived for a service that no longer holds the track
     * (OS-reclaimed under memory pressure, or its ExoPlayer was cleared).
     *
     * This is deliberately NOT onError: nothing failed loudly, and treating it as
     * an error would just drop the playing state and leave the same dead button.
     * JS responds by reloading the current book from the live store position, so
     * the tap the user made turns into actual audio.
     */
    fun emitPlaybackLost() {
      emitter?.invoke("onPlaybackLost", Arguments.createMap())
    }

    /**
     * The car owns playback but has no book to act on, and something (a load, a
     * play) just asked it to. Only JS knows which book the listener is on and
     * where they are in it, so it answers with loadCarBook.
     *
     * Sibling of emitPlaybackLost, and deliberately shaped the same way: neither
     * is an error, both are "the player you are talking to is empty - rebuild it
     * from the store" so the tap the listener made turns into audio.
     */
    fun emitCarNeedsBook() {
      emitter?.invoke("onCarNeedsBook", Arguments.createMap())
    }

    /** No car is attached right now. Sent in answer to syncCarState only, so JS
     *  can correct a carActive that got stuck true (see syncCarState). This is
     *  deliberately NOT onCarActive(false): that means "the car handed back" and
     *  carries a pause + re-resolve, which is wrong for a runtime that simply
     *  believed the wrong thing. */
    fun emitCarAbsent() {
      emitter?.invoke("onCarAbsent", Arguments.createMap())
    }

    /** The book JS handed over could not be resolved (no session, dead network,
     *  not downloaded), so the car player is still empty and JS's "the car has
     *  this" marker is wrong. */
    fun emitCarLoadFailed() {
      emitter?.invoke("onCarLoadFailed", Arguments.createMap())
    }
  }
}

/**
 * Whether a playback failure is worth retrying by reloading the track.
 *
 * True for transport-level faults: the bytes stopped arriving, but the media
 * itself is fine, so re-preparing from the current position generally works.
 * That covers the common real-world cause - a streamed book whose connection
 * died mid-chapter (server restart, expired token, tunnel/dead-zone) - which
 * otherwise just stops the audio for good.
 *
 * False for content faults (malformed container, unsupported codec, bad
 * manifest). Those are deterministic: a reload reproduces them exactly, so
 * retrying only spins.
 *
 * Shared by both services so the phone and the car agree on what is worth
 * retrying.
 */
fun isRecoverableSourceError(error: androidx.media3.common.PlaybackException): Boolean =
  when (error.errorCode) {
    androidx.media3.common.PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
    androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
    androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
    androidx.media3.common.PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
    androidx.media3.common.PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
    androidx.media3.common.PlaybackException.ERROR_CODE_IO_NO_PERMISSION,
    androidx.media3.common.PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED,
    androidx.media3.common.PlaybackException.ERROR_CODE_TIMEOUT -> true
    else -> false
  }

@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class HearthShelfAutoPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(HearthShelfAutoModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
