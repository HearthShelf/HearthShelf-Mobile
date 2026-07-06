package com.hearthshelf.mobile

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray

/**
 * Phone media engine: a Media3 MediaSessionService that owns the ExoPlayer AND
 * the phone MediaSession, so WE control the lock-screen / notification.
 *
 * Two things react-native-video could not do, done here:
 *  - Chapter-relative progress: a ChapterForwardingPlayer wraps the real
 *    ExoPlayer and reports position/duration relative to the current chapter, so
 *    the notification's progress bar tracks the chapter, not the whole book.
 *    Seeks issued against those chapter-relative values are translated back to
 *    absolute book time before hitting the real player.
 *  - Custom circular skip icons via a custom command layout (ic_hs_rewind /
 *    ic_hs_forward), matching the in-app player.
 *
 * JS (PlayerHost, via HearthShelfAutoModule) drives load/play/pause/seek/rate/
 * volume; this service emits progress/state and lock-screen transport back to JS
 * so the JS store stays the single source of truth.
 */
class HearthShelfPlayerService : MediaSessionService() {

  private val TAG = "HSPlayer"

  private var exo: ExoPlayer? = null
  private var session: MediaSession? = null

  private data class Chapter(val title: String, val start: Double, val end: Double)

  // Chapters (absolute seconds) for the currently-loaded book, and whether to
  // report chapter-relative progress to the system (default on).
  @Volatile private var chapters: List<Chapter> = emptyList()
  private val chapterMode = true
  // Book title/author + the chapter index currently reflected in the metadata, so
  // we can refresh the "author · chapter" subtitle only when the chapter changes.
  @Volatile private var bookTitle = ""
  @Volatile private var bookAuthor = ""
  @Volatile private var artUri = ""
  @Volatile private var shownChapterIdx = -1

