package com.hearthshelf.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
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
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

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
 */
class HearthShelfAutoService : MediaLibraryService() {

  private var session: MediaLibrarySession? = null
  // The ExoPlayer, also used directly as the session player. Its timeline is one
  // clipped window per chapter, so position/duration are already chapter-relative;
  // command handlers convert to/from absolute book time via absolutePositionMs.
  private var rawPlayer: ExoPlayer? = null
  private val io = Executors.newSingleThreadExecutor()

  private val TAG = "HSAuto"

  // Resume target for the item currently being loaded; applied once the player is
  // ready so the car resumes where you left off instead of at 0. With per-chapter
  // windows the target is a (window index, offset-into-window) pair.
  @Volatile private var pendingSeekWindow: Int = -1
  @Volatile private var pendingSeekMs: Long = 0L
  // ABS play-session id for the loaded book, so we can sync progress back.
  @Volatile private var absSessionId: String? = null
  @Volatile private var absDurationSec: Double = 0.0
  @Volatile private var lastSyncedSec: Double = 0.0

  // Set of connected Android Auto (or other real head-unit) controller package
  // names. While non-empty the car owns playback: we register carPlayer so JS
  // transport routes here and tell JS the phone player should stand down.
  private val carControllers = HashSet<String>()

  // The JS-transport -> car-player bridge, registered on the module while a car
  // controller is connected. ExoPlayer is main-thread-only, so hop first.
  private val carPlayerImpl = object : HearthShelfAutoModule.CarPlayer {
    override fun play() = runOnMain { rawPlayer?.playWhenReady = true }
    override fun pause() = runOnMain { rawPlayer?.playWhenReady = false }
    override fun seekTo(sec: Double) = runOnMain {
      rawPlayer?.let { seekToAbsolute(it, (sec * 1000).toLong()) }
    }
    override fun setRate(rate: Double) = runOnMain {
      rawPlayer?.setPlaybackSpeed(rate.toFloat())
      session?.setMediaButtonPreferences(customLayout())
    }
    override fun stop() = runOnMain { rawPlayer?.pause() }
  }

