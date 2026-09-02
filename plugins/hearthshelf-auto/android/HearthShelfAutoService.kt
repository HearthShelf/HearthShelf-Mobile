package com.hearthshelf.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import io.sentry.Sentry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Native Android Auto car surface for HearthShelf.
 *
 * Google forbids the Car App Library template model for media apps - audio apps
 * MUST use a MediaBrowserService/MediaLibraryService. So this is the real car
 * integration: a Media3 MediaLibraryService that
 *  - serves the ABS library as a browse tree (Continue Listening + libraries),
 *  - owns its own ExoPlayer that streams ABS audio directly, and
 *  - is declared category.MEDIA so Android Auto lists it as an audio app.
 *
 * It reads the connected server URL + ABS token from SharedPreferences (written
 * by JS at sign-in via the HearthShelfAuto native module), then talks to ABS
 * directly - so the car works headlessly, even if the RN app isn't foregrounded.
 *
 * OFFLINE: every browse/play path above is network-backed, so with no server the
 * car used to show an empty app - no book list, no controls, nothing (the phone
 * could still play THROUGH the car, but the car's own surface was dead). So JS
 * also mirrors a snapshot of the downloaded books (local file paths, chapters,
 * covers, saved positions) into the same prefs, and when the network is down -
 * or the server simply can't be reached - the browse tree and playback are
 * served entirely from that snapshot + the files on disk. Progress made offline
 * is banked into prefs and folded back into the app's pending-sync ledger on the
 * next launch, so a car-only offline listen isn't lost.
 */
class HearthShelfAutoService : MediaLibraryService() {

  private var session: MediaLibrarySession? = null
  // The ExoPlayer, also used directly as the session player. Its timeline is one
  // clipped window per chapter, so position/duration are already chapter-relative;
  // command handlers convert to/from absolute book time via absolutePositionMs.
  private var rawPlayer: ExoPlayer? = null
  // Wrapped in a listening decorator so submit() hands back a ListenableFuture we
  // can return straight to media3. The browse callbacks run on the MAIN thread;
  // blocking them on network I/O (future.get()) froze the UI thread for as long as
  // the request took - up to ~16s per call (8s connect + 8s read), serialized
  // behind every other task on this single-thread executor. On a dead network
  // that reliably tripped an ANR in the Auto service. Returning the future lets
  // media3 await it off the main thread instead.
  private val io = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())

  /**
   * Submit background work, ignoring it if the pool is already shut down.
   *
   * onDestroy() shuts `io` down, but work keeps arriving after that: JS pushes a
   * book at a service it still believes is live, and media3 controllers can
   * outlive the teardown by a moment. Submitting to a stopped pool throws
   * RejectedExecutionException, and these submissions happen on pool and binder
   * threads with no handler above them - so it lands as a FATAL uncaught crash
   * during ordinary teardown (HS-MOBILEAPP-P, thrown from loadBookIntoCar while
   * the pool read "Shutting down").
   *
   * Dropping the work is the correct response: the service is going away, so
   * there is nothing left for it to act on. The one submission that must not be
   * lost - the final progress sync in onDestroy - is issued BEFORE shutdown()
   * and is separately awaited, so it is unaffected by this.
   */
  private fun submitIo(what: String, task: () -> Unit) {
    try {
      io.execute {
        try {
          task()
        } catch (t: Throwable) {
          // A crash on the io thread is likewise unhandled and would take the
          // process down; the service is best-effort, so log and carry on.
          Log.e(TAG, "io task failed: $what", t)
        }
      }
    } catch (e: RejectedExecutionException) {
      Log.w(TAG, "io task dropped after shutdown: $what")
    }
  }

  private val TAG = "HSAuto"

  /** Rolling window for the stream-error retry cap (see noteStreamRetry). */
  private val STREAM_RETRY_WINDOW_MS = 60_000L

  /** Stream-error recoveries allowed per window. A real dead zone clears in one
   *  or two; more than that is a server or token problem a reload cannot fix. */
  private val STREAM_MAX_RETRIES = 3


  // Resume target (absolute book ms) for the item currently being loaded; applied
  // once the player is ready so the car resumes where you left off instead of at 0.
  // The book is ONE continuous media item (not per-chapter clipped windows), so
  // this is a plain absolute position - a single ExoPlayer seek, which is what
  // makes resume fast. -1 means "no pending resume".
  @Volatile private var pendingSeekMs: Long = -1L
  // ABS play-session id for the loaded book, so we can sync progress back.
  @Volatile private var absSessionId: String? = null
  @Volatile private var absDurationSec: Double = 0.0
  @Volatile private var lastSyncedSec: Double = 0.0

  // Set of connected Android Auto (or other real head-unit) controller package
  // names. While non-empty the car owns playback: we register carPlayer so JS
  // transport routes here and tell JS the phone player should stand down.
  private val carControllers = HashSet<String>()

  // Guard against loading the same book twice on one takeover. Sentry
  // (HS-MOBILEAPP-D/E/G) showed onConnect firing for TWO controllers, so
  // emitCarActive -> JS -> loadCarBook ran twice and resolveBookItem POSTed
  // /play TWICE, 166ms apart - two ABS sessions, the second stomping the first
  // mid-prepare. That double round-trip is what made the car slow to start.
  // Holds the item id currently being loaded (or loaded); cleared on disconnect.
  @Volatile private var loadingItemId: String? = null

  // The driver's latest play/pause intent while an asynchronous car load is in
  // flight. The load used to end with playWhenReady=true unconditionally, so a
  // pause pressed while resolveBook was on the network got overwritten as soon
  // as preparation finished and the audiobook resumed by itself.
  @Volatile private var carWantsPlayback = false

  // The JS-transport -> car-player bridge, registered on the module while a car
  // controller is connected. ExoPlayer is main-thread-only, so hop first.
  private val carPlayerImpl = object : HearthShelfAutoModule.CarPlayer {
    override fun play() {
      carWantsPlayback = true
      runOnMain { rawPlayer?.playWhenReady = true }
    }
    override fun pause() {
      carWantsPlayback = false
      runOnMain { rawPlayer?.playWhenReady = false }
    }
    override fun seekTo(sec: Double) = runOnMain {
      rawPlayer?.let { seekToAbsolute(it, (sec * 1000).toLong()) }
    }
    override fun setRate(rate: Double) = runOnMain {
      rawPlayer?.setPlaybackSpeed(rate.toFloat())
      session?.setMediaButtonPreferences(customLayout())
    }
    override fun stop() = runOnMain { rawPlayer?.pause() }
    override fun loadBook(itemId: String, positionSec: Double) = loadBookIntoCar(itemId, positionSec)
    override fun loadedItemId(): String? = currentItemId
    override fun republishLoaded() = republishCarLoaded()
  }

  /**
   * Re-emit the loaded book to JS.
   *
   * The car outlives the JS runtime: this service keeps a book loaded and playing
   * while the app process is killed and relaunched, and a fresh runtime has no way
   * to learn what is in the car - onCarLoaded fired once, to a JS that no longer
   * exists. So a relaunch mid-drive showed an empty phone player over live car
   * audio. Called from the module's syncCarState (see HearthShelfAutoModule).
   *
   * Position is read on the main thread (ExoPlayer verifies thread affinity on
   * reads too), so this hops even though everything else here is a @Volatile read.
   */
  private fun republishCarLoaded() {
    val itemId = currentItemId ?: return
    runOnMain {
      val player = rawPlayer ?: return@runOnMain
      val chaptersJson = JSONArray().apply {
        for (ch in chapters) {
          put(JSONObject().put("title", ch.title).put("start", ch.start).put("end", ch.end))
        }
      }.toString()
      HearthShelfAutoModule.emitCarLoaded(
        itemId,
        bookTitle,
        bookAuthor,
        artUri,
        absDurationSec,
        absolutePositionMs(player) / 1000.0,
        chaptersJson,
      )
      HearthShelfAutoModule.emitState(player.isPlaying)
    }
  }

  /**
   * Load a book into the car player at the phone's live position, so a mid-listen
   * car connect resumes the current book instead of Android Auto auto-playing the
   * browse tree's first item (the up-next queue head).
   *
   * resolveBookItem opens an ABS play session (network) and must run off the main
   * thread; setting the item + preparing the player must run ON it. The JS-supplied
   * position overrides the session's currentTime - it's the phone's exact live
   * spot, not the last value that reached the server.
   */
  // Stream-error recovery attempts inside STREAM_RETRY_WINDOW_MS. Only ever
  // touched from the player listener, which is main-thread only.
  private var streamRetries = 0
  private var streamRetryWindowStart = 0L

  /**
   * Whether another stream-error recovery may run, and count it.
   *
   * The recovery re-prepares the same url, so a server that is genuinely down
   * (or a token that will not refresh) fails again immediately and reports
   * another error - error and reload bouncing off each other with nothing in
   * between to slow them down. The phone side already learned this the hard way
   * (HS-MOBILEAPP-1N, see RECLAIM_MAX_ATTEMPTS): a cap is what turns an infinite
   * retry storm into a bounded attempt that gives up quietly.
   *
   * A window rather than a total, so a long drive that hits one dead zone per
   * hour recovers every time instead of exhausting a lifetime budget.
   */
  private fun noteStreamRetry(): Boolean {
    val now = SystemClock.elapsedRealtime()
    if (now - streamRetryWindowStart > STREAM_RETRY_WINDOW_MS) {
      streamRetryWindowStart = now
      streamRetries = 0
    }
    streamRetries += 1
    if (streamRetries > STREAM_MAX_RETRIES) {
      Log.w(TAG, "car stream retry cap hit ($streamRetries); leaving playback stopped")
      return false
    }
    return true
  }

  private fun loadBookIntoCar(itemId: String, positionSec: Double) {
    // De-dupe: two controllers connect per takeover, so JS pushes the same book
    // twice within ~200ms. Without this each push opens its own ABS play session
    // and reloads the player, doubling the time before audio starts.
    synchronized(carControllers) {
      if (loadingItemId == itemId) return
      loadingItemId = itemId
    }
    // A JS handoff only calls this for a real play intent. A pause arriving while
    // resolveBook runs changes this back to false through either bridge below.
    carWantsPlayback = true
    submitIo("loadBookIntoCar") {
      val loaded = resolveBook(itemId)
      if (loaded == null) {
        Log.e(TAG, "loadBookIntoCar: resolve failed for $itemId")
        // Release the guard so a retry (or a different book) can still load.
        synchronized(carControllers) { if (loadingItemId == itemId) loadingItemId = null }
        // JS marks the book as handed over the moment it pushes it, so tell it the
        // handover did not take - otherwise its marker sticks and no later tap ever
        // retries, which is a worse failure than the one that just happened.
        HearthShelfAutoModule.emitCarLoadFailed()
        return@submitIo
      }
      // The start position rides setMediaItems below, so clear the READY-seek
      // fallback - otherwise it would fire a second, redundant seek.
      pendingSeekMs = -1
      lastSyncedSec = positionSec
      // The JS-supplied position wins over the resolved one: it's the phone's
      // exact live spot. Split it into (window, offset) so a multi-file local
      // download resumes in the right track, not just the right second.
      val (startIndex, startMs) = windowFor((positionSec * 1000).toLong().coerceAtLeast(0))
      runOnMain {
        val player = rawPlayer ?: return@runOnMain
        // Hand the start position to setMediaItems so preparation BEGINS at the
        // resume offset (what the phone player does). Preparing at 0 and seeking
        // on STATE_READY makes ExoPlayer buffer from the file start first - that
        // is the slow path, and it also let the player reach STATE_ENDED.
        player.setMediaItems(loaded.items, startIndex, startMs)
        player.prepare()
        player.playWhenReady = carWantsPlayback
      }
    }
  }

  private val prefs by lazy {
    getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)
  }
  private val serverUrl: String?
    get() = prefs.getString("serverUrl", null)?.trimEnd('/')
  private val token: String?
    get() = prefs.getString("token", null)

  /**
   * Cached drawable name -> resId. resources.getIdentifier is a string-keyed
   * lookup through the whole resource table, and the button builders call it a
   * lot: customLayout() alone costs 8 lookups (each skip button probes for its
   * numeral variant AND resolves the winner), and it is rebuilt on every connect,
   * speed cycle and skip-setting change. Sentry HS-MOBILEAPP-N put customLayout()
   * on the main thread inside onCreate, in the same window as the
   * MediaLibrarySession build() that blocked - so these lookups are pure
   * contention on the critical path. The resource table is immutable for the
   * life of the process, so caching is safe.
   *
   * Resolution deliberately happens OUTSIDE any lock: the onCreate warm task and
   * the main thread race for the same names by design, and a main thread that
   * blocked waiting for the warmer's monitor would be exactly the contention this
   * is meant to remove. Resolving twice is harmless - getIdentifier is a pure
   * read of an immutable table, so both callers compute the same int.
   */
  private val drawableIds = java.util.concurrent.ConcurrentHashMap<String, Int>()

  private fun drawableId(name: String): Int {
    drawableIds[name]?.let { return it }
    val id = resources.getIdentifier(name, "drawable", packageName)
    drawableIds[name] = id
    return id
  }

  /** Every fixed drawable name onCreate's notification provider + custom layout
   *  resolve, warmed off the main thread. The two skip icons are name-dependent
   *  (they carry the user's chosen seconds) so they are warmed separately. */
  private val WARM_DRAWABLES = listOf(
    "ic_hs_notification",
    "ic_hs_prev_chapter",
    "ic_hs_next_chapter",
    "ic_hs_bookmark",
    "ic_hs_speed",
    "ic_hs_rewind",
    "ic_hs_forward",
  )

  /**
   * Is any network actually up? Checked BEFORE the browse/play network calls so an
   * offline car doesn't sit through 8s connect timeouts per request (six of them
   * on a single "Library" tap) before showing an empty screen - it goes straight
   * to the downloaded snapshot instead. Validated capability, not just "an
   * interface exists", so a Wi-Fi router with a dead WAN reads as offline.
   */
  private fun networkUp(): Boolean {
    return try {
      val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
      val net = cm.activeNetwork ?: return false
      val caps = cm.getNetworkCapabilities(net) ?: return false
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    } catch (e: Exception) {
      // Never let a permission/API surprise strand the car offline: assume up and
      // let the request itself decide.
      true
    }
  }

  /** True when we must serve the car from downloaded books: no session handed over
   *  yet, or no usable network. */
  private fun offlineMode(): Boolean = serverUrl == null || token == null || !networkUp()

  // Skip amounts (seconds) for the seek buttons, read live from the prefs JS
  // writes at connect (setSession). Default to the in-app player's 15/30 until
  // JS hands over the user's real setting.
  private val rewindSec: Long
    get() = prefs.getInt("skipBackSec", 15).toLong()
  private val forwardSec: Long
    get() = prefs.getInt("skipForwardSec", 30).toLong()

  // Custom transport commands surfaced with our own circular icons, so the
  // notification / Android Auto stop showing the default fast-forward/rewind
  // glyphs. Handled in LibraryCallback.onCustomCommand.
  private val CMD_REWIND = "com.hearthshelf.REWIND"
  private val CMD_FORWARD = "com.hearthshelf.FORWARD"
  private val CMD_PREV_CH = "com.hearthshelf.PREV_CHAPTER"
  private val CMD_NEXT_CH = "com.hearthshelf.NEXT_CHAPTER"
  private val CMD_SPEED = "com.hearthshelf.CYCLE_SPEED"
  private val CMD_BOOKMARK = "com.hearthshelf.BOOKMARK"

  // Ascending, so the cycle (first preset above the current rate, wrapping to
  // the slowest) visits every preset: 0.75 -> 1 -> 1.25 -> 1.5 -> 1.75 -> 2 -> 0.75.
  private val SPEED_PRESETS = listOf(0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f)

  // Chapters (absolute seconds) for the loaded book + the current item id, used
  // by the chapter-skip buttons, bookmark, and chapter-relative progress.
  @Volatile private var chapters: List<Chapter> = emptyList()
  @Volatile private var currentItemId: String? = null

  // Absolute start offsets (seconds) of each media window, set only when the
  // loaded book is playing from LOCAL files - a downloaded book can be many track
  // files, so offline playback is a playlist rather than the single continuous
  // stream we get from ABS. Empty while streaming (one window, so the player's own
  // position already IS the absolute book position). Every position/seek path goes
  // through absolutePositionMs / seekToAbsolute, which read this.
  @Volatile private var trackOffsets: List<Double> = emptyList()

  // True while the loaded book is playing from disk, so progress is banked into
  // the offline ledger instead of POSTed to a play session that doesn't exist.
  @Volatile private var playingOffline: Boolean = false

  // Identity + running listened-time of the CURRENT offline listen. One listen is
  // one banked session (see recordOfflineProgress), and the total is held here
  // rather than in prefs so a JS drain mid-listen can't reset the count.
  @Volatile private var offlineSessionStartedAt: Long = 0L
  @Volatile private var offlineListenedSec: Double = 0.0

  // Book metadata for the single continuous media item. With per-chapter clipping
  // gone, the now-playing subtitle no longer changes on its own as playback
  // crosses chapters - refreshChapterMeta rewrites it (same URI, no reload).
  @Volatile private var bookTitle: String = ""
  @Volatile private var bookAuthor: String = ""
  @Volatile private var artUri: String = ""
  // Chapter index currently shown in the now-playing metadata; -1 until first set.
  @Volatile private var shownChapterIdx: Int = -1

  // ---- Club note-pops (Phase 7: in-car note notifications) ----
  // When the loaded book is the current book of a club the user is in, we watch
  // playback cross that book's note timestamps and post a MessagingStyle
  // notification (Android Auto reads it aloud + offers a voice reply). See
  // docs/social.md "Phase 7". Detection reuses core's detectNotePops rule,
  // reimplemented here (~5 lines) since the car can't run the TS core.

  // The club whose current book == currentItemId, or null (no watching).
  @Volatile private var noteClubId: String? = null
  // That book's note stubs (id + absolute seconds), refreshed on a throttle.
  @Volatile private var noteStubs: List<NoteStub> = emptyList()
  // Previous tick's absolute position (seconds); -1 until the first tick seeds it.
  @Volatile private var notePrevPosSec: Double = -1.0
  // Last time we refreshed stubs from the server (ms), throttled to ~45s.
  @Volatile private var lastNotesFetchMs: Long = 0L

  private data class NoteStub(val id: String, val timeSec: Double)

  // Car-local seen-set of already-notified stub ids, keyed per club, persisted in
  // the "hearthshelf_auto" prefs. NOTE: this is INTENTIONALLY separate from the
  // JS watcher's AsyncStorage seen-set. AsyncStorage on Android is SQLite-backed
  // (RKStorage / Room), not a plain SharedPreferences file, so it can't be read
  // safely from this headless service without opening a Room DB and racing the RN
  // writer. Per docs/social.md "Shared seen-set caveat" we take the documented
  // fallback: a separate car seen-set, accepting at most one duplicate at the
  // car<->phone handoff (a note crossed in the car may re-notify once on the
  // phone, and vice versa). Capped like the JS side.
  private val NOTE_SEEN_CAP = 500
  private val NOTE_CHANNEL_ID = "club-notes"
  // Same key shape JS uses in AsyncStorage (hs.notePops.seen.<clubId>), even
  // though this store is a SEPARATE SharedPreferences file (AsyncStorage is
  // SQLite-backed on Android and not safely readable from this headless service,
  // so a shared store isn't possible - one duplicate at the car<->phone handoff
  // is the accepted tradeoff, see docs/social.md "Shared seen-set caveat"). The
  // matching prefix keeps a future single-source-of-truth unification a drop-in.
  private fun noteSeenKey(clubId: String) = "hs.notePops.seen.$clubId"

  /** The notePops master on/off, mirrored into our prefs by JS (the settings
   *  store persists to AsyncStorage, which we can't read here - see
   *  HearthShelfAutoModule.setNotePopsEnabled). Defaults on. */
  private val notePopsEnabled: Boolean
    get() = prefs.getBoolean("notePopsEnabled", true)

  /**
   * A custom-command button assigned to SLOT_OVERFLOW. In media3 1.10 the legacy
   * MediaSessionCompat custom actions (what the DHU / real head units render) are
   * built from the media-button-preferences in order: BACK-slotted first,
   * FORWARD-slotted second, then the SLOT_OVERFLOW buttons in list order. The
   * custom action carries our drawable resId directly.
   */
  private fun customButton(cmd: String, name: String, icon: String): CommandButton =
    CommandButton.Builder(CommandButton.ICON_UNDEFINED)
      .setDisplayName(name)
      .setCustomIconResId(drawableId(icon))
      .setSessionCommand(SessionCommand(cmd, Bundle.EMPTY))
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  /** Full custom transport row (order = display order on the car): Back Xs, Forward
   *  Xs, Prev chapter, Next chapter, Speed, Bookmark. The car distributes them
   *  across the transport area because onConnect withholds the standard
   *  skip-to-previous/next player commands - with those advertised, Android Auto
   *  renders its own prev/next buttons and shoves every custom action into the
   *  overflow menu instead. */
  private fun customLayout(): ImmutableList<CommandButton> = ImmutableList.of(
    rewindButton(),
    forwardButton(),
    customButton(CMD_PREV_CH, "Previous chapter", "ic_hs_prev_chapter"),
    customButton(CMD_NEXT_CH, "Next chapter", "ic_hs_next_chapter"),
    speedButton(),
    customButton(CMD_BOOKMARK, "Bookmark", "ic_hs_bookmark")
  )

  /** Media3 semantic icon for the user's skip amount. Android Auto can render
   *  these consistently with its own transport controls; unsupported amounts use
   *  the generic skip icon and let the display name carry the exact seconds. */
  private fun rewindIcon(sec: Long): Int = when (sec) {
    5L -> CommandButton.ICON_SKIP_BACK_5
    10L -> CommandButton.ICON_SKIP_BACK_10
    15L -> CommandButton.ICON_SKIP_BACK_15
    30L -> CommandButton.ICON_SKIP_BACK_30
    else -> CommandButton.ICON_SKIP_BACK
  }

  private fun forwardIcon(sec: Long): Int = when (sec) {
    5L -> CommandButton.ICON_SKIP_FORWARD_5
    10L -> CommandButton.ICON_SKIP_FORWARD_10
    15L -> CommandButton.ICON_SKIP_FORWARD_15
    30L -> CommandButton.ICON_SKIP_FORWARD_30
    else -> CommandButton.ICON_SKIP_FORWARD
  }

  /** Drawable NAME for a skip button whose numeral matches the user's chosen
   *  seconds. Used only as a fallback resource for controllers that can't render
   *  Media3's semantic icons. */
  private fun skipIconName(prefix: String, sec: Long): String {
    val named = "${prefix}_$sec"
    return if (drawableId(named) != 0) named else prefix
  }

  private fun rewindButton(): CommandButton {
    val icon = skipIconName("ic_hs_rewind", rewindSec)
    return CommandButton.Builder(rewindIcon(rewindSec))
      .setDisplayName("Back ${rewindSec}s")
      .setCustomIconResId(drawableId(icon))
      .setSessionCommand(SessionCommand(CMD_REWIND, Bundle.EMPTY))
      .setSlots(CommandButton.SLOT_BACK, CommandButton.SLOT_OVERFLOW)
      .build()
  }

  private fun forwardButton(): CommandButton {
    val icon = skipIconName("ic_hs_forward", forwardSec)
    return CommandButton.Builder(forwardIcon(forwardSec))
      .setDisplayName("Forward ${forwardSec}s")
      .setCustomIconResId(drawableId(icon))
      .setSessionCommand(SessionCommand(CMD_FORWARD, Bundle.EMPTY))
      .setSlots(CommandButton.SLOT_FORWARD, CommandButton.SLOT_OVERFLOW)
      .build()
  }

  /** The Speed button shows the CURRENT rate as its icon ("1.25x"), like every
   *  audiobook player's speed control. Icons are generated per preset by
   *  gen-skip-icons.js; an unknown rate falls back to the speedometer glyph.
   *  onCustomCommand republishes the layout after each cycle so the badge
   *  updates live on the car. */
  private fun speedButton(): CommandButton {
    val rate = rawPlayer?.playbackParameters?.speed ?: 1.0f
    val s = if (rate == rate.toInt().toFloat()) rate.toInt().toString()
      else rate.toString().trimEnd('0').trimEnd('.')
    val named = "ic_hs_speed_${s.replace('.', '_')}x"
    val icon = if (drawableId(named) != 0) named else "ic_hs_speed"
    return customButton(CMD_SPEED, "Speed ${s}x", icon)
  }

  override fun onCreate() {
    super.onCreate()

    // Warm the SharedPreferences file OFF the main thread. The first
    // getSharedPreferences for a name does synchronous disk I/O (parse the whole
    // XML) on whatever thread asks, and this service's onCreate used to ask
    // first - via a log line that read serverUrl + token. Sentry HS-MOBILEAPP-N
    // is a Background ANR whose blocked main-thread frame is the
    // MediaLibrarySession build() a few lines below, so every avoidable
    // millisecond of disk and lock work in this window matters. The io executor
    // is single-threaded, so this task is also the ONLY thing that can be
    // loading prefs when it runs; a later main-thread read either finds it
    // loaded or blocks on the same one-time load it would have done itself, so
    // there is no correctness change - only a chance to have finished early.
    // It also pre-resolves the drawable ids the layout below needs, for the same
    // reason: whichever thread asks first pays for the lookup.
    submitIo("onCreate") {
      try {
        prefs.getString("serverUrl", null)
        for (n in WARM_DRAWABLES) drawableId(n)
        drawableId(skipIconName("ic_hs_rewind", rewindSec))
        drawableId(skipIconName("ic_hs_forward", forwardSec))
      } catch (e: Exception) {
        // Warming is best-effort: the real call sites resolve on demand anyway.
      }
    }

    // HearthShelf flame as the notification small icon (not Media3's default).
    val notificationProvider = DefaultMediaNotificationProvider.Builder(this).build().apply {
      setSmallIcon(drawableId("ic_hs_notification"))
    }
    setMediaNotificationProvider(notificationProvider)

    // Audiobook audio attributes + focus handling, and pause when the output
    // route drops to the phone speaker (car disconnect, BT drop, headset yank) -
    // playback must not continue out loud on the phone when the car goes away.
    val player = ExoPlayer.Builder(this)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(C.USAGE_MEDIA)
          .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
          .build(),
        true
      )
      .setHandleAudioBecomingNoisy(true)
      .build()
    rawPlayer = player

    // Apply the resume position once the freshly-loaded item is ready, and report
    // progress back to ABS so the car doesn't reset the book to the start. Sync
    // uses the ABSOLUTE book position derived from the current chapter window.
    player.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_READY && pendingSeekMs >= 0) {
          val off = pendingSeekMs
          pendingSeekMs = -1
          // One continuous window: a single absolute seek (fast), not a
          // seek-into-window-N over a freshly-prepared clip (the slow path).
          player.seekTo(off)
        }
        if (state == Player.STATE_ENDED) {
          // Guard the queue-advance: a spurious ENDED (e.g. reached before the
          // resume position was applied) would tell JS the book finished and
          // swap the phone to the next queue item. Only advance when playback
          // actually reached the end of the book.
          val posMs = absolutePositionMs(player)
          val durMs = (absDurationSec * 1000).toLong()
          // An EMPTY player prepares straight to ENDED (duration C.TIME_UNSET,
          // no loaded item) - that is not a finished book. Sentry HS-MOBILEAPP-F
          // caught exactly this: ENDED fired from inside prepare() with
          // durMs=Long.MIN_VALUE and item=null, and an earlier `durMs <= 0`
          // guard would have treated it as "finished" and swapped the phone to
          // the next queue item. Require a real loaded book AND a real duration.
          val hasBook = currentItemId != null && player.currentMediaItem != null
          val nearEnd = hasBook && durMs > 0 && posMs >= durMs - 5000
          if (hasBook) syncProgress(posMs, force = true)
          if (nearEnd) {
            // Book finished: let JS advance the shared up-next queue (server owns
            // it). The store change flows back to load the next book.
            HearthShelfAutoModule.emitEnded()
          }
        }
      }
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        // Mirror car play/pause into the JS store so the phone UI stays in sync.
        HearthShelfAutoModule.emitState(isPlaying)
        HearthShelfAutoModule.emitProgress(absolutePositionMs(player) / 1000.0)
        // The progress tick lives exactly as long as playback does. Pausing must
        // still force a sync: the tick is about to stop, so this is the last
        // chance to bank the position.
        if (isPlaying) {
          startTick()
        } else {
          stopTick()
          syncProgress(absolutePositionMs(player), force = true)
        }
      }
      override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
        // The car player had NO error handler: a failed stream or prepare (expired
        // token, dead network, unplayable media) died silently, leaving the head
        // unit stuck with no signal anywhere. Report it so it is diagnosable.
        Log.e(TAG, "car playerError ${error.errorCodeName} item=$currentItemId", error)
        try {
          Sentry.captureException(error)
        } catch (e: Throwable) {
          // reporting must never break playback
        }
        // Reporting alone left the head unit silent and stuck: the error was
        // diagnosable afterwards but nothing tried to recover, and there is no
        // "tap play again" in a car worth asking a driver to do.
        //
        // A recoverable transport fault (the stream died mid-book) is answered by
        // asking JS to hand the book over again, which re-prepares the car player
        // from the live position - the same channel an empty car player already
        // uses. Content faults would reproduce on reload, so they are only
        // reported, as before.
        if (isRecoverableSourceError(error) && noteStreamRetry()) {
          HearthShelfAutoModule.emitCarNeedsBook()
        }
      }
    })

    // The book loads as ONE continuous media item (whole-file stream), so resume
    // is a single absolute seek instead of preparing a deep-offset clip - that
    // clipped-window design cost ~a minute of buffering on a mid-book car resume.
    // Chapters are tracked logically (the `chapters` list drives the skip buttons,
    // bookmark, and absolute<->chapter math). Chapter nav happens through OUR
    // custom prev/next-chapter buttons, not the standard transport (onConnect
    // withholds seek-to-previous/next so the car frees those slots for the custom
    // row). A distinct session id is required; the phone service also runs one.
    // Media-button-preferences (not setCustomLayout) is what media3 1.10 converts
    // into the LEGACY MediaSessionCompat custom actions Android Auto renders.
    // The SESSION gets the chapter-scoped wrapper (so the car scrubber tracks the
    // current chapter); rawPlayer stays the real ExoPlayer, which all our internal
    // math (absolutePositionMs, seeks, sync) drives in absolute book time.
    session = MediaLibrarySession.Builder(this, ChapterForwardingPlayer(player), LibraryCallback())
      .setId("hearthshelf_auto")
      .setMediaButtonPreferences(customLayout())
      .build()

    // The tick is NOT started here. It is armed by onIsPlayingChanged, so a
    // service that exists but isn't playing costs nothing (see progressTick).
  }

  private val progressHandler = android.os.Handler(android.os.Looper.getMainLooper())

  // Whether progressTick is currently scheduled. Only ever touched on the main
  // thread (the Handler's thread), so a plain Boolean is enough.
  private var tickRunning = false

  /**
   * The 1Hz tick runs ONLY while audio is actually playing.
   *
   * It used to repost itself unconditionally forever from onCreate, so a service
   * that had been created and then sat idle - which is most of this service's
   * life, since Android Auto creates it on connect and the system keeps it around
   * afterwards - still woke the main thread 3600 times an hour to ask
   * `isPlaying`, plus a Handler message + Looper wake each time. Sentry
   * HS-MOBILEAPP-N is a BACKGROUND ANR (in_foreground: false) whose main thread
   * was blocked in the session build, with 3.8s of GC in the same report: that is
   * a contention-and-allocation picture, and a permanent idle main-thread loop is
   * exactly the kind of avoidable contention feeding it.
   *
   * Arming is driven by onIsPlayingChanged, the same callback that already
   * mirrors play/pause into JS, so the tick's lifetime is tied to the one
   * condition its body checked anyway. onDestroy still cancels it.
   */
  private val progressTick = object : Runnable {
    override fun run() {
      val player = rawPlayer
      if (player == null || !player.isPlaying) {
        // Playback stopped without onIsPlayingChanged landing first (player
        // released, or a state we did not get a callback for): stand down rather
        // than keep the loop alive.
        tickRunning = false
        return
      }
      // Mirror the car's absolute book position into the JS store every tick
      // so the phone UI's scrubber advances in step with the car.
      HearthShelfAutoModule.emitProgress(absolutePositionMs(player) / 1000.0)
      syncProgress(absolutePositionMs(player), force = false)
      // One continuous item, so the now-playing chapter subtitle no longer
      // changes on its own - refresh it when playback crosses a boundary.
      refreshChapterMeta(player)
      checkNotes(player)
      progressHandler.postDelayed(this, 1000)
    }
  }

  /** Arm the tick if playback is live and it isn't already scheduled. Main thread
   *  only (callers are player callbacks and runOnMain blocks). */
  private fun startTick() {
    if (tickRunning) return
    tickRunning = true
    progressHandler.postDelayed(progressTick, 1000)
  }

  private fun stopTick() {
    tickRunning = false
    progressHandler.removeCallbacks(progressTick)
  }

  /** ExoPlayer must be touched on its Looper (the main thread). JS transport
   *  commands arrive on RN's native-modules thread, so hop first. */
  private fun runOnMain(block: () -> Unit) {
    if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) block()
    else progressHandler.post(block)
  }

  /** Previous-chapter: restart the current chapter if we're >3s into it (matching
   *  the in-app player), otherwise jump to the previous chapter's start. One
   *  continuous window, so both are absolute seeks. */
  private fun prevChapter(player: Player) {
    val sec = absolutePositionMs(player) / 1000.0
    val idx = chapters.indexOfFirst { sec >= it.start && sec < it.end }
    val intoChapterMs = if (idx >= 0) ((sec - chapters[idx].start) * 1000).toLong() else Long.MAX_VALUE
    if (intoChapterMs > 3000 || idx <= 0) {
      // Restart the current chapter (or the book start if we're in the first).
      seekToAbsolute(player, if (idx > 0) (chapters[idx].start * 1000).toLong() else 0L)
    } else {
      seekToAbsolute(player, (chapters[idx - 1].start * 1000).toLong())
    }
  }

  /** Next-chapter: jump to the next chapter's start. From inside the LAST
   *  chapter there is nowhere further to skip, so the book is finished instead
   *  (matching the phone and CarPlay surfaces). */
  private fun nextChapter(player: Player) {
    val sec = absolutePositionMs(player) / 1000.0
    val idx = chapters.indexOfFirst { sec >= it.start && sec < it.end }
    val last = chapters.size - 1
    if (idx in 0 until last) {
      seekToAbsolute(player, (chapters[idx + 1].start * 1000).toLong())
    } else if (chapters.isNotEmpty()) {
      finishBook(player)
    }
  }

  /**
   * Finish the current book from the car: stop, bank the final position, mark it
   * finished on the server, and let JS advance the shared up-next queue.
   *
   * Done natively rather than by seeking to the end and waiting for STATE_ENDED:
   * a seek to exactly the duration is not a reliable way to reach ENDED (and
   * reaches it not at all while paused). Marking finished here also means the
   * car still works when JS isn't running - the emitter below is null whenever
   * Android Auto is driving standalone, which is the common case.
   */
  private fun finishBook(player: Player) {
    val id = currentItemId ?: return
    player.pause()
    val posMs = absolutePositionMs(player)
    // Bank the listened time first so the finish PATCH can't race the position
    // sync and leave the last stretch of listening uncredited.
    syncProgress(posMs, force = true)
    val base = serverUrl
    val tok = token
    // onCustomCommand runs on the MAIN thread - the PATCH must hop to io.
    if (base != null && tok != null && !offlineMode()) {
      submitIo("markFinished") { httpPatchFinished("$base/api/me/progress/$id", tok) }
    } else {
      // Offline: bank the finish onto the same per-listen ledger the position
      // rides on, so it replays with everything else on reconnect rather than
      // being lost. Ordered behind the syncProgress bank above (same executor),
      // which is what created the entry this flags.
      submitIo("markOfflineFinished") { markOfflineFinished() }
    }
    // Queue advance stays JS-owned (server owns the queue) - same contract as a
    // natural end. No-op when JS isn't attached; the finish above still landed.
    HearthShelfAutoModule.emitEnded()
  }

  /**
   * Mark an item finished (ABS PATCH /api/me/progress/:id).
   *
   * Uses OkHttp (on the classpath via React Native) rather than the
   * HttpURLConnection helper the other calls here use: its method whitelist has
   * no PATCH, and setRequestMethod("PATCH") throws ProtocolException. An
   * X-HTTP-Method-Override header is not a way around it either - ABS's Express
   * app mounts no method-override middleware, so the request would land on the
   * POST route and silently fail to finish the book.
   */
  private fun httpPatchFinished(urlStr: String, tok: String) {
    try {
      val client = OkHttpClient.Builder()
        .connectTimeout(8, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(8, java.util.concurrent.TimeUnit.SECONDS)
        .build()
      val body = JSONObject().put("isFinished", true).toString()
        .toRequestBody("application/json".toMediaType())
      val req = Request.Builder()
        .url(urlStr)
        .patch(body)
        .header("Authorization", "Bearer $tok")
        .build()
      client.newCall(req).execute().use { res ->
        if (!res.isSuccessful) Log.w(TAG, "finish failed: HTTP ${res.code}")
      }
    } catch (e: Exception) {
      Log.w(TAG, "finish failed: ${e.message}")
    }
  }

  /** POST a bookmark at the given position (labelled with the chapter title), or
   *  queue it for the app to push when there's no server to take it. */
  private fun bookmarkNow(posSec: Double) {
    val id = currentItemId ?: return
    val ch = chapters.firstOrNull { posSec >= it.start && posSec < it.end }
    val title = ch?.title ?: "Bookmark"
    // The whole decision hops to io, not just the POST. Its inputs are prefs
    // reads (first-load disk I/O), offlineMode() -> networkUp() (a binder round
    // trip to ConnectivityManager), and on the offline branch a prefs read +
    // JSON rewrite + commit - and bookmarkNow's caller is onCustomCommand, a
    // media3 callback, which runs on the MAIN thread. Only the player reads
    // (position, chapters) above need the caller's thread, and they are done.
    submitIo("bookmarkNow") {
      val base = serverUrl
      val tok = token
      if (base == null || tok == null || offlineMode()) {
        queueOfflineBookmark(id, posSec, title)
        return@submitIo
      }
      try {
        val conn = (URL("$base/api/items/$id/bookmarks").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          setRequestProperty("Authorization", "Bearer $tok")
          setRequestProperty("Content-Type", "application/json")
          doOutput = true
          connectTimeout = 8000
          readTimeout = 8000
        }
        val body = JSONObject().put("time", posSec.toInt()).put("title", title)
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        if (conn.responseCode !in 200..299) queueOfflineBookmark(id, posSec, title)
      } catch (e: Exception) {
        Log.w(TAG, "bookmark failed: ${e.message}")
        queueOfflineBookmark(id, posSec, title)
      }
    }
  }

  /** Park a bookmark the car couldn't POST in prefs. JS drains it into the app's
   *  pending-bookmark ledger at the next launch, which pushes it on reconnect -
   *  otherwise a bookmark set on a dead network just disappears. */
  private fun queueOfflineBookmark(itemId: String, posSec: Double, title: String) {
    try {
      val raw = prefs.getString("offlineBookmarks", null)
      val arr = if (raw != null) JSONArray(raw) else JSONArray()
      val time = posSec.toInt()
      // Same book + same second is the same bookmark; don't stack duplicates.
      for (i in 0 until arr.length()) {
        val b = arr.getJSONObject(i)
        if (b.optString("itemId") == itemId && b.optInt("time") == time) return
      }
      arr.put(
        JSONObject()
          .put("itemId", itemId)
          .put("time", time)
          .put("title", title)
          .put("createdAt", System.currentTimeMillis())
      )
      prefs.edit().putString("offlineBookmarks", arr.toString()).apply()
      Log.i(TAG, "bookmark queued offline item=$itemId at ${time}s")
    } catch (e: Exception) {
      Log.w(TAG, "offline bookmark queue failed: ${e.message}")
    }
  }

  /** POST progress to ABS (throttled to ~15s unless forced on pause/stop). With no
   *  play session behind it - a downloaded book playing offline - the same tick
   *  banks the position locally instead, so the listen survives to the next sync. */
  private fun syncProgress(posMs: Long, force: Boolean, awaitFinal: Boolean = false) {
    val sec = posMs / 1000.0
    if (!force && kotlin.math.abs(sec - lastSyncedSec) < 15.0) return
    val elapsed = kotlin.math.max(0.0, sec - lastSyncedSec)
    lastSyncedSec = sec
    val offline = playingOffline || absSessionId == null
    val sid = absSessionId
    // Everything past this point is disk or network, and EVERY caller of
    // syncProgress is on the main thread (the tick, onIsPlayingChanged,
    // onPlaybackStateChanged, onDestroy). The offline branch in particular used
    // to read prefs, parse the banked-progress JSON, rebuild it and commit an
    // edit inline - i.e. real disk work on the main thread once per sync window
    // for the whole of an offline listen. Hop to io for both branches; the
    // position/elapsed values are already captured, so what gets banked or
    // POSTed is identical to what the caller computed.
    //
    // Banking stays on io even for the final onDestroy sync, so it stays ordered
    // behind any bank still queued: recordOfflineProgress is a read-modify-write
    // of both offlineListenedSec and the offlineProgress blob, and running the
    // last one on the main thread in parallel with a queued one could drop
    // listened time or clobber the row. `awaitFinal` instead makes onDestroy WAIT for
    // this task to finish (see awaitSync) - the write still lands before the
    // process can go away, and it lands in order.
    val task = io.submit {
      try {
        if (offline) {
          // A jump bigger than a sync window is a seek, not listening - don't
          // credit it as time listened (same rule the phone's tick uses).
          recordOfflineProgress(sec, if (elapsed <= 60.0) elapsed else 0.0)
          return@submit
        }
        val id = sid ?: return@submit
        val base = serverUrl ?: return@submit
        val tok = token ?: return@submit
        httpPostSync("$base/api/session/$id/sync", tok, sec, elapsed, absDurationSec)
      } catch (e: Exception) {
        Log.w(TAG, "sync failed: ${e.message}")
      }
    }
    if (awaitFinal) awaitSync(task, offline)
  }

  /**
   * Wait (briefly) for the final onDestroy sync to land.
   *
   * This is the ONE place this service blocks the main thread on purpose, and it
   * is not a media3 callback - onDestroy is already the teardown path, and the
   * process can be killed right after it returns, so a fire-and-forget bank of
   * the last offline position could simply be lost. The budget is deliberately
   * small: an offline bank is a prefs write (fast), while the online branch is an
   * 8s+8s HTTP POST that we must NOT sit through - that one keeps the old
   * fire-and-forget behavior with only a token wait, because ABS also has the
   * position from the previous throttled sync.
   */
  private fun awaitSync(task: java.util.concurrent.Future<*>, offline: Boolean) {
    try {
      task.get(if (offline) 1500L else 150L, java.util.concurrent.TimeUnit.MILLISECONDS)
    } catch (e: Exception) {
      // Timed out, interrupted, or the task threw: nothing further to do here.
      Log.w(TAG, "final sync did not complete in time: ${e.message}")
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
    session

  override fun onDestroy() {
    stopTick()
    // Hand control back to the phone player and tell JS the car is gone, so the
    // phone UI stops mirroring and resumes driving the phone service.
    carControllers.clear()
    if (HearthShelfAutoModule.carPlayer === carPlayerImpl) {
      HearthShelfAutoModule.carPlayer = null
      HearthShelfAutoModule.emitCarActive(false)
    }
    // Persist the final ABSOLUTE position so closing the car app doesn't lose it.
    // awaitFinal: the offline bank must complete before this process can go away.
    rawPlayer?.let { val abs = absolutePositionMs(it); if (abs > 0) syncProgress(abs, force = true, awaitFinal = true) }
    session?.run {
      player.release()
      release()
    }
    rawPlayer = null
    session = null
    // Shut the io pool down, or its thread outlives the service.
    //
    // Executors.newSingleThreadExecutor() creates a NON-DAEMON thread that stays
    // alive (and keeps this service instance reachable) until it is shut down
    // explicitly. Android creates and destroys this service repeatedly across a
    // process - every Auto connect, every notification revive - and each cycle
    // used to strand another live thread plus everything it retained. A crash
    // arrived from a pool numbered `pool-12252-thread-1` (HS-MOBILEAPP-1K): by
    // then the heap was exhausted and the OOM landed on whatever allocated next,
    // which is why it surfaced as an unrelated getSharedPreferences frame.
    //
    // shutdown() (not shutdownNow()) so the final progress sync banked just above
    // still runs to completion - it is already awaited, and dropping it here
    // would lose the listened position that awaitFinal exists to protect.
    io.shutdown()
    super.onDestroy()
  }

  // ---- browse-tree ids ----
  // Root tabs.
  private val ROOT = "root"
  private val CONTINUE = "continue"
  private val NEW = "new"
  private val LIBRARY = "library"
  private val DISCOVER = "discover"
  // Library drill-down. Each carries the ABS library id after the ':'.
  private val LIB_BOOKS = "books:"     // books:<libId>       -> books in that library
  private val LIB_SERIES = "series:"   // series:<libId>      -> series list
  private val SERIES = "seriesitems:"  // seriesitems:<libId>:<seriesId> -> books in a series
  private val LIB_PODS = "pods:"       // pods:<libId>        -> podcasts in that library
  private val POD = "podeps:"          // podeps:<libId>:<podId> -> episodes of a podcast
  // Discover shelves from the JS snapshot.
  private val DISC_SHELF = "disc:"     // disc:<shelfId>      -> books in a Discover shelf
  private val PLAY_PREFIX = "play:"
  // Offline (downloaded-books) tree. Distinct ids from the online nodes so the
  // two trees can't be confused in the car's browse cache.
  private val OFF_ALL = "off:all"         // every downloaded book, A-Z
  private val OFF_SERIES = "off:series"   // series that have a downloaded book
  private val OFF_SERIES_ITEMS = "off:series:" // off:series:<seriesId>

  /**
   * Last search's results, cached so onGetSearchResult can serve them without a
   * second round-trip to ABS. onSearch does the query, stashes the books here,
   * then notifies the client of the count; the client then pulls pages from this.
   */
  @Volatile private var lastSearchQuery: String? = null
  @Volatile private var lastSearchItems: List<MediaItem> = emptyList()

  private inner class LibraryCallback : MediaLibrarySession.Callback {

    /** Grant our custom commands so the buttons are actionable, and publish the
     *  full custom layout (skip / chapter / speed / bookmark) to this controller.
     *  The standard seek-to-previous/next player commands are withheld from CAR
     *  controllers: with them advertised, Android Auto renders its own prev/next
     *  buttons and pushes all custom actions into the overflow menu. Chapter nav
     *  still works - the custom prev/next-chapter buttons call the player
     *  directly, and the Queue's jump-to-chapter uses COMMAND_SEEK_TO_MEDIA_ITEM,
     *  which stays available.
     *
     *  Every OTHER controller keeps them, which is what makes steering-wheel and
     *  headset skip keys work: those are hardware keys dispatched through the
     *  media-button receiver (not the car's own UI), so withholding the commands
     *  globally left them bound to nothing (HS-MOBILEAPP-14). They land on
     *  ChapterForwardingPlayer.seekToNext/Previous, which skip by the listener's
     *  configured seconds rather than changing track. */
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo
    ): MediaSession.ConnectionResult {
      val available = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS
        .buildUpon()
        .add(SessionCommand(CMD_REWIND, Bundle.EMPTY))
        .add(SessionCommand(CMD_FORWARD, Bundle.EMPTY))
        .add(SessionCommand(CMD_PREV_CH, Bundle.EMPTY))
        .add(SessionCommand(CMD_NEXT_CH, Bundle.EMPTY))
        .add(SessionCommand(CMD_SPEED, Bundle.EMPTY))
        .add(SessionCommand(CMD_BOOKMARK, Bundle.EMPTY))
        .build()
      // Only the car's own UI needs these withheld (see the note above); the
      // media-button/notification controller must keep them or hardware skip
      // keys are filtered out before they reach the player.
      val playerCommands = if (isCarController(controller)) {
        MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS
          .buildUpon()
          .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
          .remove(Player.COMMAND_SEEK_TO_NEXT)
          .remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
          .remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
          .build()
      } else {
        MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS
      }
      if (isCarController(controller)) {
        // Announce the takeover exactly ONCE. Sentry showed `car took over`
        // firing twice (two controllers connecting), which drove JS to push the
        // book twice - two ABS sessions and a doubled load. The set add and the
        // size check must be atomic, or both controllers can see size == 1.
        val isFirst = synchronized(carControllers) {
          carControllers.add(controller.packageName) && carControllers.size == 1
        }
        // First car controller: the car now owns playback. Route JS transport
        // here and tell the phone to stand down.
        if (isFirst) {
          HearthShelfAutoModule.carPlayer = carPlayerImpl
          HearthShelfAutoModule.emitCarActive(true)
        }
      }
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(available)
        .setAvailablePlayerCommands(playerCommands)
        .setMediaButtonPreferences(customLayout())
        .build()
    }

    override fun onDisconnected(
      session: MediaSession,
      controller: MediaSession.ControllerInfo
    ) {
      val wasLast = synchronized(carControllers) {
        val removed = carControllers.remove(controller.packageName)
        // Release the load guard so the NEXT takeover can load again.
        if (removed && carControllers.isEmpty()) { loadingItemId = null; true } else false
      }
      if (wasLast) {
        // Last car controller left (unplugged / Auto closed): hand playback back
        // to the phone player and let the phone UI resume driving it.
        if (HearthShelfAutoModule.carPlayer === carPlayerImpl) {
          HearthShelfAutoModule.carPlayer = null
          HearthShelfAutoModule.emitCarActive(false)
        }
      }
    }

    /** True when a controller is a car head unit (Android Auto projection or
     *  Automotive OS), not our own in-app MediaController or the system UI. Those
     *  are the controllers that mean "the car owns playback now". */
    private fun isCarController(controller: MediaSession.ControllerInfo): Boolean {
      val pkg = controller.packageName
      if (pkg == packageName) return false // our own controller (notification keep-alive)
      return pkg == "com.google.android.projection.gearhead" ||
        pkg == "com.google.android.autosimulator" ||
        pkg.startsWith("com.android.car")
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle
    ): ListenableFuture<SessionResult> {
      // MUST be rawPlayer: session.player is the ChapterForwardingPlayer, whose
      // position/seek are chapter-relative. Our commands work in absolute book
      // time, so feeding them the wrapper would double-translate every seek.
      val player = rawPlayer ?: return Futures.immediateFuture(
        SessionResult(SessionResult.RESULT_ERROR_INVALID_STATE)
      )
      when (customCommand.customAction) {
        // Skip in ABSOLUTE book time so 15s/30s cross chapter boundaries instead
        // of clamping at the current window's clip edges.
        CMD_REWIND -> seekToAbsolute(player, (absolutePositionMs(player) - rewindSec * 1000).coerceAtLeast(0))
        CMD_FORWARD -> {
          val totalMs = (absDurationSec * 1000).toLong()
          val target = absolutePositionMs(player) + forwardSec * 1000
          seekToAbsolute(player, if (totalMs > 0) target.coerceAtMost(totalMs) else target)
        }
        CMD_PREV_CH -> prevChapter(player)
        CMD_NEXT_CH -> nextChapter(player)
        CMD_SPEED -> {
          val next = SPEED_PRESETS.firstOrNull { it > player.playbackParameters.speed + 0.001f }
            ?: SPEED_PRESETS.first()
          player.setPlaybackSpeed(next)
          // Refresh the Speed badge icon to the new rate.
          session.setMediaButtonPreferences(customLayout())
        }
        CMD_BOOKMARK -> bookmarkNow(absolutePositionMs(player) / 1000.0)
        else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
      }
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<MediaItem>> {
      return Futures.immediateFuture(LibraryResult.ofItem(browsable(ROOT, "HearthShelf"), params))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      // Return the future itself - never .get() here. This callback runs on the
      // main thread and childrenOf() is network-backed.
      return io.submit<LibraryResult<ImmutableList<MediaItem>>> {
        try {
          val kids = childrenOf(parentId)
          Log.i(TAG, "onGetChildren parent=$parentId -> ${kids.size} items")
          LibraryResult.ofItemList(kids, params)
        } catch (e: Exception) {
          Log.e(TAG, "onGetChildren parent=$parentId FAILED", e)
          LibraryResult.ofItemList(ImmutableList.of(), params)
        }
      }
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String
    ): ListenableFuture<LibraryResult<MediaItem>> {
      return Futures.immediateFuture(LibraryResult.ofItem(browsable(mediaId, mediaId), null))
    }

    /**
     * The car selected a playable book. Its MediaItem carries only the item id
     * (browse items have no real stream URL). Resolve it now by creating an ABS
     * play session and swapping in the real, token-bearing stream URL.
     *
     * onSetMediaItems (not onAddMediaItems) so we can hand back the RESUME
     * POSITION alongside the item: preparation then begins at that offset instead
     * of at 0-then-seek, which is what made a mid-book car resume buffer for
     * ~a minute (and let the player reach STATE_ENDED before the seek landed).
     */
    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      // Returned directly (no .get()): resolveBookItem opens an ABS play session,
      // and blocking the main thread on it is an ANR on a slow network.
      return io.submit<MediaSession.MediaItemsWithStartPosition> {
        // Resolve the FIRST selected book (one continuous stream online, one item
        // per track file when playing a download offline). Extra selected items
        // are ignored - the car sends one book at a time.
        val first = mediaItems.firstOrNull()
        if (first != null) {
          val id = first.mediaId.removePrefix(PLAY_PREFIX)
          val loaded = resolveBook(id)
          if (loaded != null) {
            // Start AT the saved position (split into window + offset for a
            // multi-file download) so prepare begins there rather than at 0.
            val (idx, offsetMs) = windowFor(loaded.startMs)
            return@submit MediaSession.MediaItemsWithStartPosition(
              loaded.items.toMutableList(), idx, offsetMs,
            )
          }
        }
        MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs)
      }
    }

    /**
     * The car's voice/text search ("play <book>"). Query ABS across every book
     * library, cache the hits, then tell the client how many we found - it will
     * follow up with onGetSearchResult to actually pull the items.
     */
    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<Void>> {
      // Returned directly (no .get()): searchAll fans out across libraries.
      return io.submit<LibraryResult<Void>> {
        try {
          val items = searchItems(query)
          lastSearchQuery = query
          lastSearchItems = items
          Log.i(TAG, "onSearch query=\"$query\" -> ${items.size} items")
          session.notifySearchResultChanged(browser, query, items.size, params)
          LibraryResult.ofVoid(params)
        } catch (e: Exception) {
          Log.e(TAG, "onSearch query=\"$query\" FAILED", e)
          lastSearchQuery = query
          lastSearchItems = emptyList()
          session.notifySearchResultChanged(browser, query, 0, params)
          LibraryResult.ofVoid(params)
        }
      }
    }

    /** Serve a page of the results that onSearch cached for this query. */
    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      // Returned directly (no .get()): a cache miss re-runs the network search.
      return io.submit<LibraryResult<ImmutableList<MediaItem>>> {
        try {
          // The client searches before paging, so the cache is normally warm.
          // Re-run on a cache miss (e.g. a different query) to stay correct.
          val items = if (query == lastSearchQuery) lastSearchItems else searchItems(query)
          val from = page * pageSize
          val pageItems = if (from >= items.size) emptyList()
            else items.subList(from, minOf(from + pageSize, items.size))
          Log.i(TAG, "onGetSearchResult query=\"$query\" page=$page -> ${pageItems.size} items")
          LibraryResult.ofItemList(ImmutableList.copyOf(pageItems), params)
        } catch (e: Exception) {
          Log.e(TAG, "onGetSearchResult query=\"$query\" FAILED", e)
          LibraryResult.ofItemList(ImmutableList.of(), params)
        }
      }
    }
  }

  /**
   * Voice/text search results, as browse items. Offline (or when the server search
   * comes back empty) this searches the downloaded books instead - "play <book>"
   * from the driver's seat has to work on a book that's already on the phone.
   */
  private fun searchItems(query: String): List<MediaItem> {
    if (!offlineMode()) {
      val base = serverUrl
      val tok = token
      if (base != null && tok != null) {
        val hits = searchAll(query)
        if (hits.isNotEmpty()) return hits.map { playable(base, tok, it) }
      }
    }
    return offlineSearch(query)
  }

  /** Substring match over the downloaded books' title / author / series. */
  private fun offlineSearch(query: String): List<MediaItem> {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return emptyList()
    return offlineLibrary()
      .filter {
        it.title.lowercase().contains(needle) ||
          it.author.lowercase().contains(needle) ||
          it.seriesName.lowercase().contains(needle)
      }
      .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.sortKey })
      .map { offlinePlayable(it) }
  }

  /** Search every book library and flatten the hits into one de-duped list. */
  private fun searchAll(query: String): List<Book> {
    val base = serverUrl ?: return emptyList()
    val tok = token ?: return emptyList()
    val seen = HashSet<String>()
    val out = mutableListOf<Book>()
    for (lib in bookLibraries(base, tok)) {
      for (b in absSearchLibrary(base, tok, lib.id, query)) {
        if (seen.add(b.id)) out.add(b)
      }
    }
    return out
  }

  /** The player items for a book plus the absolute position to start at. Usually
   *  one item (the whole ABS stream); a downloaded book played offline is one item
   *  per track file. */
  private data class LoadedBook(val items: List<MediaItem>, val startMs: Long)

  /**
   * Resolve a selected book into something playable, preferring the network and
   * falling back to the downloaded copy.
   *
   * Offline we go straight to disk (no point burning 8s on a play POST that can't
   * land). Online we still fall back to the download if the play session fails -
   * a server that's up but wedged, or a token that just expired, shouldn't leave
   * the driver with a book they have sitting on the phone.
   */
  private fun resolveBook(rawId: String): LoadedBook? {
    val itemId = rawId.substringBefore('/')
    if (offlineMode()) return resolveOfflineBook(itemId)
    return resolveStreamBook(rawId) ?: resolveOfflineBook(itemId)
  }

  /**
   * POST /api/items/:id/play, then build ONE continuous MediaItem for the whole
   * book (the raw stream URL, no per-chapter clipping) so resuming mid-book is a
   * single fast seek. Populates `chapters` for the skip buttons / bookmark / note
   * math, stashes resume + sync state for onPlaybackStateChanged, and mirrors the
   * loaded book into the JS store. Returns null when the play session fails.
   */
  private fun resolveStreamBook(rawId: String): LoadedBook? {
    val base = serverUrl ?: return null
    val tok = token ?: return null
    // Podcast episodes arrive as "libraryItemId/episodeId"; books are a plain id.
    val itemId = rawId.substringBefore('/')
    val episodeId = if (rawId.contains('/')) rawId.substringAfter('/') else null
    Log.i(TAG, "resolveBookItem item=$itemId episode=$episodeId")
    val playUrl = if (episodeId != null) "$base/api/items/$itemId/play/$episodeId"
      else "$base/api/items/$itemId/play"
    val body = httpPostPlay(playUrl, tok)
    if (body == null) { Log.e(TAG, "play session failed for $rawId"); return null }
    val session = JSONObject(body)
    val tracks = session.optJSONArray("audioTracks") ?: return null
    if (tracks.length() == 0) return null
    val contentUrl = tracks.getJSONObject(0).optString("contentUrl")
    val streamUrl = "$base$contentUrl?token=$tok"
    val startSec = session.optDouble("currentTime", 0.0)
    val art = "$base/api/items/$itemId/cover?token=$tok"
    val title = session.optString("displayTitle", "Audiobook")
    val author = session.optString("displayAuthor", "")

    absSessionId = session.optString("id").ifEmpty { null }
    absDurationSec = session.optDouble("duration", 0.0)
    lastSyncedSec = startSec
    currentItemId = itemId
    // Streaming: one continuous window, and progress goes to the play session.
    trackOffsets = emptyList()
    playingOffline = false

    // Begin (or clear) club note-watching for this book. Resolving the club is a
    // network call, so do it off the resolve path; the tick starts detecting once
    // noteClubId/noteStubs are populated. Reset per-book watch state first.
    noteClubId = null
    noteStubs = emptyList()
    notePrevPosSec = -1.0
    lastNotesFetchMs = 0L
    setupNoteWatch(itemId, startSec)

    // Stash book metadata for the single continuous item + the subtitle refresh.
    bookTitle = title
    bookAuthor = author
    artUri = art
    shownChapterIdx = -1

    val parsed = parseChapters(session.optJSONArray("chapters"))
    // Fall back to a single full-book chapter when the book has none, so the
    // skip buttons / bookmark / note math still have a chapter to work with.
    chapters = if (parsed.isNotEmpty()) parsed
      else listOf(Chapter(title, 0.0, absDurationSec.coerceAtLeast(0.0)))

    // Mirror the loaded book into the JS store so the phone UI shows the same
    // cover/title/chapters and its scrubber tracks the car. The phone cover
    // resolves from itemId, so hand JS the raw item id (not the tokened URL).
    val chaptersJson = JSONArray().apply {
      for (ch in chapters) {
        put(JSONObject().put("title", ch.title).put("start", ch.start).put("end", ch.end))
      }
    }.toString()
    HearthShelfAutoModule.emitCarLoaded(
      itemId, title, author, art, absDurationSec, startSec, chaptersJson,
    )

    // Resume at the saved absolute position; the caller hands it to the player as
    // the start position so preparation begins there.
    pendingSeekMs = -1
    shownChapterIdx = chapters.indexOfFirst { startSec >= it.start && startSec < it.end }


    // ONE continuous media item for the whole book. The current chapter rides the
    // metadata subtitle (refreshChapterMeta rewrites it as playback crosses
    // chapters); no clipping, so resuming mid-book is a single fast seek instead
    // of a deep-offset clip prepare (that cost ~a minute on a car resume).
    val item = MediaItem.Builder()
      .setMediaId("$PLAY_PREFIX$itemId")
      .setUri(streamUrl)
      .setMediaMetadata(chapterMeta(shownChapterIdx))
      .build()
    return LoadedBook(listOf(item), (startSec * 1000).toLong().coerceAtLeast(0))
  }

  /** Now-playing metadata for the single item: book title, "author · chapter"
   *  subtitle, cover. Rebuilt when playback crosses into a new chapter. */
  private fun chapterMeta(chapterIdx: Int): MediaMetadata {
    val ch = chapters.getOrNull(chapterIdx)
    val subtitle = if (ch != null) "$bookAuthor · ${ch.title}" else bookAuthor
    return MediaMetadata.Builder()
      .setTitle(bookTitle)
      .setArtist(subtitle)
      .setAlbumTitle(bookTitle)
      .apply { if (artUri.isNotEmpty()) setArtworkUri(android.net.Uri.parse(artUri)) }
      .setIsPlayable(true)
      .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
      .build()
  }

  /** Rewrite the now-playing subtitle when playback crosses into a new chapter
   *  (same URI -> no reload/seek), matching the phone player's behavior. */
  private fun refreshChapterMeta(player: Player) {
    if (chapters.isEmpty()) return
    val sec = absolutePositionMs(player) / 1000.0
    val idx = chapters.indexOfFirst { sec >= it.start && sec < it.end }
    if (idx < 0 || idx == shownChapterIdx) return
    shownChapterIdx = idx
    val cur = player.currentMediaItem ?: return
    player.replaceMediaItem(player.currentMediaItemIndex, cur.buildUpon().setMediaMetadata(chapterMeta(idx)).build())
  }

  private data class Chapter(val title: String, val start: Double, val end: Double)

  /**
   * Absolute book position (ms). A streamed book is one continuous window, so the
   * player's own position already IS the absolute position; a downloaded book is a
   * playlist of track files, so the current window's start offset is added.
   */
  private fun absolutePositionMs(player: Player): Long {
    val offsets = trackOffsets
    if (offsets.isEmpty()) return player.currentPosition
    val base = offsets.getOrNull(player.currentMediaItemIndex) ?: return player.currentPosition
    return (base * 1000).toLong() + player.currentPosition
  }

  /** The (window index, window-relative ms) an absolute book position lands in.
   *  (0, absMs) while streaming; the containing track offline. */
  private fun windowFor(absMs: Long): Pair<Int, Long> {
    val target = absMs.coerceAtLeast(0)
    val offsets = trackOffsets
    if (offsets.isEmpty()) return 0 to target
    var idx = 0
    for (i in offsets.indices) if (target >= (offsets[i] * 1000).toLong()) idx = i
    return idx to (target - (offsets[idx] * 1000).toLong()).coerceAtLeast(0)
  }

  /** Seek to an absolute book position (ms) - one seek on the single stream
   *  window, or a seek into the right track file for a local playlist. */
  private fun seekToAbsolute(player: Player, absMs: Long) {
    if (trackOffsets.isEmpty()) {
      player.seekTo(absMs.coerceAtLeast(0))
      return
    }
    val (idx, rel) = windowFor(absMs)
    player.seekTo(idx, rel)
  }

  /** The chapter containing an absolute position (seconds), or null. */
  private fun chapterAt(sec: Double): Chapter? =
    chapters.firstOrNull { sec >= it.start && sec < it.end } ?: chapters.lastOrNull()

  /**
   * Presents CHAPTER-relative position/duration to the car's MediaSession while
   * the wrapped ExoPlayer keeps absolute book time on one continuous stream.
   *
   * Dropping the per-chapter clipped windows (they made a mid-book resume buffer
   * for ~a minute) also lost the car's chapter-scoped scrubber - the head unit
   * started showing the whole book. This restores it the way the phone service
   * already does: translate the numbers, don't clip the media. Seeks arriving in
   * chapter-relative terms (the car scrubber) map back to absolute.
   */
  private inner class ChapterForwardingPlayer(inner: Player) : ForwardingPlayer(inner) {
    /** Absolute book ms of the wrapped player - window-offset aware, so a
     *  downloaded book's per-track playlist still reads as one book. */
    private fun absMs(): Long = absolutePositionMs(wrappedPlayer)
    private fun ch(): Chapter? = if (chapters.isEmpty()) null else chapterAt(absMs() / 1000.0)
    /** Absolute start of the current window (0 while streaming). */
    private fun windowStartMs(): Long =
      ((trackOffsets.getOrNull(wrappedPlayer.currentMediaItemIndex) ?: 0.0) * 1000).toLong()

    override fun getCurrentPosition(): Long {
      val c = ch() ?: return absMs()
      return (absMs() - (c.start * 1000).toLong()).coerceAtLeast(0)
    }
    override fun getContentPosition(): Long = currentPosition
    override fun getDuration(): Long {
      val c = ch()
        ?: return if (absDurationSec > 0) (absDurationSec * 1000).toLong() else super.getDuration()
      return ((c.end - c.start) * 1000).toLong()
    }
    override fun getContentDuration(): Long = duration
    override fun getBufferedPosition(): Long {
      // super's buffered is window-relative; lift it to absolute first.
      val bufferedAbs = windowStartMs() + super.getBufferedPosition()
      val c = ch() ?: return bufferedAbs
      // Buffered is absolute (usually past this chapter's end); clamp into
      // [0, chapterDuration] so the car's buffer bar doesn't overflow.
      val rel = (bufferedAbs - (c.start * 1000).toLong()).coerceAtLeast(0)
      return rel.coerceAtMost(((c.end - c.start) * 1000).toLong())
    }
    override fun seekTo(positionMs: Long) {
      val c = ch()
      seekToAbsolute(wrappedPlayer, if (c != null) (c.start * 1000).toLong() + positionMs else positionMs)
    }

    // MediaSession commands from Android Auto hit this wrapper, including while
    // the raw player is still empty. Remember them independently of ExoPlayer's
    // isPlaying callback so an in-flight load cannot resurrect a paused book.
    override fun play() {
      carWantsPlayback = true
      super.play()
    }

    override fun pause() {
      carWantsPlayback = false
      super.pause()
    }

    override fun setPlayWhenReady(playWhenReady: Boolean) {
      carWantsPlayback = playWhenReady
      super.setPlayWhenReady(playWhenReady)
    }

    /**
     * Steering-wheel / headset skip-track buttons.
     *
     * Those are HARDWARE keys: they dispatch the standard
     * seek-to-next/previous commands and cannot be pointed at our custom skip
     * actions, so with the standard commands withheld they had nothing to bind
     * to and did nothing at all (HS-MOBILEAPP-14/R).
     *
     * For an audiobook "next track" is not a useful action - a book is one long
     * item - so these map to the same absolute-time skip the on-screen buttons
     * use, honoring the listener's configured skip seconds. That matches what
     * other audiobook apps do with the same buttons, and what was asked for:
     * skip forward and back within the chapter.
     *
     * Absolute-time seeks (not window-relative) so a skip near a boundary
     * crosses into the neighbouring chapter instead of clamping at the clip
     * edge, exactly like CMD_REWIND/CMD_FORWARD.
     */
    override fun seekToNext() {
      val totalMs = (absDurationSec * 1000).toLong()
      val target = absMs() + forwardSec * 1000
      seekToAbsolute(wrappedPlayer, if (totalMs > 0) target.coerceAtMost(totalMs) else target)
    }

    override fun seekToPrevious() {
      seekToAbsolute(wrappedPlayer, (absMs() - rewindSec * 1000).coerceAtLeast(0))
    }

    // Media3 routes hardware skip keys through the MEDIA_ITEM variants too
    // (which normally change track); send them to the same skip so the button
    // behaves the same however the head unit dispatches it.
    override fun seekToNextMediaItem() = seekToNext()

    override fun seekToPreviousMediaItem() = seekToPrevious()

    // Media3 asks the player which commands it supports and hides a control when
    // the answer is no. The session withholds the standard seek commands to keep
    // Android Auto from drawing its own prev/next buttons (see onConnect), but
    // the wrapped player must still CLAIM them or the hardware keys are dropped
    // before they reach the overrides above.
    override fun isCommandAvailable(command: Int): Boolean = when (command) {
      Player.COMMAND_SEEK_TO_NEXT,
      Player.COMMAND_SEEK_TO_PREVIOUS,
      Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> true
      else -> super.isCommandAvailable(command)
    }

    override fun getAvailableCommands(): Player.Commands =
      super.getAvailableCommands()
        .buildUpon()
        .add(Player.COMMAND_SEEK_TO_NEXT)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS)
        .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        .build()
  }

  // ---- Club note-pops (Phase 7) ----

  /**
   * If this book is the current book of a club the user is in, remember that
   * club and pull its gated stubs so the tick can watch for crossings. Runs on
   * the io executor (two network calls). No-op when notePops is off, or the book
   * belongs to no club the user is a member of.
   */
  private fun setupNoteWatch(itemId: String, startSec: Double) {
    if (!notePopsEnabled) return
    val base = serverUrl ?: return
    val tok = token ?: return
    submitIo("setupNoteWatch") {
      try {
        val clubId = findClubForBook(base, tok, itemId) ?: return@submitIo
        // Guard against a newer book having loaded while this ran.
        if (currentItemId != itemId) return@submitIo
        noteClubId = clubId
        notePrevPosSec = startSec
        fetchNoteStubs(base, tok, clubId, itemId, startSec)
      } catch (e: Exception) {
        Log.w(TAG, "note watch setup failed: ${e.message}")
      }
    }
  }

  /** GET /hs/clubs?libraryItemId=<id>; return a club id from `mine[]` whose
   *  currentBook.libraryItemId == the item (membership is implied by `mine`). */
  private fun findClubForBook(base: String, tok: String, itemId: String): String? {
    val body = httpGet("$base/hs/clubs?libraryItemId=${enc(itemId)}", tok) ?: return null
    val obj = JSONObject(body)
    if (!obj.optBoolean("enabled", true)) return null
    val mine = obj.optJSONArray("mine") ?: return null
    for (i in 0 until mine.length()) {
      val club = mine.getJSONObject(i)
      val current = club.optJSONObject("currentBook") ?: continue
      if (current.optString("libraryItemId") == itemId) return club.optString("id").ifEmpty { null }
    }
    return null
  }

  /** GET /hs/notes?clubId=&libraryItemId=&position=; parse the locked stubs into
   *  noteStubs. The response also carries unlocked `notes` up to `position`,
   *  which onNoteCrossed reads to get a just-unlocked note's body. */
  private fun fetchNoteStubs(base: String, tok: String, clubId: String, itemId: String, posSec: Double) {
    val url = "$base/hs/notes?clubId=${enc(clubId)}&libraryItemId=${enc(itemId)}&position=${posSec.toInt()}"
    val body = httpGet(url, tok) ?: return
    val obj = JSONObject(body)
    if (!obj.optBoolean("enabled", true)) return
    val locked = obj.optJSONArray("locked") ?: JSONArray()
    val out = mutableListOf<NoteStub>()
    for (i in 0 until locked.length()) {
      val s = locked.getJSONObject(i)
      val id = s.optString("id")
      if (id.isNotEmpty()) out.add(NoteStub(id, s.optDouble("timeSec", 0.0)))
    }
    noteStubs = out
    lastNotesFetchMs = System.currentTimeMillis()
  }

  /**
   * Per-tick note-pop check. Uses the SAME crossing rule as core's
   * detectNotePops: a stub pops when prevPos < timeSec <= nowPos, plus the 0:00
   * edge (timeSec == 0 && prevPos == 0 && nowPos > 0). A backward jump or a
   * forward jump over 30s is a seek: we don't fire (scrubbing in the car must
   * not spam), just advance prevPos and mark the crossed ids seen silently.
   * Refreshes stubs on a ~45s throttle so newly-posted ahead-notes appear.
   */
  private fun checkNotes(player: Player) {
    // Ordered cheapest-first, deliberately. noteClubId is a volatile field and is
    // null unless the loaded book actually belongs to a club the user is in - the
    // common case - so the usual tick now costs one null check instead of the
    // three prefs lookups (notePopsEnabled, serverUrl, token) it used to do every
    // second on the main thread before finding out there was nothing to watch.
    val clubId = noteClubId ?: return
    val stubs = noteStubs
    val itemId = currentItemId ?: return
    if (!notePopsEnabled) return
    val base = serverUrl ?: return
    val tok = token ?: return

    val nowSec = absolutePositionMs(player) / 1000.0

    // Throttled stub refresh (~45s), off the main thread.
    if (System.currentTimeMillis() - lastNotesFetchMs > 45_000L) {
      lastNotesFetchMs = System.currentTimeMillis()
      val posForFetch = nowSec
      submitIo("checkNotes.fetch") {
        try {
          if (currentItemId == itemId && noteClubId == clubId) {
            fetchNoteStubs(base, tok, clubId, itemId, posForFetch)
          }
        } catch (e: Exception) {
          Log.w(TAG, "note stub refresh failed: ${e.message}")
        }
      }
    }

    val prev = notePrevPosSec
    if (prev < 0) { notePrevPosSec = nowSec; return } // seed on first tick
    notePrevPosSec = nowSec

    if (stubs.isEmpty()) return

    val seen = noteSeen(clubId)
    val seeked = nowSec < prev || nowSec - prev > 30.0
    val crossed = stubs.filter {
      val t = it.timeSec
      (!seen.contains(it.id)) &&
        ((t > prev && t <= nowSec) || (t == 0.0 && prev == 0.0 && nowSec > 0.0))
    }.sortedBy { it.timeSec }
    if (crossed.isEmpty()) return

    // Mark every crossed id seen up front (real crossings and seeks) so a note
    // never double-notifies.
    for (s in crossed) seen.add(s.id)
    saveNoteSeen(clubId, seen)

    // A scrub: condense silently (no notification flood). prevPos already
    // advanced above; the ids are marked seen so they won't re-fire on replay.
    if (seeked) {
      Log.i(TAG, "note watch: seek passed ${crossed.size} note(s), suppressed")
      return
    }

    // Normal forward crossing: notify the earliest just-passed note (usually one).
    val stub = crossed.first()
    submitIo("checkNotes.mark") {
      try {
        if (currentItemId == itemId && noteClubId == clubId) {
          onNoteCrossed(base, tok, clubId, itemId, stub)
        }
      } catch (e: Exception) {
        Log.w(TAG, "note crossing notify failed: ${e.message}")
      }
    }
  }

  /**
   * A note just became unlocked at the current position. Fetch it (it's now in
   * the unlocked `notes[]` of a position-gated GET) and post a MessagingStyle
   * notification on the club-notes channel with a voice-reply RemoteInput.
   */
  private fun onNoteCrossed(base: String, tok: String, clubId: String, itemId: String, stub: NoteStub) {
    val url = "$base/hs/notes?clubId=${enc(clubId)}&libraryItemId=${enc(itemId)}&position=${stub.timeSec.toInt() + 1}"
    val body = httpGet(url, tok) ?: return
    val obj = JSONObject(body)
    val notes = obj.optJSONArray("notes") ?: return
    var author = "Book Club"
    var text: String? = null
    for (i in 0 until notes.length()) {
      val n = notes.getJSONObject(i)
      if (n.optString("id") == stub.id) {
        text = n.optString("body")
        author = n.optString("username").ifEmpty { "Book Club" }
        break
      }
    }
    val message = text ?: return
    postNoteNotification(clubId, itemId, stub.id, author, message)
  }

  /** Build + post the MessagingStyle conversation notification. Android Auto reads
   *  the message aloud and surfaces the RemoteInput reply; the phone tap deep-links
   *  to the club note screen. A stable per-note id lets both taps target it. */
  private fun postNoteNotification(
    clubId: String,
    itemId: String,
    noteId: String,
    author: String,
    message: String,
  ) {
    ensureNoteChannel()
    // A stable, positive notification id derived from the note id.
    val notifId = (noteId.hashCode() and 0x7fffffff)

    val person = Person.Builder().setName(author).setKey(author).build()
    val messagingStyle = NotificationCompat.MessagingStyle(person)
      .addMessage(message, System.currentTimeMillis(), person)

    // Phone tap: open the club note screen via the app's deep-link scheme.
    val deepLink = Uri.parse("hearthshelf://club/${enc(clubId)}?note=${enc(noteId)}")
    val contentIntent = Intent(Intent.ACTION_VIEW, deepLink).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val contentPi = PendingIntent.getActivity(
      this, notifId, contentIntent, pendingIntentFlags(),
    )

    // Voice/text reply: routed to NoteReplyReceiver, which POSTs the reply.
    val remoteInput = RemoteInput.Builder(NoteReplyReceiver.KEY_REPLY)
      .setLabel("Reply")
      .build()
    val replyIntent = Intent(this, NoteReplyReceiver::class.java).apply {
      action = NoteReplyReceiver.ACTION_REPLY
      putExtra(NoteReplyReceiver.EXTRA_CLUB_ID, clubId)
      putExtra(NoteReplyReceiver.EXTRA_ITEM_ID, itemId)
      putExtra(NoteReplyReceiver.EXTRA_PARENT_ID, noteId)
      putExtra(NoteReplyReceiver.EXTRA_NOTIF_ID, notifId)
    }
    val replyPi = PendingIntent.getBroadcast(
      this, notifId, replyIntent, pendingIntentFlags(mutable = true),
    )
    val replyAction = NotificationCompat.Action.Builder(
      drawableId("ic_hs_notification"),
      "Reply",
      replyPi,
    )
      .addRemoteInput(remoteInput)
      .setAllowGeneratedReplies(true)
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .build()

    // Mark-as-read: Android Auto requires a MessagingStyle notification to carry
    // a MARK_AS_READ action (paired with reply) before it will read a
    // conversation aloud - without it Auto silently drops the notification. It's
    // added as an invisible action (no on-phone button); Auto consumes it.
    val markReadIntent = Intent(this, NoteReplyReceiver::class.java).apply {
      action = NoteReplyReceiver.ACTION_MARK_READ
      putExtra(NoteReplyReceiver.EXTRA_NOTIF_ID, notifId)
    }
    val markReadPi = PendingIntent.getBroadcast(
      this, notifId + 1, markReadIntent, pendingIntentFlags(),
    )
    val markReadAction = NotificationCompat.Action.Builder(
      drawableId("ic_hs_notification"),
      "Mark as read",
      markReadPi,
    )
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
      .setShowsUserInterface(false)
      .build()

    val notification = NotificationCompat.Builder(this, NOTE_CHANNEL_ID)
      .setSmallIcon(drawableId("ic_hs_notification"))
      .setStyle(messagingStyle)
      .setContentIntent(contentPi)
      .addInvisibleAction(markReadAction)
      .addAction(replyAction)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()

    try {
      NotificationManagerCompat.from(this).notify(notifId, notification)
    } catch (e: SecurityException) {
      // POST_NOTIFICATIONS not granted; nothing else to do.
      Log.w(TAG, "post note notification denied: ${e.message}")
    }
  }

  /** Create the club-notes channel if absent. JS (notifee) normally creates it,
   *  but the headless car service may run before JS did, so we create it too
   *  (idempotent - same id/name as src/lib/notifications.ts). */
  private fun ensureNoteChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(NOTE_CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      NOTE_CHANNEL_ID,
      "Book Club notes",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "Notes from your Book Club when a note you cross is posted."
    }
    mgr.createNotificationChannel(channel)
  }

  // ---- car-local seen-set (per club, in hearthshelf_auto prefs) ----

  // The loaded seen-set and the club it belongs to. checkNotes runs at 1Hz on the
  // main thread and used to re-read + re-JSON-parse this out of prefs on EVERY
  // tick that had stubs to test. This service is the only writer of these keys
  // (JS keeps its own AsyncStorage set - see noteSeenKey), so an in-memory copy
  // is authoritative for the life of the process and prefs is just the durable
  // mirror. Main thread only, like the rest of the tick's state.
  private var noteSeenClubId: String? = null
  private var noteSeenCache: LinkedHashSet<String>? = null

  /** The seen-set for a club, loaded from prefs at most once per club. */
  private fun noteSeen(clubId: String): LinkedHashSet<String> {
    val cached = noteSeenCache
    if (cached != null && noteSeenClubId == clubId) return cached
    val set = loadNoteSeen(clubId)
    noteSeenClubId = clubId
    noteSeenCache = set
    return set
  }

  private fun loadNoteSeen(clubId: String): LinkedHashSet<String> {
    val set = LinkedHashSet<String>()
    val raw = prefs.getString(noteSeenKey(clubId), null) ?: return set
    try {
      val arr = JSONArray(raw)
      for (i in 0 until arr.length()) set.add(arr.getString(i))
    } catch (e: Exception) {
      // corrupt/absent - start fresh (re-pop after this run is acceptable).
    }
    return set
  }

  private fun saveNoteSeen(clubId: String, set: LinkedHashSet<String>) {
    // Keep only the most-recent NOTE_SEEN_CAP ids (insertion order preserved).
    var ids = set.toList()
    if (ids.size > NOTE_SEEN_CAP) ids = ids.subList(ids.size - NOTE_SEEN_CAP, ids.size)
    // Snapshot taken on the caller's thread (so it can't tear while the set keeps
    // being mutated), serialized + committed on io: the caller is checkNotes, on
    // the main thread. The in-memory set is what suppresses a duplicate pop
    // within this run, so the write only has to be durable, not immediate.
    val payload = JSONArray(ids).toString()
    val key = noteSeenKey(clubId)
    submitIo("persistPrefs") { prefs.edit().putString(key, payload).apply() }
  }

  private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

  /** FLAG_IMMUTABLE (or MUTABLE for the reply PendingIntent, which RemoteInput
   *  must fill) with the version-gated flag set 23+ requires. */
  private fun pendingIntentFlags(mutable: Boolean = false): Int {
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      flags = flags or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
    }
    return flags
  }

  private fun parseChapters(arr: org.json.JSONArray?): List<Chapter> {
    if (arr == null) return emptyList()
    return (0 until arr.length()).map {
      val o = arr.getJSONObject(it)
      Chapter(o.optString("title", "Chapter ${it + 1}"), o.optDouble("start", 0.0), o.optDouble("end", 0.0))
    }
  }

  /**
   * Build the children for a browse node by querying ABS directly - or, with no
   * usable network, from the downloaded-books snapshot.
   *
   * The offline check happens FIRST (before any HTTP), because the alternative is
   * what shipped: six 8s-timeout requests behind one "Library" tap, and an empty
   * list at the end of them.
   *
   * Online, an empty result also falls back to the downloads. A reachable network
   * with an unreachable server (home internet down, server rebooting, token just
   * expired) otherwise leaves the car with a blank browse tree while the books are
   * sitting on the phone.
   */
  private fun childrenOf(parentId: String): ImmutableList<MediaItem> {
    if (offlineMode()) return offlineChildrenOf(parentId)
    val base = serverUrl ?: return offlineChildrenOf(parentId)
    val tok = token ?: return offlineChildrenOf(parentId)
    val fromServer = serverChildrenOf(base, tok, parentId)
    if (fromServer.isEmpty()) {
      val local = offlineChildrenOf(parentId)
      if (local.isNotEmpty()) {
        Log.i(TAG, "childrenOf parent=$parentId empty from server -> ${local.size} downloaded")
        return local
      }
    }
    return fromServer
  }

  private fun serverChildrenOf(base: String, tok: String, parentId: String): ImmutableList<MediaItem> {
    return when {
      // ---- root: the four tabs ----
      parentId == ROOT -> ImmutableList.copyOf(
        listOf(
          browsable(CONTINUE, "Continue", iconDrawable = "ic_hs_tab_continue"),
          browsable(NEW, "New", iconDrawable = "ic_hs_tab_new"),
          browsable(LIBRARY, "Library", iconDrawable = "ic_hs_tab_library"),
          browsable(DISCOVER, "Discover", iconDrawable = "ic_hs_tab_discover"),
        )
      )

      // ---- Continue: in-progress, then continue-series (next unstarted entry) ----
      parentId == CONTINUE -> {
        val seen = HashSet<String>()
        val items = mutableListOf<Book>()
        for (b in absItemsInProgress(base, tok)) if (seen.add(b.id)) items.add(b)
        for (b in continueSeries(base, tok)) if (seen.add(b.id)) items.add(b)
        ImmutableList.copyOf(items.map { playable(base, tok, it) })
      }

      // ---- New: recently added across book libraries ----
      parentId == NEW ->
        ImmutableList.copyOf(absRecentlyAdded(base, tok).map { playable(base, tok, it) })

      // ---- Library: Books / Series / (Podcasts) drill-down ----
      parentId == LIBRARY -> {
        val nodes = mutableListOf<MediaItem>()
        val books = bookLibraries(base, tok)
        val pods = podcastLibraries(base, tok)
        // One book library -> plain "Books"/"Series"; several -> prefix the name.
        for (lib in books) {
          val prefix = if (books.size > 1) "${lib.name} - " else ""
          nodes.add(browsable("$LIB_BOOKS${lib.id}", "${prefix}Books"))
          nodes.add(browsable("$LIB_SERIES${lib.id}", "${prefix}Series"))
        }
        for (lib in pods) {
          val label = if (pods.size > 1) "${lib.name} Podcasts" else "Podcasts"
          nodes.add(browsable("$LIB_PODS${lib.id}", label))
        }
        ImmutableList.copyOf(nodes)
      }
      parentId.startsWith(LIB_BOOKS) ->
        ImmutableList.copyOf(
          absLibraryItems(base, tok, parentId.removePrefix(LIB_BOOKS)).map { playable(base, tok, it) }
        )
      parentId.startsWith(LIB_SERIES) -> {
        val libId = parentId.removePrefix(LIB_SERIES)
        ImmutableList.copyOf(absSeries(base, tok, libId).map {
          browsable("$SERIES$libId:${it.first}", it.second)
        })
      }
      parentId.startsWith(SERIES) -> {
        val rest = parentId.removePrefix(SERIES)
        val libId = rest.substringBefore(':')
        val seriesId = rest.substringAfter(':')
        ImmutableList.copyOf(absSeriesItems(base, tok, libId, seriesId).map { playable(base, tok, it) })
      }
      parentId.startsWith(LIB_PODS) -> {
        val libId = parentId.removePrefix(LIB_PODS)
        ImmutableList.copyOf(absPodcasts(base, tok, libId).map {
          browsable("$POD$libId:${it.id}", it.title)
        })
      }
      parentId.startsWith(POD) -> {
        val podId = parentId.removePrefix(POD).substringAfter(':')
        ImmutableList.copyOf(absPodcastEpisodes(base, tok, podId).map { playable(base, tok, it) })
      }

      // ---- Discover: shelves from the JS snapshot ----
      parentId == DISCOVER ->
        ImmutableList.copyOf(discoverShelves().map { browsable("$DISC_SHELF${it.id}", it.label) })
      parentId.startsWith(DISC_SHELF) -> {
        val shelf = discoverShelves().firstOrNull { it.id == parentId.removePrefix(DISC_SHELF) }
        ImmutableList.copyOf((shelf?.items ?: emptyList()).map { playable(base, tok, it) })
      }

      else -> ImmutableList.of()
    }
  }

  // ---- MediaItem builders ----

  /** A browsable folder node. Pass an `iconDrawable` name to give the node a tab
   *  glyph (used for the four root tabs); it's surfaced as an android.resource
   *  artwork URI so Android Auto renders it beside the title. */
  private fun browsable(
    id: String,
    title: String,
    mediaType: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED,
    iconDrawable: String? = null
  ): MediaItem {
    val meta = MediaMetadata.Builder()
      .setTitle(title)
      .setIsBrowsable(true)
      .setIsPlayable(false)
      .setMediaType(mediaType)
    if (iconDrawable != null) {
      val resId = drawableId(iconDrawable)
      if (resId != 0) {
        meta.setArtworkUri(Uri.parse("android.resource://$packageName/$resId"))
      }
    }
    return MediaItem.Builder().setMediaId(id).setMediaMetadata(meta.build()).build()
  }

  /** A playable book in the browse list. It carries NO stream URL yet (minified
   *  items lack the audio file ino); the real URL is resolved via a play session
   *  in onAddMediaItems when the car actually selects it. */
  private fun playable(base: String, tok: String, b: Book): MediaItem {
    val art = "$base/api/items/${b.id}/cover?token=$tok"
    return MediaItem.Builder()
      .setMediaId("$PLAY_PREFIX${b.id}")
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(b.title)
          .setArtist(b.author)
          .setArtworkUri(android.net.Uri.parse(art))
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
          .build()
      )
      .build()
  }

  // ---- ABS HTTP (read-only, direct) ----

  private data class Book(
    val id: String,
    val title: String,
    val author: String,
    // Title with a leading article dropped, for alphabetical sorting. Matches the
    // web/phone library ("The Wandering Inn" sorts under W, not T).
    val sortKey: String = title
  )

  private fun httpGet(urlStr: String, tok: String): String? {
    return try {
      val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        setRequestProperty("Authorization", "Bearer $tok")
        connectTimeout = 8000
        readTimeout = 8000
      }
      val code = conn.responseCode
      if (code in 200..299) conn.inputStream.bufferedReader().readText()
      else { Log.w(TAG, "GET $urlStr -> HTTP $code"); null }
    } catch (e: Exception) {
      Log.e(TAG, "GET $urlStr failed: ${e.message}")
      null
    }
  }

  /** POST /api/items/:id/play with the device-info body ABS expects. */
  private fun httpPostPlay(urlStr: String, tok: String): String? {
    return try {
      val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        setRequestProperty("Authorization", "Bearer $tok")
        setRequestProperty("Content-Type", "application/json")
        doOutput = true
        connectTimeout = 8000
        readTimeout = 8000
      }
      val body = JSONObject()
        .put("deviceInfo", JSONObject()
          .put("deviceId", "hearthshelf-auto")
          .put("clientName", "HearthShelf Auto")
          .put("clientVersion", "0.0.2"))
        .put("supportedMimeTypes", JSONArray(listOf(
          "audio/mpeg", "audio/mp4", "audio/aac", "audio/flac", "audio/ogg"
        )))
      conn.outputStream.use { it.write(body.toString().toByteArray()) }
      if (conn.responseCode in 200..299) conn.inputStream.bufferedReader().readText() else null
    } catch (e: Exception) {
      null
    }
  }

  /** POST /api/session/:id/sync so ABS keeps the book's progress (mirrors the JS
   *  syncSession payload: currentTime / timeListened / duration, all seconds). */
  private fun httpPostSync(urlStr: String, tok: String, currentTime: Double, timeListened: Double, duration: Double) {
    try {
      val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        setRequestProperty("Authorization", "Bearer $tok")
        setRequestProperty("Content-Type", "application/json")
        doOutput = true
        connectTimeout = 8000
        readTimeout = 8000
      }
      val body = JSONObject()
        .put("currentTime", currentTime)
        .put("timeListened", timeListened)
        .put("duration", duration)
      conn.outputStream.use { it.write(body.toString().toByteArray()) }
      conn.responseCode // fire; ignore body
    } catch (e: Exception) {
      // connectivity blips are expected; next tick retries
    }
  }

  private data class Library(val id: String, val name: String, val mediaType: String)

  /** All libraries with their media type, in ABS order. */
  private fun absAllLibraries(base: String, tok: String): List<Library> {
    val body = httpGet("$base/api/libraries", tok) ?: return emptyList()
    val arr = JSONObject(body).optJSONArray("libraries") ?: return emptyList()
    val out = mutableListOf<Library>()
    for (i in 0 until arr.length()) {
      val lib = arr.getJSONObject(i)
      out.add(Library(lib.getString("id"), lib.optString("name", "Library"), lib.optString("mediaType", "book")))
    }
    return out
  }

  private fun bookLibraries(base: String, tok: String) =
    absAllLibraries(base, tok).filter { it.mediaType == "book" }

  private fun podcastLibraries(base: String, tok: String) =
    absAllLibraries(base, tok).filter { it.mediaType == "podcast" }

  /** Recently added across all book libraries, newest first. */
  private fun absRecentlyAdded(base: String, tok: String): List<Book> {
    val out = mutableListOf<Book>()
    for (lib in bookLibraries(base, tok)) {
      val body = httpGet(
        "$base/api/libraries/${lib.id}/items?limit=25&minified=1&sort=addedAt&desc=1", tok
      ) ?: continue
      out.addAll(parseBooks(JSONObject(body).optJSONArray("results")))
    }
    return out
  }

  private fun absLibraryItems(base: String, tok: String, libId: String): List<Book> {
    val body = httpGet("$base/api/libraries/$libId/items?limit=100&minified=1", tok)
      ?: return emptyList()
    // Sort alphabetically by title ignoring a leading article, client-side - the
    // same approach the web/phone library uses ("1-800-Starship" before "The
    // Wandering Inn"). ABS's own sort= param isn't relied on anywhere else.
    return parseBooks(JSONObject(body).optJSONArray("results"))
      .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.sortKey })
  }

  /**
   * GET /api/libraries/:id/search -> matched books. ABS wraps each hit as
   * { libraryItem: {...} } under a "book" array; unwrap to the item, then parse
   * the same minified shape Continue Listening / browse use.
   */
  private fun absSearchLibrary(base: String, tok: String, libId: String, query: String): List<Book> {
    val q = java.net.URLEncoder.encode(query, "UTF-8")
    val body = httpGet("$base/api/libraries/$libId/search?q=$q&limit=25", tok) ?: return emptyList()
    val books = JSONObject(body).optJSONArray("book") ?: return emptyList()
    val items = JSONArray()
    for (i in 0 until books.length()) {
      books.getJSONObject(i).optJSONObject("libraryItem")?.let { items.put(it) }
    }
    return parseBooks(items)
  }

  private fun absItemsInProgress(base: String, tok: String): List<Book> {
    val body = httpGet("$base/api/me/items-in-progress", tok) ?: return emptyList()
    val books = parseBooks(JSONObject(body).optJSONArray("libraryItems"))
    // ABS keeps returning a naturally finished book from items-in-progress, so
    // this list alone would leave a book you just finished sitting at the top of
    // the car's Continue row - while the phone's Continue shelf, which filters it
    // out, correctly does not show it (HS-MOBILEAPP-2P).
    //
    // The phone filters against its own progress store, which the car has no
    // access to (separate process, no JS runtime). /api/me is where that store
    // gets its finished flags from, so ask ABS the same question directly.
    // Best-effort: if the call fails, fall back to the unfiltered list rather
    // than emptying the row.
    val finished = absFinishedIds(base, tok) ?: return books
    return books.filterNot { finished.contains(it.id) }
  }

  /**
   * Item ids the server considers FINISHED, from /api/me's mediaProgress.
   *
   * Null (not empty) when the request or parse fails, so callers can tell "no
   * finished books" from "could not find out" and degrade accordingly.
   */
  private fun absFinishedIds(base: String, tok: String): Set<String>? {
    val body = httpGet("$base/api/me", tok) ?: return null
    return try {
      val arr = JSONObject(body).optJSONArray("mediaProgress") ?: return emptySet()
      val out = HashSet<String>()
      for (i in 0 until arr.length()) {
        val row = arr.optJSONObject(i) ?: continue
        if (row.optBoolean("isFinished", false)) {
          row.optString("libraryItemId").takeIf { it.isNotEmpty() }?.let { out.add(it) }
        }
      }
      out
    } catch (_: Exception) {
      null
    }
  }

  private fun parseBooks(arr: JSONArray?): List<Book> {
    if (arr == null) return emptyList()
    val out = mutableListOf<Book>()
    for (i in 0 until arr.length()) {
      val item = arr.getJSONObject(i)
      val id = item.optString("id")
      val media = item.optJSONObject("media") ?: continue
      val meta = media.optJSONObject("metadata") ?: continue
      // Minified items don't carry audioTracks; the file route works by item id.
      val title = meta.optString("title", "Untitled")
      out.add(
        Book(
          id = id,
          title = title,
          author = meta.optString("authorName", ""),
          sortKey = meta.optString("titleIgnorePrefix", "").ifEmpty { title }
        )
      )
    }
    return out
  }

  // ---- Series ----

  /** GET /api/libraries/:id/series -> (seriesId, name) pairs. */
  private fun absSeries(base: String, tok: String, libId: String): List<Pair<String, String>> {
    val body = httpGet("$base/api/libraries/$libId/series?limit=200", tok) ?: return emptyList()
    val arr = JSONObject(body).optJSONArray("results") ?: return emptyList()
    // (sortKey, id, name); sort alphabetically ignoring a leading article, like
    // the Books list, then drop the sort key.
    val out = mutableListOf<Triple<String, String, String>>()
    for (i in 0 until arr.length()) {
      val s = arr.getJSONObject(i)
      val name = s.optString("name", "Series")
      val sortKey = s.optString("nameIgnorePrefix", "").ifEmpty { name }
      out.add(Triple(sortKey, s.optString("id"), name))
    }
    return out
      .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.first })
      .map { it.second to it.third }
  }

  /** Books in one series, in series order. The /series response embeds each
   *  series' books, so we refetch and pick the matching one. */
  private fun absSeriesItems(base: String, tok: String, libId: String, seriesId: String): List<Book> {
    val body = httpGet("$base/api/libraries/$libId/series?limit=200", tok) ?: return emptyList()
    val arr = JSONObject(body).optJSONArray("results") ?: return emptyList()
    for (i in 0 until arr.length()) {
      val s = arr.getJSONObject(i)
      if (s.optString("id") == seriesId) return parseBooks(s.optJSONArray("books"))
    }
    return emptyList()
  }

  /** Next-up entries: for each series the listener has touched (a book in progress
   *  or finished), the first book they haven't started. Keeps the car's Continue
   *  tab feeding the next book without opening the phone. */
  private fun continueSeries(base: String, tok: String): List<Book> {
    // Cheap heuristic against the data we already fetch: the in-progress items'
    // series, resolved to that series' first not-in-progress book. Falls back to
    // empty when there are no book libraries or no series info.
    val inProgress = absItemsInProgress(base, tok).map { it.id }.toHashSet()
    if (inProgress.isEmpty()) return emptyList()
    val out = mutableListOf<Book>()
    val seenSeries = HashSet<String>()
    for (lib in bookLibraries(base, tok)) {
      val body = httpGet("$base/api/libraries/${lib.id}/series?limit=200", tok) ?: continue
      val arr = JSONObject(body).optJSONArray("results") ?: continue
      for (i in 0 until arr.length()) {
        val s = arr.getJSONObject(i)
        val books = parseBooks(s.optJSONArray("books"))
        // Only series the listener has started, and only their first unstarted book.
        if (books.none { inProgress.contains(it.id) }) continue
        val next = books.firstOrNull { !inProgress.contains(it.id) } ?: continue
        if (seenSeries.add(s.optString("id"))) out.add(next)
      }
    }
    return out
  }

  // ---- Podcasts ----

  private data class Podcast(val id: String, val title: String)

  /** Podcasts in a podcast-type library. */
  private fun absPodcasts(base: String, tok: String, libId: String): List<Podcast> {
    val body = httpGet("$base/api/libraries/$libId/items?limit=200&minified=1", tok) ?: return emptyList()
    val arr = JSONObject(body).optJSONArray("results") ?: return emptyList()
    val out = mutableListOf<Podcast>()
    for (i in 0 until arr.length()) {
      val item = arr.getJSONObject(i)
      val meta = item.optJSONObject("media")?.optJSONObject("metadata")
      out.add(Podcast(item.optString("id"), meta?.optString("title", "Podcast") ?: "Podcast"))
    }
    return out
  }

  /**
   * Episodes of a podcast, newest first. The play route takes item id + episode
   * id, so the Book we return carries a "podId/episodeId" id that resolveBookItem
   * splits back apart. Title is the episode title.
   */
  private fun absPodcastEpisodes(base: String, tok: String, podId: String): List<Book> {
    val body = httpGet("$base/api/items/$podId?expanded=1", tok) ?: return emptyList()
    val media = JSONObject(body).optJSONObject("media") ?: return emptyList()
    val podTitle = media.optJSONObject("metadata")?.optString("title", "") ?: ""
    val eps = media.optJSONArray("episodes") ?: return emptyList()
    val out = mutableListOf<Book>()
    for (i in 0 until eps.length()) {
      val ep = eps.getJSONObject(i)
      out.add(Book(id = "$podId/${ep.optString("id")}", title = ep.optString("title", "Episode"), author = podTitle))
    }
    return out.asReversed()
  }

  // ---- Discover (snapshot handed over by JS) ----

  private data class DiscoverShelf(val id: String, val label: String, val items: List<Book>)

  // ---- Offline library (downloaded books, snapshot handed over by JS) ----

  private data class OfflineTrack(val uri: String, val startOffset: Double, val duration: Double)

  private data class OfflineBook(
    val id: String,
    val title: String,
    val sortKey: String,
    val author: String,
    /** file:// uri of the downloaded cover, or "" when it wasn't saved. */
    val cover: String,
    val duration: Double,
    /** Last known position (seconds) - what the car resumes at with no server. */
    val position: Double,
    val finished: Boolean,
    val addedAt: Long,
    val seriesId: String,
    val seriesName: String,
    val sequence: Double,
    val chapters: List<Chapter>,
    val tracks: List<OfflineTrack>,
  )

  // Parsed snapshot, cached against the raw JSON so the browse callbacks don't
  // re-parse the whole library on every node expansion.
  @Volatile private var offlineCacheJson: String? = null
  @Volatile private var offlineCacheBooks: List<OfflineBook> = emptyList()

  /**
   * The downloaded-books snapshot JS mirrors into prefs (setOfflineLibrary).
   * Empty until the app has published it at least once - which it does at every
   * launch, so a device that has ever opened the app online has it.
   */
  private fun offlineLibrary(): List<OfflineBook> {
    val json = prefs.getString("offlineLibrary", null) ?: return emptyList()
    if (json == offlineCacheJson) return offlineCacheBooks
    val parsed = try {
      val arr = JSONObject(json).optJSONArray("books") ?: JSONArray()
      (0 until arr.length()).mapNotNull { i -> parseOfflineBook(arr.getJSONObject(i)) }
    } catch (e: Exception) {
      Log.w(TAG, "offline library parse failed: ${e.message}")
      emptyList()
    }
    offlineCacheJson = json
    offlineCacheBooks = parsed
    return parsed
  }

  /** One snapshot row -> OfflineBook. Rows with no playable track are dropped:
   *  they'd list in the car and then fail to play. */
  private fun parseOfflineBook(o: JSONObject): OfflineBook? {
    val id = o.optString("id")
    if (id.isEmpty()) return null
    val trackArr = o.optJSONArray("tracks") ?: return null
    val tracks = (0 until trackArr.length()).map {
      val t = trackArr.getJSONObject(it)
      OfflineTrack(
        t.optString("uri"),
        t.optDouble("startOffset", 0.0),
        t.optDouble("duration", 0.0),
      )
    }.filter { it.uri.isNotEmpty() }
    if (tracks.isEmpty()) return null
    val title = o.optString("title", "Untitled")
    return OfflineBook(
      id = id,
      title = title,
      sortKey = o.optString("sortKey", "").ifEmpty { title },
      author = o.optString("author", ""),
      cover = o.optString("cover", ""),
      duration = o.optDouble("duration", 0.0),
      position = o.optDouble("position", 0.0),
      finished = o.optBoolean("finished", false),
      addedAt = o.optLong("addedAt", 0L),
      seriesId = o.optString("seriesId", ""),
      seriesName = o.optString("seriesName", ""),
      sequence = o.optDouble("sequence", 0.0),
      chapters = parseChapters(o.optJSONArray("chapters")),
      tracks = tracks,
    )
  }

  private fun offlineBook(itemId: String): OfflineBook? =
    offlineLibrary().firstOrNull { it.id == itemId }

  /**
   * The browse tree served from downloaded books. Deliberately a SHORTER tree than
   * the online one - with no server there is no "everything", so offering Library
   * -> Books -> 400 titles that can't play would be a lie. Three nodes at most:
   * what you're partway through, everything on the device, and series (when the
   * downloads have any).
   */
  private fun offlineChildrenOf(parentId: String): ImmutableList<MediaItem> {
    val books = offlineLibrary()
    if (books.isEmpty()) {
      // An empty root reads as a broken app, so say what's actually true - but
      // only to a signed-in user. With no session at all (signed out, or car mode
      // switched off) "no downloaded books" would be the wrong explanation.
      val explain = parentId == ROOT && serverUrl != null
      return if (explain) ImmutableList.of(offlineNotice()) else ImmutableList.of()
    }
    val byTitle = books.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.sortKey })
    return when {
      parentId == ROOT -> {
        val nodes = mutableListOf<MediaItem>()
        if (books.any { inProgress(it) }) {
          nodes.add(browsable(CONTINUE, "Continue", iconDrawable = "ic_hs_tab_continue"))
        }
        nodes.add(browsable(OFF_ALL, "Downloaded", iconDrawable = "ic_hs_tab_library"))
        if (books.any { it.seriesId.isNotEmpty() }) {
          nodes.add(browsable(OFF_SERIES, "Series", iconDrawable = "ic_hs_tab_new"))
        }
        ImmutableList.copyOf(nodes)
      }

      // Started but not finished, most-progressed first - the same ordering the
      // phone's Continue shelf uses, so the car's first row matches the app's.
      parentId == CONTINUE -> ImmutableList.copyOf(
        books
          .filter { inProgress(it) }
          .sortedByDescending { if (it.duration > 0) it.position / it.duration else 0.0 }
          .map { offlinePlayable(it) }
      )

      // The online "Library" node, reached from the car's cached tree while the
      // server is unreachable: offer the same two things the offline root does.
      parentId == LIBRARY -> {
        val nodes = mutableListOf(browsable(OFF_ALL, "Downloaded"))
        if (books.any { it.seriesId.isNotEmpty() }) {
          nodes.add(browsable(OFF_SERIES, "Series"))
        }
        ImmutableList.copyOf(nodes)
      }

      parentId == OFF_SERIES -> {
        val series = books
          .filter { it.seriesId.isNotEmpty() }
          .groupBy { it.seriesId }
          .map { (id, list) -> id to (list.first().seriesName.ifEmpty { "Series" }) }
          .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.second })
        ImmutableList.copyOf(series.map { browsable("$OFF_SERIES_ITEMS${it.first}", it.second) })
      }

      parentId.startsWith(OFF_SERIES_ITEMS) -> {
        val seriesId = parentId.removePrefix(OFF_SERIES_ITEMS)
        ImmutableList.copyOf(
          books
            .filter { it.seriesId == seriesId }
            .sortedWith(compareBy<OfflineBook>({ it.sequence }, { it.sortKey.lowercase() }))
            .map { offlinePlayable(it) }
        )
      }

      // OFF_ALL, plus any ONLINE node id the car still has cached from a
      // connected session (a stale "Library - Books" tap): serve the downloads
      // rather than the dead end an unresolvable online node would produce.
      else -> ImmutableList.copyOf(byTitle.map { offlinePlayable(it) })
    }
  }

  /** A non-playable row explaining an empty offline browse tree. Neither browsable
   *  nor playable, so the car renders it as a label the driver can't get stuck in. */
  private fun offlineNotice(): MediaItem =
    MediaItem.Builder()
      .setMediaId("off:notice")
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle("No connection - no downloaded books")
          .setSubtitle("Download books in the app to hear them here.")
          .setIsBrowsable(false)
          .setIsPlayable(false)
          .build()
      )
      .build()

  private fun inProgress(b: OfflineBook): Boolean =
    !b.finished && b.position > 0 && (b.duration <= 0 || b.position < b.duration - 5)

  /** A downloaded book in the offline browse list. Cover comes off the disk, so
   *  artwork shows with no network. */
  private fun offlinePlayable(b: OfflineBook): MediaItem =
    MediaItem.Builder()
      .setMediaId("$PLAY_PREFIX${b.id}")
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(b.title)
          .setArtist(b.author)
          .apply { if (b.cover.isNotEmpty()) setArtworkUri(Uri.parse(b.cover)) }
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
          .build()
      )
      .build()

  /**
   * Build the player items for a downloaded book straight off the disk. One media
   * item per downloaded track (ABS books are often split into many files), with
   * `trackOffsets` carrying each window's absolute start so every position, seek,
   * chapter jump and bookmark keeps working in absolute book time.
   *
   * Returns null when the book isn't downloaded - the caller then has nothing to
   * play, which is the honest outcome offline.
   */
  private fun resolveOfflineBook(itemId: String): LoadedBook? {
    val b = offlineBook(itemId) ?: return null
    Log.i(TAG, "resolveOfflineBook item=$itemId tracks=${b.tracks.size}")

    absSessionId = null
    playingOffline = true
    // A fresh listen: its own banked session, its own listened-time total.
    offlineSessionStartedAt = System.currentTimeMillis()
    offlineListenedSec = 0.0
    absDurationSec = if (b.duration > 0) b.duration else b.tracks.sumOf { it.duration }
    lastSyncedSec = b.position
    currentItemId = itemId
    trackOffsets = b.tracks.map { it.startOffset }

    // No server, so no club notes to watch - clear any watch from the last book.
    noteClubId = null
    noteStubs = emptyList()
    notePrevPosSec = -1.0
    lastNotesFetchMs = 0L

    bookTitle = b.title
    bookAuthor = b.author
    artUri = b.cover
    chapters = if (b.chapters.isNotEmpty()) b.chapters
      else listOf(Chapter(b.title, 0.0, absDurationSec.coerceAtLeast(0.0)))
    shownChapterIdx = chapters.indexOfFirst { b.position >= it.start && b.position < it.end }

    val chaptersJson = JSONArray().apply {
      for (ch in chapters) {
        put(JSONObject().put("title", ch.title).put("start", ch.start).put("end", ch.end))
      }
    }.toString()
    HearthShelfAutoModule.emitCarLoaded(
      itemId, b.title, b.author, b.cover, absDurationSec, b.position, chaptersJson,
    )

    val meta = chapterMeta(shownChapterIdx)
    val items = b.tracks.map { t ->
      MediaItem.Builder()
        .setMediaId("$PLAY_PREFIX${b.id}")
        .setUri(t.uri)
        .setMediaMetadata(meta)
        .build()
    }
    return LoadedBook(items, (b.position * 1000).toLong().coerceAtLeast(0))
  }

  // ---- Offline progress ledger ----

  /**
   * Bank the car's offline position + listened-time in prefs. With no server there
   * is no play session to sync, and the RN app may not even be running - without
   * this an hour listened in the car on a dead network simply vanished. JS drains
   * it into the pending-session ledger at the next launch
   * (HearthShelfAutoModule.getOfflineProgress -> carOffline.ts), which replays it
   * to ABS as a real session once the network returns.
   *
   * Keyed "<itemId>@<startedAt>", i.e. per LISTEN, not per book. Keyed by book, a
   * second offline listen of the same book would overwrite the first - the exact
   * bug that quietly ate a morning's listening on the phone side.
   *
   * The running total lives in memory (offlineListenedSec) rather than being read
   * back from prefs, so a JS drain that clears the row mid-listen doesn't reset
   * the count: the next write restates the whole session under the same key, and
   * the drain updates that session in place instead of banking a second partial.
   */
  private fun recordOfflineProgress(posSec: Double, listenedSec: Double) {
    val itemId = currentItemId ?: return
    offlineListenedSec += listenedSec
    try {
      val raw = prefs.getString("offlineProgress", null)
      val all = if (raw != null) JSONObject(raw) else JSONObject()
      val entry = JSONObject()
        .put("itemId", itemId)
        .put("title", bookTitle)
        .put("duration", absDurationSec)
        .put("currentTime", posSec)
        .put("timeListening", offlineListenedSec)
        .put("startedAt", offlineSessionStartedAt)
        .put("updatedAt", System.currentTimeMillis())
      all.put("$itemId@$offlineSessionStartedAt", entry)
      prefs.edit().putString("offlineProgress", all.toString()).apply()
    } catch (e: Exception) {
      Log.w(TAG, "offline progress record failed: ${e.message}")
    }
  }

  /** Flag the current listen's banked entry as finished, so the drain on the
   *  phone marks the book finished when it replays this listen. Runs on io,
   *  ordered behind the recordOfflineProgress that created the entry. */
  private fun markOfflineFinished() {
    val itemId = currentItemId ?: return
    try {
      val raw = prefs.getString("offlineProgress", null) ?: return
      val all = JSONObject(raw)
      val key = "$itemId@$offlineSessionStartedAt"
      val entry = all.optJSONObject(key) ?: return
      entry.put("finished", true)
      all.put(key, entry)
      prefs.edit().putString("offlineProgress", all.toString()).apply()
    } catch (e: Exception) {
      Log.w(TAG, "offline finish record failed: ${e.message}")
    }
  }

  /** Parse the Discover snapshot the phone wrote to prefs (setDiscover). Empty
   *  until the app computes it at least once. */
  private fun discoverShelves(): List<DiscoverShelf> {
    val json = prefs.getString("discover", null) ?: return emptyList()
    return try {
      val arr = JSONObject(json).optJSONArray("shelves") ?: return emptyList()
      (0 until arr.length()).map { i ->
        val s = arr.getJSONObject(i)
        val itemsArr = s.optJSONArray("items") ?: JSONArray()
        val items = (0 until itemsArr.length()).map { j ->
          val it = itemsArr.getJSONObject(j)
          Book(it.optString("id"), it.optString("title", "Untitled"), it.optString("author", ""))
        }
        DiscoverShelf(s.optString("id"), s.optString("label", "Discover"), items)
      }
    } catch (e: Exception) {
      Log.w(TAG, "discover snapshot parse failed: ${e.message}")
      emptyList()
    }
  }
}