  // Skip amounts mirror the user's skipBack/skipForward settings, which JS pushes
  // into the shared "hearthshelf_auto" prefs (same store the car service reads).
  // Read live so a settings change takes effect on the next skip.
  private val skipPrefs
    get() = getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)
  private val REWIND_SEC: Long
    get() = skipPrefs.getInt("skipBackSec", 15).toLong()
  private val FORWARD_SEC: Long
    get() = skipPrefs.getInt("skipForwardSec", 30).toLong()
  private val CMD_REWIND = "com.hearthshelf.REWIND"
  private val CMD_FORWARD = "com.hearthshelf.FORWARD"
  // Pixel size for the runtime-rendered 48dp skip icon bitmaps.
  private val SKIP_ICON_PX = 96

  private val progressHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val progressTick = object : Runnable {
    override fun run() {
      exo?.let { p ->
        // While the car owns playback its service drives the store; a stray phone
        // emit here would fight the car's mirror, so stay quiet.
        if (p.isPlaying && HearthShelfAutoModule.carPlayer == null) {
          HearthShelfAutoModule.emitProgress(p.currentPosition / 1000.0)
          refreshChapterSubtitle()
        }
      }
      progressHandler.postDelayed(this, 1000)
    }
  }

  override fun onCreate() {
    super.onCreate()

    // Use the HearthShelf flame as the notification's small (status-bar) icon
    // instead of Media3's generic default play glyph.
    val notificationProvider = DefaultMediaNotificationProvider.Builder(this).build().apply {
      setSmallIcon(resources.getIdentifier("ic_hs_notification", "drawable", packageName))
    }
    setMediaNotificationProvider(notificationProvider)

    // Audiobook audio attributes + focus handling, and pause when the output
    // route drops to the phone speaker (headset yank, BT/car drop) - playback
    // must not continue out loud on the phone speaker.
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
    exo = player

    player.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        // Suppressed while the car owns playback (its service mirrors state); the
        // phone player is stopped in that mode, and its stop emit would otherwise
        // stomp the car's isPlaying in the store.
        if (HearthShelfAutoModule.carPlayer == null) HearthShelfAutoModule.emitState(isPlaying)
      }
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED && HearthShelfAutoModule.carPlayer == null) {
          HearthShelfAutoModule.emitState(false)
          HearthShelfAutoModule.emitEnded()
        }
      }
    })

    // Chapter-relative view the MediaSession (and therefore the notification)
    // sees. The real ExoPlayer keeps absolute book time.
    val sessionPlayer = ChapterForwardingPlayer(player)

    val sessionActivity = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    // A unique session id per service - Media3 requires every session in the
    // process to have a distinct id, and the phone + Auto services coexist.
    val builder = MediaSession.Builder(this, sessionPlayer)
      .setId("hearthshelf_phone")
      .setCallback(SessionCallback())
      .setCustomLayout(ImmutableList.of(rewindButton(), forwardButton()))
    if (sessionActivity != null) builder.setSessionActivity(sessionActivity)
    session = builder.build()

    // Publish the instance and drain any load stashed while the service was still
    // starting - atomically, so a direct load() racing in can't be clobbered by a
    // stale pending value. Guarded by the companion lock the module also holds.
    val pending: PendingLoad?
    synchronized(lock) {
      instance = this
      pending = pendingLoad
      pendingLoad = null
    }
    pending?.let { pl ->
      load(pl.url, pl.startSec, pl.title, pl.author, pl.artworkUri, pl.chaptersJson)
    }

    progressHandler.postDelayed(progressTick, 1000)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  /**
   * The user swiped the app off the recents list. Audiobook playback should stop
   * (not keep playing from a dead app), and the position we stopped at should be
   * synced. We emit a final paused state so JS - if it's still alive - flushes the
   * stop point, then stop the player and tear the service down so the OS reclaims
   * it. Without this a MediaSessionService keeps ExoPlayer playing after the task
   * is removed, and the app reopens at a stale (pre-swipe) position.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    exo?.let { p ->
      if (p.isPlaying || p.playWhenReady) {
        HearthShelfAutoModule.emitProgress(p.currentPosition / 1000.0)
      }
    }
    HearthShelfAutoModule.emitState(false)
    exo?.pause()
    exo?.stop()
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    progressHandler.removeCallbacks(progressTick)
    session?.run { release() }
    exo?.release()
    session = null
    exo = null
    synchronized(lock) {
      if (instance === this) instance = null
      // Drop any stashed load so a later, unrelated startService can't resurrect
      // a stale track.
      pendingLoad = null
    }
    super.onDestroy()
  }

  // ---- commands from JS (HearthShelfAutoModule) ----
  //
  // ExoPlayer requires all access on the thread its Looper was created on (the
  // main thread here). JS invokes these on RN's native modules thread, so every
  // command hops to the main thread first - otherwise ExoPlayer's
  // verifyApplicationThread() throws "Player is accessed on the wrong thread".

  private fun runOnMain(block: () -> Unit) {
    if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) block()
    else progressHandler.post(block)
  }

  fun load(url: String, startSec: Double, title: String, author: String, artworkUri: String, chaptersJson: String) = runOnMain {
    val p = exo ?: return@runOnMain
    chapters = parseChapters(chaptersJson)
    bookTitle = title
    bookAuthor = author
    artUri = artworkUri
    val startIdx = chapters.indexOfFirst { startSec >= it.start && startSec < it.end }
    shownChapterIdx = startIdx
    val item = MediaItem.Builder().setUri(url).setMediaMetadata(buildMeta(startIdx)).build()
    p.setMediaItem(item, (startSec * 1000).toLong())
    p.prepare()
    p.playWhenReady = true
  }

  /** MediaItem metadata with an "author · chapter" subtitle for the given chapter. */
  private fun buildMeta(chapterIdx: Int): MediaMetadata {
    val ch = chapters.getOrNull(chapterIdx)
    val subtitle = if (ch != null) "$bookAuthor · ${ch.title}" else bookAuthor
    return MediaMetadata.Builder()
      .setTitle(bookTitle)
      .setArtist(subtitle)
      .apply { if (artUri.isNotEmpty()) setArtworkUri(android.net.Uri.parse(artUri)) }
      .setIsPlayable(true)
      .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
      .build()
  }

  /** Refresh the notification subtitle when playback crosses into a new chapter,
   *  updating metadata seamlessly (same URI -> no reload/seek). */
  private fun refreshChapterSubtitle() {
    val p = exo ?: return
    if (chapters.isEmpty()) return
    val sec = p.currentPosition / 1000.0
    val idx = chapters.indexOfFirst { sec >= it.start && sec < it.end }
    if (idx < 0 || idx == shownChapterIdx) return
    shownChapterIdx = idx
    val cur = p.currentMediaItem ?: return
    p.replaceMediaItem(p.currentMediaItemIndex, cur.buildUpon().setMediaMetadata(buildMeta(idx)).build())
  }

  fun playPlayer() = runOnMain { exo?.playWhenReady = true }
  fun pausePlayer() = runOnMain { exo?.playWhenReady = false }
  fun seekToSec(sec: Double) = runOnMain {
    exo?.let { p ->
      // Preserve play/pause across the seek. Some seeks (esp. into an unbuffered
      // region) can otherwise leave playWhenReady flipped, stranding playback
      // paused after a skip.
      val wasPlaying = p.playWhenReady
      p.seekTo((sec * 1000).toLong())
      p.playWhenReady = wasPlaying
    }
  }
  fun setRate(rate: Double) = runOnMain { exo?.setPlaybackSpeed(rate.toFloat()) }
  fun setVolume(volume: Double) = runOnMain { exo?.volume = volume.toFloat() }
  fun stopPlayer() = runOnMain {
    exo?.stop()
    exo?.clearMediaItems()
    chapters = emptyList()
    shownChapterIdx = -1
  }

  // ---- chapter math ----

  /** The chapter containing an absolute position (seconds). */
  private fun chapterAt(posMs: Long): Chapter? {
    if (chapters.isEmpty()) return null
    val sec = posMs / 1000.0
    return chapters.firstOrNull { sec >= it.start && sec < it.end } ?: chapters.last()
  }

  private fun parseChapters(json: String): List<Chapter> {
    return try {
      val arr = JSONArray(json)
      (0 until arr.length()).map {
        val o = arr.getJSONObject(it)
        Chapter(o.optString("title", "Chapter ${it + 1}"), o.optDouble("start", 0.0), o.optDouble("end", 0.0))
      }
    } catch (e: Exception) {
      emptyList()
    }
  }

  /**
   * Presents chapter-relative position/duration to the MediaSession while the
   * wrapped ExoPlayer keeps absolute book time. Seeks arriving in chapter-relative
   * terms (from the notification scrubber) are mapped back to absolute.
   */
  private inner class ChapterForwardingPlayer(inner: Player) : ForwardingPlayer(inner) {
    private fun ch() = if (chapterMode) chapterAt(wrappedPlayer.currentPosition) else null

    override fun getCurrentPosition(): Long {
      val c = ch() ?: return super.getCurrentPosition()
      return (super.getCurrentPosition() - (c.start * 1000).toLong()).coerceAtLeast(0)
    }
    override fun getContentPosition(): Long = currentPosition
    override fun getDuration(): Long {
      val c = ch() ?: return super.getDuration()
      return ((c.end - c.start) * 1000).toLong()
    }
    override fun getContentDuration(): Long = duration
    override fun getBufferedPosition(): Long {
      val c = ch() ?: return super.getBufferedPosition()
      // Buffered is absolute (usually well past this chapter's end); clamp into
      // [0, chapterDuration] so the scrubber's buffer bar doesn't overflow.
      val rel = (super.getBufferedPosition() - (c.start * 1000).toLong()).coerceAtLeast(0)
      val chapterDur = ((c.end - c.start) * 1000).toLong()
      return rel.coerceAtMost(chapterDur)
    }
    override fun seekTo(positionMs: Long) {
      val c = ch()
      if (c != null) super.seekTo((c.start * 1000).toLong() + positionMs)
      else super.seekTo(positionMs)
    }
  }

  // ---- custom command buttons (circular skip icons) ----

  // Runtime-rendered skip icons keyed by direction+seconds, so a numeral matching
  // ANY chosen amount is drawn (the baked drawables only covered a few presets).
  // Cached so the notification refresh doesn't redraw the bitmap each tick.
  private val skipIconCache = HashMap<Int, androidx.core.graphics.drawable.IconCompat>()
  private fun skipIcon(direction: Int, seconds: Long): androidx.core.graphics.drawable.IconCompat {
    val key = direction * 1000 + seconds.toInt()
    return skipIconCache.getOrPut(key) {
      SkipIconRenderer.icon(direction, seconds.toInt(), SKIP_ICON_PX)
    }
  }

  private fun rewindButton(): CommandButton {
    val sec = REWIND_SEC
    return CommandButton.Builder(CommandButton.ICON_SKIP_BACK)
      .setDisplayName("Back ${sec}s")
      .setCustomIcon(skipIcon(-1, sec))
      .setSessionCommand(SessionCommand(CMD_REWIND, Bundle.EMPTY))
      .build()
  }

  private fun forwardButton(): CommandButton {
    val sec = FORWARD_SEC
    return CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD)
      .setDisplayName("Forward ${sec}s")
      .setCustomIcon(skipIcon(1, sec))
      .setSessionCommand(SessionCommand(CMD_FORWARD, Bundle.EMPTY))
      .build()
  }

  /** Rebuild the notification's skip buttons so a changed skipBack/skipForward
   *  (and its matching numeral icon) takes effect without restarting playback. */
  fun refreshSkipButtons() = runOnMain {
    session?.setCustomLayout(ImmutableList.of(rewindButton(), forwardButton()))
  }

  private inner class SessionCallback : MediaSession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo
    ): MediaSession.ConnectionResult {
      val available = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
        .buildUpon()
        .add(SessionCommand(CMD_REWIND, Bundle.EMPTY))
        .add(SessionCommand(CMD_FORWARD, Bundle.EMPTY))
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(available)
        .setCustomLayout(ImmutableList.of(rewindButton(), forwardButton()))
        .build()
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle
    ): ListenableFuture<SessionResult> {
      // Route the seek through JS so the store stays the source of truth; JS then
      // commands the player back via seekTo.
      when (customCommand.customAction) {
        CMD_REWIND -> HearthShelfAutoModule.emitJump(-REWIND_SEC.toDouble())
        CMD_FORWARD -> HearthShelfAutoModule.emitJump(FORWARD_SEC.toDouble())
        else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
      }
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }
  }

  data class PendingLoad(
    val url: String,
    val startSec: Double,
    val title: String,
    val author: String,
    val artworkUri: String,
    val chaptersJson: String
  )

  companion object {
    /** Guards the instance/pendingLoad handoff between the module and onCreate. */
    val lock = Any()
    @Volatile var instance: HearthShelfPlayerService? = null
    /** A load requested before the service finished starting (startService is
     *  async). onCreate drains it once the player exists. */
    @Volatile var pendingLoad: PendingLoad? = null
  }
}