  private val prefs by lazy {
    getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)
  }
  private val serverUrl: String?
    get() = prefs.getString("serverUrl", null)?.trimEnd('/')
  private val token: String?
    get() = prefs.getString("token", null)

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
      .setCustomIconResId(resources.getIdentifier(icon, "drawable", packageName))
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
    return if (resources.getIdentifier(named, "drawable", packageName) != 0) named else prefix
  }

  private fun rewindButton(): CommandButton {
    val icon = skipIconName("ic_hs_rewind", rewindSec)
    return CommandButton.Builder(rewindIcon(rewindSec))
      .setDisplayName("Back ${rewindSec}s")
      .setCustomIconResId(resources.getIdentifier(icon, "drawable", packageName))
      .setSessionCommand(SessionCommand(CMD_REWIND, Bundle.EMPTY))
      .setSlots(CommandButton.SLOT_BACK, CommandButton.SLOT_OVERFLOW)
      .build()
  }

  private fun forwardButton(): CommandButton {
    val icon = skipIconName("ic_hs_forward", forwardSec)
    return CommandButton.Builder(forwardIcon(forwardSec))
      .setDisplayName("Forward ${forwardSec}s")
      .setCustomIconResId(resources.getIdentifier(icon, "drawable", packageName))
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
    val icon = if (resources.getIdentifier(named, "drawable", packageName) != 0) named else "ic_hs_speed"
    return customButton(CMD_SPEED, "Speed ${s}x", icon)
  }

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "onCreate: serverUrl=${serverUrl != null}, token=${token != null}")

    // HearthShelf flame as the notification small icon (not Media3's default).
    val notificationProvider = DefaultMediaNotificationProvider.Builder(this).build().apply {
      setSmallIcon(resources.getIdentifier("ic_hs_notification", "drawable", packageName))
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
        if (state == Player.STATE_READY && pendingSeekWindow >= 0) {
          val win = pendingSeekWindow
          val off = pendingSeekMs
          pendingSeekWindow = -1
          pendingSeekMs = 0
          player.seekTo(win, off)
        }
        if (state == Player.STATE_ENDED) {
          syncProgress(absolutePositionMs(player), force = true)
          // Book finished: let JS advance the shared up-next queue (server owns
          // it). The store change flows back to load the next book.
          HearthShelfAutoModule.emitEnded()
        }
      }
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        // Mirror car play/pause into the JS store so the phone UI stays in sync.
        HearthShelfAutoModule.emitState(isPlaying)
        HearthShelfAutoModule.emitProgress(absolutePositionMs(player) / 1000.0)
        if (!isPlaying) syncProgress(absolutePositionMs(player), force = true)
      }
    })

    // Each chapter is its own clipped window (chapter-relative position/duration).
    // Chapter nav happens through OUR custom prev/next-chapter buttons, not the
    // standard transport (onConnect withholds the seek-to-previous/next commands
    // so the car frees those slots for the custom row). A distinct session id is
    // required; the phone service also runs one.
    // Media-button-preferences (not setCustomLayout) is what media3 1.10 converts
    // into the LEGACY MediaSessionCompat custom actions Android Auto renders.
    session = MediaLibrarySession.Builder(this, player, LibraryCallback())
      .setId("hearthshelf_auto")
      .setMediaButtonPreferences(customLayout())
      .build()

    // Periodic progress sync while playing (throttled inside syncProgress).
    progressHandler.postDelayed(progressTick, 5000)
  }

  private val progressHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val progressTick = object : Runnable {
    override fun run() {
      rawPlayer?.let {
        if (it.isPlaying) {
          // Mirror the car's absolute book position into the JS store every tick
          // so the phone UI's scrubber advances in step with the car.
          HearthShelfAutoModule.emitProgress(absolutePositionMs(it) / 1000.0)
          syncProgress(absolutePositionMs(it), force = false)
          checkNotes(it)
        }
      }
      progressHandler.postDelayed(this, 1000)
    }
  }

  /** ExoPlayer must be touched on its Looper (the main thread). JS transport
   *  commands arrive on RN's native-modules thread, so hop first. */
  private fun runOnMain(block: () -> Unit) {
    if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) block()
    else progressHandler.post(block)
  }

  /** Previous-chapter: restart the current chapter if we're >3s into it (matching
   *  the in-app player), otherwise step to the previous window. */
  private fun prevChapter(player: Player) {
    if (player.currentPosition > 3000 || !player.hasPreviousMediaItem()) player.seekTo(0)
    else player.seekToPreviousMediaItem()
  }

  /** POST a bookmark at the given position (labelled with the chapter title). */
  private fun bookmarkNow(posSec: Double) {
    val id = currentItemId ?: return
    val base = serverUrl ?: return
    val tok = token ?: return
    val ch = chapters.firstOrNull { posSec >= it.start && posSec < it.end }
    val title = ch?.title ?: "Bookmark"
    io.execute {
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
        conn.responseCode
      } catch (e: Exception) {
        Log.w(TAG, "bookmark failed: ${e.message}")
      }
    }
  }

  /** POST progress to ABS (throttled to ~15s unless forced on pause/stop). */
  private fun syncProgress(posMs: Long, force: Boolean) {
    val sid = absSessionId ?: return
    val sec = posMs / 1000.0
    if (!force && kotlin.math.abs(sec - lastSyncedSec) < 15.0) return
    val elapsed = kotlin.math.max(0.0, sec - lastSyncedSec)
    lastSyncedSec = sec
    val base = serverUrl ?: return
    val tok = token ?: return
    io.execute {
      try {
        httpPostSync("$base/api/session/$sid/sync", tok, sec, elapsed, absDurationSec)
      } catch (e: Exception) {
        Log.w(TAG, "sync failed: ${e.message}")
      }
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
    session

  override fun onDestroy() {
    progressHandler.removeCallbacks(progressTick)
    // Hand control back to the phone player and tell JS the car is gone, so the
    // phone UI stops mirroring and resumes driving the phone service.
    carControllers.clear()
    if (HearthShelfAutoModule.carPlayer === carPlayerImpl) {
      HearthShelfAutoModule.carPlayer = null
      HearthShelfAutoModule.emitCarActive(false)
    }
    // Persist the final ABSOLUTE position so closing the car app doesn't lose it.
    rawPlayer?.let { val abs = absolutePositionMs(it); if (abs > 0) syncProgress(abs, force = true) }
    session?.run {
      player.release()
      release()
    }
    rawPlayer = null
    session = null
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

  /**
   * Last search's results, cached so onGetSearchResult can serve them without a
   * second round-trip to ABS. onSearch does the query, stashes the books here,
   * then notifies the client of the count; the client then pulls pages from this.
   */
  @Volatile private var lastSearchQuery: String? = null
  @Volatile private var lastSearchBooks: List<Book> = emptyList()

  private inner class LibraryCallback : MediaLibrarySession.Callback {

    /** Grant our custom commands so the buttons are actionable, and publish the
     *  full custom layout (skip / chapter / speed / bookmark) to this controller.
     *  The standard seek-to-previous/next player commands are withheld: with them
     *  advertised, Android Auto renders its own prev/next buttons and pushes all
     *  custom actions into the overflow menu. Chapter nav still works - the custom
     *  prev/next-chapter buttons call the player directly, and the Queue's
     *  jump-to-chapter uses COMMAND_SEEK_TO_MEDIA_ITEM, which stays available. */
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
      val playerCommands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS
        .buildUpon()
        .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
        .remove(Player.COMMAND_SEEK_TO_NEXT)
        .remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        .remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
        .build()
      if (isCarController(controller)) {
        carControllers.add(controller.packageName)
        // First car controller: the car now owns playback. Route JS transport
        // here and tell the phone to stand down.
        if (carControllers.size == 1) {
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
      if (carControllers.remove(controller.packageName) && carControllers.isEmpty()) {
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
      val player = rawPlayer ?: session.player
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
        CMD_NEXT_CH -> if (player.hasNextMediaItem()) player.seekToNextMediaItem()
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
      val future = io.submit<LibraryResult<ImmutableList<MediaItem>>> {
        try {
          val kids = childrenOf(parentId)
          Log.i(TAG, "onGetChildren parent=$parentId -> ${kids.size} items")
          LibraryResult.ofItemList(kids, params)
        } catch (e: Exception) {
          Log.e(TAG, "onGetChildren parent=$parentId FAILED", e)
          LibraryResult.ofItemList(ImmutableList.of(), params)
        }
      }
      return Futures.immediateFuture(future.get())
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
     * play session and swapping in the real, token-bearing stream URL + resume
     * position, so the service's ExoPlayer can play it.
     */
    override fun onAddMediaItems(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>
    ): ListenableFuture<MutableList<MediaItem>> {
      val resolved = io.submit<MutableList<MediaItem>> {
        // Resolve the FIRST selected book into its chapter windows (one MediaItem
        // per chapter, all sharing the stream URL, clipped to the chapter's span).
        // That makes the car's Queue the chapter list, matching ABS/Audible, and
        // lets prev/next-chapter be plain window jumps. Any extra selected items
        // are passed through unresolved (the car sends one book at a time).
        val first = mediaItems.firstOrNull()
        if (first != null) {
          val id = first.mediaId.removePrefix(PLAY_PREFIX)
          val windows = resolveChapterWindows(id)
          if (windows.isNotEmpty()) return@submit windows.toMutableList()
        }
        mediaItems.toMutableList()
      }
      return Futures.immediateFuture(resolved.get())
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
      val future = io.submit<LibraryResult<Void>> {
        try {
          val books = searchAll(query)
          lastSearchQuery = query
          lastSearchBooks = books
          Log.i(TAG, "onSearch query=\"$query\" -> ${books.size} items")
          session.notifySearchResultChanged(browser, query, books.size, params)
          LibraryResult.ofVoid(params)
        } catch (e: Exception) {
          Log.e(TAG, "onSearch query=\"$query\" FAILED", e)
          lastSearchQuery = query
          lastSearchBooks = emptyList()
          session.notifySearchResultChanged(browser, query, 0, params)
          LibraryResult.ofVoid(params)
        }
      }
      return Futures.immediateFuture(future.get())
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
      val future = io.submit<LibraryResult<ImmutableList<MediaItem>>> {
        try {
          val base = serverUrl
          val tok = token
          if (base == null || tok == null) {
            return@submit LibraryResult.ofItemList(ImmutableList.of(), params)
          }
          // The client searches before paging, so the cache is normally warm.
          // Re-run on a cache miss (e.g. a different query) to stay correct.
          val books = if (query == lastSearchQuery) lastSearchBooks else searchAll(query)
          val from = page * pageSize
          val pageItems = if (from >= books.size) emptyList()
            else books.subList(from, minOf(from + pageSize, books.size))
          Log.i(TAG, "onGetSearchResult query=\"$query\" page=$page -> ${pageItems.size} items")
          LibraryResult.ofItemList(
            ImmutableList.copyOf(pageItems.map { playable(base, tok, it) }), params
          )
        } catch (e: Exception) {
          Log.e(TAG, "onGetSearchResult query=\"$query\" FAILED", e)
          LibraryResult.ofItemList(ImmutableList.of(), params)
        }
      }
      return Futures.immediateFuture(future.get())
    }
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

  /**
   * POST /api/items/:id/play, then build ONE MediaItem per chapter - all pointing
   * at the same stream URL but clipped to the chapter's [start, end) - so the
   * car's Queue is the chapter list. Each window's title is the chapter title;
   * the book title/author/cover ride along as the album metadata. Returns the
   * windows in order, and stashes resume/sync state for onPlaybackStateChanged.
   */
  private fun resolveChapterWindows(rawId: String): List<MediaItem> {
    val base = serverUrl ?: return emptyList()
    val tok = token ?: return emptyList()
    // Podcast episodes arrive as "libraryItemId/episodeId"; books are a plain id.
    val itemId = rawId.substringBefore('/')
    val episodeId = if (rawId.contains('/')) rawId.substringAfter('/') else null
    Log.i(TAG, "resolveChapterWindows item=$itemId episode=$episodeId")
    val playUrl = if (episodeId != null) "$base/api/items/$itemId/play/$episodeId"
      else "$base/api/items/$itemId/play"
    val body = httpPostPlay(playUrl, tok)
    if (body == null) { Log.e(TAG, "play session failed for $rawId"); return emptyList() }
    val session = JSONObject(body)
    val tracks = session.optJSONArray("audioTracks") ?: return emptyList()
    if (tracks.length() == 0) return emptyList()
    val contentUrl = tracks.getJSONObject(0).optString("contentUrl")
    val streamUrl = "$base$contentUrl?token=$tok"
    val startSec = session.optDouble("currentTime", 0.0)
    val art = "$base/api/items/$itemId/cover?token=$tok"
    val bookTitle = session.optString("displayTitle", "Audiobook")
    val author = session.optString("displayAuthor", "")

    absSessionId = session.optString("id").ifEmpty { null }
    absDurationSec = session.optDouble("duration", 0.0)
    lastSyncedSec = startSec
    currentItemId = itemId

    // Begin (or clear) club note-watching for this book. Resolving the club is a
    // network call, so do it off the resolve path; the tick starts detecting once
    // noteClubId/noteStubs are populated. Reset per-book watch state first.
    noteClubId = null
    noteStubs = emptyList()
    notePrevPosSec = -1.0
    lastNotesFetchMs = 0L
    setupNoteWatch(itemId, startSec)

    val parsed = parseChapters(session.optJSONArray("chapters"))
    // Fall back to a single full-book window when the book has no chapters, so
    // the queue still shows the book and playback works.
    chapters = if (parsed.isNotEmpty()) parsed
      else listOf(Chapter(bookTitle, 0.0, absDurationSec.coerceAtLeast(0.0)))

    // Mirror the loaded book into the JS store so the phone UI shows the same
    // cover/title/chapters and its scrubber tracks the car. The phone cover
    // resolves from itemId, so hand JS the raw item id (not the tokened URL).
    val chaptersJson = JSONArray().apply {
      for (ch in chapters) {
        put(JSONObject().put("title", ch.title).put("start", ch.start).put("end", ch.end))
      }
    }.toString()
    HearthShelfAutoModule.emitCarLoaded(
      itemId, bookTitle, author, art, absDurationSec, startSec, chaptersJson,
    )

    // Resume into the window that holds the saved position; seek within it once
    // that window is ready (applied in onPlaybackStateChanged).
    pendingSeekWindow = chapters.indexOfFirst { startSec >= it.start && startSec < it.end }
      .let { if (it >= 0) it else 0 }
    pendingSeekMs = ((startSec - chapters[pendingSeekWindow].start) * 1000).toLong().coerceAtLeast(0)

    val artUri = android.net.Uri.parse(art)
    return chapters.mapIndexed { i, ch ->
      val startMs = (ch.start * 1000).toLong()
      val endMs = (ch.end * 1000).toLong()
      val clip = MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs(startMs)
        // A chapter with a real end clips there; the last/unknown end plays to EOF.
        .apply { if (endMs > startMs) setEndPositionMs(endMs) }
        .build()
      MediaItem.Builder()
        .setMediaId("$PLAY_PREFIX$itemId#$i")
        .setUri(streamUrl)
        .setClippingConfiguration(clip)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(ch.title)
            .setArtist(author)
            .setAlbumTitle(bookTitle)
            .setTrackNumber(i + 1)
            .setTotalTrackCount(chapters.size)
            .setArtworkUri(artUri)
            .setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            .build()
        )
        .build()
    }
  }

  private data class Chapter(val title: String, val start: Double, val end: Double)

  /** Absolute book position (ms) from the windowed player: the current chapter's
   *  start plus the position within its clipped window. */
  private fun absolutePositionMs(player: Player): Long {
    val idx = player.currentMediaItemIndex
    val chStartMs = chapters.getOrNull(idx)?.let { (it.start * 1000).toLong() } ?: 0L
    return chStartMs + player.currentPosition
  }

  /** Seek the windowed player to an absolute book position (ms). */
  private fun seekToAbsolute(player: Player, absMs: Long) {
    val sec = absMs / 1000.0
    val idx = chapters.indexOfFirst { sec >= it.start && sec < it.end }
      .let { if (it >= 0) it else chapters.size - 1 }
    if (idx < 0) { player.seekTo(absMs); return }
    val offset = (absMs - (chapters[idx].start * 1000).toLong()).coerceAtLeast(0)
    player.seekTo(idx, offset)
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
    io.execute {
      try {
        val clubId = findClubForBook(base, tok, itemId) ?: return@execute
        // Guard against a newer book having loaded while this ran.
        if (currentItemId != itemId) return@execute
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
    val clubId = noteClubId ?: return
    if (!notePopsEnabled) return
    val itemId = currentItemId ?: return
    val base = serverUrl ?: return
    val tok = token ?: return

    val nowSec = absolutePositionMs(player) / 1000.0

    // Throttled stub refresh (~45s), off the main thread.
    if (System.currentTimeMillis() - lastNotesFetchMs > 45_000L) {
      lastNotesFetchMs = System.currentTimeMillis()
      val posForFetch = nowSec
      io.execute {
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

    val stubs = noteStubs
    if (stubs.isEmpty()) return

    val seen = loadNoteSeen(clubId)
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
    io.execute {
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
      resources.getIdentifier("ic_hs_notification", "drawable", packageName),
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
      resources.getIdentifier("ic_hs_notification", "drawable", packageName),
      "Mark as read",
      markReadPi,
    )
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
      .setShowsUserInterface(false)
      .build()

    val notification = NotificationCompat.Builder(this, NOTE_CHANNEL_ID)
      .setSmallIcon(resources.getIdentifier("ic_hs_notification", "drawable", packageName))
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
    prefs.edit().putString(noteSeenKey(clubId), JSONArray(ids).toString()).apply()
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

  /** Build the children for a browse node by querying ABS directly. */
  private fun childrenOf(parentId: String): ImmutableList<MediaItem> {
    val base = serverUrl ?: return ImmutableList.of()
    val tok = token ?: return ImmutableList.of()

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
      val resId = resources.getIdentifier(iconDrawable, "drawable", packageName)
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
          .put("clientVersion", "0.0.1"))
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
    return parseBooks(JSONObject(body).optJSONArray("libraryItems"))
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
   * id, so the Book we return carries a "podId/episodeId" id that resolveChapterWindows
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
