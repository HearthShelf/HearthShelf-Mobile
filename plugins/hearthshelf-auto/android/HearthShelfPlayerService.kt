package com.hearthshelf.mobile

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.SoundPool
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
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

  /** How close to the end counts as "played to the end" when STATE_ENDED fires.
   *  Matches the car service's guard so both surfaces finish a book alike. */
  private val END_TOLERANCE_MS = 5000L

  // ---- shake-to-extend the sleep timer ----
  //
  // Runs in the always-alive foreground service (not JS) so a shake registers even
  // with the screen off and the app backgrounded - the accelerometer keeps
  // delivering because active audio playback holds the CPU awake. JS pushes the
  // user's settings (on/off + minutes) and whether a duration/clock sleep timer is
  // live into the shared prefs; we only subscribe the sensor while all conditions
  // hold, matching the old JS listener's battery gating. On a detected shake we
  // emit onShakeExtend and let the JS store add the minutes (store stays the source
  // of truth), same as every other native -> JS transport here.
  private val sensorManager by lazy {
    getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  }
  private val vibrator by lazy {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
  }

  /** A strong, unmistakable buzz the instant a shake is accepted. Fired natively
   *  (not via the JS haptics module) so it lands immediately even with the screen
   *  off / app backgrounded - the whole point of shake-to-extend. Gated by the
   *  user's Haptics setting, which JS pushes into prefs alongside the shake gate;
   *  silent only when Haptics is Off. */
  private fun buzzConfirm() {
    if (skipPrefs.getString("hapticLevel", "minimal") == "off") return
    val v = vibrator ?: return
    if (!v.hasVibrator()) return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        // A firm double-pulse at full amplitude: unmistakable half-asleep, in the
        // dark, phone face-down - stronger and harder to miss than a single tick.
        // timings/amplitudes: buzz 45ms @ max, gap 60ms, buzz 90ms @ max.
        val timings = longArrayOf(0, 45, 60, 90)
        val amps = intArrayOf(0, 255, 0, 255)
        val effect = if (v.hasAmplitudeControl()) {
          VibrationEffect.createWaveform(timings, amps, -1)
        } else {
          VibrationEffect.createWaveform(longArrayOf(0, 45, 60, 90), -1)
        }
        v.vibrate(effect)
      } else {
        @Suppress("DEPRECATION")
        v.vibrate(longArrayOf(0, 45, 60, 90), -1)
      }
    } catch (e: Exception) {
      // Haptics are decoration - never let a vibration failure break the extend.
    }
  }
  @Volatile private var shakeRegistered = false
  private var lastShakeAt = 0L
  // True when we fell back to the raw accelerometer (no fused linear-accel sensor);
  // that stream includes gravity, so we high-pass it out per-axis before measuring.
  private var shakeUsesRawAccel = false
  private val gravity = floatArrayOf(0f, 0f, 0f)

  /** Shake magnitude (m/s^2, gravity removed) that counts as an intentional shake. */
  private val SHAKE_THRESHOLD = 18f
  /** Minimum gap between two accepted shakes (ms), so one shake adds time once. */
  private val SHAKE_COOLDOWN_MS = 3000L

  private val shakeListener = object : SensorEventListener {
    override fun onSensorChanged(e: SensorEvent) {
      var x = e.values[0]; var y = e.values[1]; var z = e.values[2]
      if (shakeUsesRawAccel) {
        // Low-pass to estimate gravity, then subtract it to isolate movement, so a
        // still phone reads ~0 like the fused linear-acceleration sensor does.
        val alpha = 0.8f
        gravity[0] = alpha * gravity[0] + (1 - alpha) * x
        gravity[1] = alpha * gravity[1] + (1 - alpha) * y
        gravity[2] = alpha * gravity[2] + (1 - alpha) * z
        x -= gravity[0]; y -= gravity[1]; z -= gravity[2]
      }
      val mag = kotlin.math.sqrt(x * x + y * y + z * z)
      if (mag < SHAKE_THRESHOLD) return
      val now = SystemClock.elapsedRealtime()
      if (now - lastShakeAt < SHAKE_COOLDOWN_MS) return
      // Re-check the gate at fire time (playback/timer can flip between ticks).
      if (!shakeConditionsMet()) return
      lastShakeAt = now
      // Strong native buzz first, so the confirmation is felt instantly even
      // backgrounded - before the JS bridge round-trip adds the minutes.
      buzzConfirm()
      val mins = skipPrefs.getInt("sleepShakeMinutes", 5)
      HearthShelfAutoModule.emitShakeExtend(mins)
    }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
  }

  /** True when a shake should currently add time: setting on, a duration/clock
   *  sleep timer live (pushed from JS), and audio actually playing. */
  private fun shakeConditionsMet(): Boolean {
    if (!skipPrefs.getBoolean("sleepShakeExtend", false)) return false
    if (!skipPrefs.getBoolean("sleepTimerActive", false)) return false
    // Not while the car owns playback - the phone player is stood down then.
    if (HearthShelfAutoModule.carPlayer != null) return false
    return exo?.isPlaying == true
  }

  /** (Un)subscribe the accelerometer to match the current gate. Cheap to call on
   *  every state change; only touches the sensor when the state actually flips. */
  fun evaluateShake() = runOnMain {
    val want = shakeConditionsMet()
    if (want && !shakeRegistered) {
      // Prefer the fused gravity-removed sensor; fall back to the raw accelerometer
      // (always present) with a per-axis high-pass filter when it's absent.
      val sm = sensorManager ?: return@runOnMain
      var sensor = sm.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
      shakeUsesRawAccel = sensor == null
      if (sensor == null) {
        sensor = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        gravity[0] = 0f; gravity[1] = 0f; gravity[2] = 0f
      }
      if (sensor != null) {
        sm.registerListener(shakeListener, sensor, SensorManager.SENSOR_DELAY_UI)
        shakeRegistered = true
      }
    } else if (!want && shakeRegistered) {
      sensorManager?.unregisterListener(shakeListener)
      shakeRegistered = false
    }
  }

  // ---- warning beeps before the sleep timer ends ----
  //
  // Same rationale as shake-to-extend: the cue must sound with the screen off /
  // app backgrounded, when the JS sleep-timer tick is suspended but this
  // foreground service's progressTick keeps running (active audio holds the CPU
  // awake). JS pushes the beep settings + the current remaining PLAYBACK seconds
  // whenever the sleep timer is armed/extended/cancelled; we decrement our own
  // copy by the observed playback advance each tick (mirroring how the JS store
  // decrements off position deltas), so the countdown stays right between pushes.
  // We play the cue via SoundPool on the media stream so it mixes over the book
  // without requesting audio focus (no ducking / no pausing the book).
  @Volatile private var soundPool: SoundPool? = null
  // Loaded sound ids by name ("chime"/"marimba"/"beep"/"bell").
  private val beepSoundIds = HashMap<String, Int>()
  // Remaining playback seconds on the live sleep timer, mirrored from JS and
  // decremented locally each tick; null when no duration/clock timer is armed.
  @Volatile private var beepRemainingSec: Double? = null
  // Absolute book position (sec) at the last tick, to measure playback advance.
  private var beepLastPosSec = -1.0
  // Which thresholds have already fired for the current timer, so each beeps once.
  private var beeped2min = false
  private var beeped1min = false
  private var beepedFinal = false

  private val beepPrefs
    get() = getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)

  private fun initSoundPool() {
    if (soundPool != null) return
    val attrs = android.media.AudioAttributes.Builder()
      .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
      .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    val pool = SoundPool.Builder().setMaxStreams(2).setAudioAttributes(attrs).build()
    for (name in listOf("chime", "marimba", "beep", "bell")) {
      val resId = resources.getIdentifier("beep_$name", "raw", packageName)
      if (resId != 0) beepSoundIds[name] = pool.load(this, resId, 1)
    }
    soundPool = pool
  }

  /** Clear the per-timer beep state (used on a genuine arm/extend/cancel). */
  private fun clearBeepState() {
    beepLastPosSec = -1.0
    beeped2min = false
    beeped1min = false
    beepedFinal = false
  }

  /** Play a beep by the user's chosen tone at the cue volume (0..1). No-op if the
   *  pool isn't ready or the tone failed to load. */
  private fun playBeep() {
    val pool = soundPool ?: return
    val name = beepPrefs.getString("sleepBeepSound", "chime") ?: "chime"
    val id = beepSoundIds[name] ?: beepSoundIds["chime"] ?: return
    val vol = (beepPrefs.getInt("sleepBeepVolume", 60) / 100f).coerceIn(0f, 1f)
    pool.play(id, vol, vol, 1, 0, 1f)
  }

  /** Called each progress tick while playing: advance the local remaining-seconds
   *  mirror and fire any enabled cue as the countdown crosses its threshold. */
  private fun maybeBeep(posSec: Double) {
    if (!beepPrefs.getBoolean("sleepBeepEnabled", false)) return
    val remainingBefore = beepRemainingSec ?: return
    // Measure playback advance since the last tick (first tick just seeds).
    val advance = if (beepLastPosSec < 0) 0.0 else (posSec - beepLastPosSec).coerceAtLeast(0.0)
    beepLastPosSec = posSec
    val remaining = remainingBefore - advance
    beepRemainingSec = remaining

    // Cross a threshold: remaining was above it last tick and is at/below now.
    fun crossed(mark: Double) = remainingBefore > mark && remaining <= mark

    if (!beeped2min && beepPrefs.getBoolean("sleepBeepAt2min", true) && crossed(120.0)) {
      beeped2min = true
      playBeep()
    }
    if (!beeped1min && beepPrefs.getBoolean("sleepBeepAt1min", true) && crossed(60.0)) {
      beeped1min = true
      playBeep()
    }
    // Final cue just before the timer fires (JS pauses at remaining <= 0).
    if (!beepedFinal && beepPrefs.getBoolean("sleepBeepFinal", false) && remaining <= 1.0) {
      beepedFinal = true
      playBeep()
    }
  }

  /** JS pushed the live timer's remaining playback seconds (null = no
   *  duration/clock timer). JS pushes on EVERY store change, including each
   *  routine progress tick, so most pushes just re-sync our locally-decremented
   *  mirror to correct drift - they must NOT clear the fired-once flags or the
   *  cues would re-arm every second. Only a genuine (re)arm or extend clears the
   *  per-timer state: the timer going from none -> armed, or remaining jumping UP
   *  (an extend / a fresh, longer timer). A routine tick carries a remaining <=
   *  our mirror, so it only updates the value. Lazily builds the SoundPool the
   *  first time a timer is armed so a user who never uses beeps pays nothing. */
  fun updateSleepBeep(remainingSec: Double?) = runOnMain {
    val prev = beepRemainingSec
    if (remainingSec == null) {
      // Timer cancelled / ended.
      if (prev != null) clearBeepState()
      beepRemainingSec = null
      return@runOnMain
    }
    if (beepPrefs.getBoolean("sleepBeepEnabled", false)) initSoundPool()
    // Arm (was none) or extend (jumped up beyond a tick's worth of drift).
    if (prev == null || remainingSec > prev + 2.0) clearBeepState()
    beepRemainingSec = remainingSec
  }

  private val progressHandler = android.os.Handler(android.os.Looper.getMainLooper())
  // Whether the 1s tick is currently scheduled. It only runs while audio is
  // actually playing - see startProgressTick/stopProgressTick.
  private var progressTicking = false
  private val progressTick = object : Runnable {
    override fun run() {
      val p = exo
      // Stop rescheduling once playback stops. Everything below is either about
      // advancing audio (progress, chapter subtitle, sleep beeps) or is
      // re-evaluated on the state edge anyway, so a paused tick did nothing but
      // wake the CPU every second - for as long as the service lived, which for
      // a paused audiobook can be hours.
      if (p == null || !p.isPlaying) {
        progressTicking = false
        // One last shake re-check so the sensor isn't left registered against a
        // now-stale gate (the play/pause edge also calls this).
        evaluateShake()
        return
      }
      // While the car owns playback its service drives the store; a stray phone
      // emit here would fight the car's mirror, so stay quiet.
      if (HearthShelfAutoModule.carPlayer == null) {
        HearthShelfAutoModule.emitProgress(p.currentPosition / 1000.0)
        refreshChapterSubtitle()
        maybeBeep(p.currentPosition / 1000.0)
      }
      // Heartbeat re-check so a missed state edge (e.g. car handoff) can't strand
      // the sensor registered/unregistered against the real gate.
      evaluateShake()
      progressHandler.postDelayed(this, 1000)
    }
  }

  /** Begin the 1s tick if it isn't already running. Idempotent. */
  private fun startProgressTick() {
    if (progressTicking) return
    progressTicking = true
    progressHandler.postDelayed(progressTick, 1000)
  }

  /** Cancel the tick outright (teardown). */
  private fun stopProgressTick() {
    progressHandler.removeCallbacks(progressTick)
    progressTicking = false
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
        // The 1s tick only runs while audio advances; this edge is what starts it
        // (the Runnable stops itself on pause). Emit the true stop position first
        // so pausing still lands the exact spot before the tick goes quiet.
        if (isPlaying) {
          startProgressTick()
        } else if (HearthShelfAutoModule.carPlayer == null) {
          exo?.let { HearthShelfAutoModule.emitProgress(it.currentPosition / 1000.0) }
        }
        // Pausing/resuming flips the shake gate (only listen while playing).
        evaluateShake()
      }
      override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
        // The phone player had NO error handler at all: a stream that died
        // mid-book (server restarted, token expired, connection dropped under a
        // bridge) stopped the audio silently. Nothing reached JS, so the UI kept
        // claiming it was playing over silence and the only way out was for the
        // user to notice and tap play.
        //
        // Recoverable I/O faults are reported as onPlaybackLost, which is the
        // channel that already means "native no longer holds this track" - JS
        // responds by reloading the book from the live store position, which is
        // exactly the recovery a dropped stream needs. Crucially that path is
        // attempt-capped (RECLAIM_MAX_ATTEMPTS), so a server that is genuinely
        // down gives up and tells the user instead of retrying forever.
        //
        // Anything else (malformed media, unsupported codec) will fail the same
        // way on reload, so it is only reported, never retried.
        Log.e(TAG, "phone playerError ${error.errorCodeName}", error)
        if (HearthShelfAutoModule.carPlayer != null) return
        if (isRecoverableSourceError(error)) {
          HearthShelfAutoModule.emitPlaybackLost()
        } else {
          HearthShelfAutoModule.emitState(false)
        }
      }
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED && HearthShelfAutoModule.carPlayer == null) {
          // Only a book that actually PLAYED to its end may advance the queue.
          //
          // STATE_ENDED is not by itself proof of completion: an over-the-end
          // seek reaches it too (a 30s skip taken with 2s left), and an EMPTY
          // player prepares straight to ENDED with no loaded item and duration
          // C.TIME_UNSET. Reporting either as onEnded marks the book finished
          // and swaps the phone to the next queue item - a real user report
          // (finished-and-skipped from a Bluetooth skip near the end), and the
          // same shape as Sentry HS-MOBILEAPP-F on the car side.
          //
          // Positions here are ABSOLUTE book time: this listener is on the raw
          // ExoPlayer, not the chapter-relative ChapterForwardingPlayer the
          // MediaSession sees. The car service guards this identically - keep
          // the two in step.
          val posMs = player.currentPosition
          val durMs = player.duration
          val hasBook = player.currentMediaItem != null
          val nearEnd = hasBook && durMs > 0 && posMs >= durMs - END_TOLERANCE_MS
          HearthShelfAutoModule.emitState(false)
          if (nearEnd) HearthShelfAutoModule.emitEnded()
        }
        // Real rebuffer signal for the UI ring: the engine ran out of data while
        // it intends to play. Cleared on any other state (READY resumes, IDLE and
        // ENDED aren't buffering).
        if (HearthShelfAutoModule.carPlayer == null) {
          HearthShelfAutoModule.emitBuffering(
            state == Player.STATE_BUFFERING && player.playWhenReady
          )
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
      load(pl.url, pl.startSec, pl.title, pl.author, pl.artworkUri, pl.chaptersJson, pl.autoPlay)
    }

    // Only tick if the pending load actually started playing; otherwise the
    // play edge (onIsPlayingChanged) starts it.
    if (exo?.isPlaying == true) startProgressTick()
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
    stopProgressTick()
    if (shakeRegistered) {
      sensorManager?.unregisterListener(shakeListener)
      shakeRegistered = false
    }
    soundPool?.release()
    soundPool = null
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

  fun load(url: String, startSec: Double, title: String, author: String, artworkUri: String, chaptersJson: String, autoPlay: Boolean) = runOnMain {
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
    p.playWhenReady = autoPlay
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

  /**
   * Play, or report that there is nothing to play.
   *
   * After the OS reclaims the service (low memory), `exo` is null or has been
   * cleared of media items, and a plain `exo?.playWhenReady = true` silently
   * no-ops - the "tapped play, nothing happens, no error" failure
   * (HS-MOBILEAPP-Y). JS keys its reload on a `loadedKey` that still claims the
   * book is loaded, so nothing ever reloads it.
   *
   * The check and the play both happen HERE, inside runOnMain, rather than JS
   * asking a separate hasLoadedTrack() question first. Two reasons:
   *
   *  1. ExoPlayer enforces thread affinity on EVERY accessor, including
   *     getMediaItemCount(), via verifyApplicationThread() - not just on mutators.
   *     A synchronous getter called from the RN bridge thread (mqt_v_native)
   *     throws IllegalStateException and crashed the app (HS-MOBILEAPP-11). There
   *     is no safe way to answer this question synchronously from another thread.
   *  2. Even if there were, a separate check would race: the player could be
   *     reclaimed between the answer and the play. Deciding and acting in one
   *     main-thread hop cannot tear.
   *
   * `onLost` is invoked on the main thread when there was nothing to play.
   */
  fun playOrReportLost(onLost: () -> Unit) = runOnMain {
    val p = exo
    if (p == null || p.mediaItemCount == 0) onLost()
    else p.playWhenReady = true
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

    // Bluetooth headsets and car stereos send SEEK_FORWARD / SEEK_BACK (and
    // next/previous-item) rather than the custom REWIND/FORWARD buttons, which
    // only exist in our own notification layout. Left to ForwardingPlayer's
    // defaults those go straight to the wrapped ExoPlayer in ABSOLUTE time,
    // which is wrong twice over:
    //
    //  1. They bypass JS, so the store never learns the position moved - the
    //     in-app scrubber and the ABS sync both keep reporting the old spot.
    //  2. They use Media3's default increment, not the user's skip setting, and
    //     nothing bounds them, so a skip near the end runs past the final sample
    //     and lands on STATE_ENDED -> book marked finished, queue advanced.
    //
    // Route them through the same emitJump channel the custom buttons use: JS
    // owns the position, clamps it inside the book (requestSeek), and commands
    // the player back. seekToNext/Previous mean chapter navigation here, which
    // is likewise JS's call - a single-file book has no next media item, so the
    // default would otherwise be a silent no-op or an unintended stop.
    override fun seekForward() = HearthShelfAutoModule.emitJump(FORWARD_SEC.toDouble())
    override fun seekBack() = HearthShelfAutoModule.emitJump(-REWIND_SEC.toDouble())
    override fun seekToNext() = HearthShelfAutoModule.emitSkipChapter(1)
    override fun seekToPrevious() = HearthShelfAutoModule.emitSkipChapter(-1)
    override fun seekToNextMediaItem() = seekToNext()
    override fun seekToPreviousMediaItem() = seekToPrevious()

    // Media3 gates transport commands on what the player advertises. The wrapped
    // ExoPlayer holds ONE media item, so it advertises neither next nor previous
    // and a headset's track buttons arrive disabled - the reason chapter skip
    // never worked from Bluetooth. Advertise them (plus the seek increments) so
    // the overrides above are actually reachable.
    override fun getAvailableCommands(): Player.Commands =
      super.getAvailableCommands()
        .buildUpon()
        .add(Player.COMMAND_SEEK_FORWARD)
        .add(Player.COMMAND_SEEK_BACK)
        .add(Player.COMMAND_SEEK_TO_NEXT)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS)
        .build()

    override fun isCommandAvailable(command: Int): Boolean =
      availableCommands.contains(command)
  }

  // ---- custom command buttons (circular skip icons) ----

  private fun rewindButton(): CommandButton =
    CommandButton.Builder(CommandButton.ICON_SKIP_BACK)
      .setDisplayName("Back ${REWIND_SEC}s")
      .setCustomIconResId(resources.getIdentifier("ic_hs_rewind", "drawable", packageName))
      .setSessionCommand(SessionCommand(CMD_REWIND, Bundle.EMPTY))
      .build()

  private fun forwardButton(): CommandButton =
    CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD)
      .setDisplayName("Forward ${FORWARD_SEC}s")
      .setCustomIconResId(resources.getIdentifier("ic_hs_forward", "drawable", packageName))
      .setSessionCommand(SessionCommand(CMD_FORWARD, Bundle.EMPTY))
      .build()

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
    val chaptersJson: String,
    val autoPlay: Boolean
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
