package com.hearthshelf.mobile

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import com.google.common.util.concurrent.MoreExecutors

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
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "HearthShelfAuto"

  init {
    emitter = { name, params -> sendEvent(name, params) }
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

  /** Publish the phone's computed Discover feed for the car to browse. The car
   *  service can't run the TS taste engine, so JS hands it a ready snapshot:
   *  { shelves: [{ id, label, items: [{ id, title, author }] }] }. */
  @ReactMethod
  fun setDiscover(json: String) {
    prefs().edit().putString("discover", json).apply()
  }

  /** Mirror the notePops master on/off into the car service's prefs. The RN
   *  settings store persists to AsyncStorage (SQLite), which the headless Auto
   *  service can't read, so JS pushes the boolean here. See
   *  HearthShelfAutoService.notePopsEnabled. */
  @ReactMethod
  fun setNotePopsEnabled(enabled: Boolean) {
    prefs().edit().putBoolean("notePopsEnabled", enabled).apply()
  }

  @ReactMethod
  fun clearSession() {
    prefs().edit()
      .remove("serverUrl").remove("token")
      .remove("skipBackSec").remove("skipForwardSec")
      .remove("discover")
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

  private fun ensureService() {
    // Start the media service if it isn't up yet.
    ctx.startService(Intent(ctx, HearthShelfPlayerService::class.java))
    connectController()
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
    chaptersJson: String
  ) {
    // Under the same lock the service's onCreate/onDestroy use, so we either hand
    // the load to a live service or stash it for onCreate to drain - never both,
    // never a lost/stale load.
    var svc: HearthShelfPlayerService? = null
    synchronized(HearthShelfPlayerService.lock) {
      svc = HearthShelfPlayerService.instance
      if (svc == null) {
        HearthShelfPlayerService.pendingLoad =
          HearthShelfPlayerService.PendingLoad(url, startSec, title, author, artworkUri, chaptersJson)
      }
    }
    val live = svc
    if (live != null) live.load(url, startSec, title, author, artworkUri, chaptersJson)
    else ensureService()
  }

  @ReactMethod fun play() { HearthShelfPlayerService.instance?.playPlayer() }
  @ReactMethod fun pause() { HearthShelfPlayerService.instance?.pausePlayer() }
  @ReactMethod fun seekTo(sec: Double) { HearthShelfPlayerService.instance?.seekToSec(sec) }
  @ReactMethod fun setRate(rate: Double) { HearthShelfPlayerService.instance?.setRate(rate) }
  @ReactMethod fun setVolume(volume: Double) { HearthShelfPlayerService.instance?.setVolume(volume) }
  @ReactMethod fun stop() { HearthShelfPlayerService.instance?.stopPlayer() }

  // RN NativeEventEmitter requires these no-op stubs on the module.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  companion object {
    /** Set by the module so the service can emit events back to JS. */
    @Volatile var emitter: ((String, WritableMap?) -> Unit)? = null

    fun emitProgress(positionSec: Double) {
      val map = Arguments.createMap().apply { putDouble("position", positionSec) }
      emitter?.invoke("onProgress", map)
    }
    fun emitState(isPlaying: Boolean) {
      val map = Arguments.createMap().apply { putBoolean("isPlaying", isPlaying) }
      emitter?.invoke("onState", map)
    }
    fun emitTogglePlay() {
      emitter?.invoke("onTogglePlay", Arguments.createMap())
    }
    fun emitJump(deltaSec: Double) {
      val map = Arguments.createMap().apply { putDouble("delta", deltaSec) }
      emitter?.invoke("onJump", map)
    }
    // The current book reached its end. JS advances the up-next queue (server
    // owns the queue; JS plays its head) rather than the service picking a next
    // track, so the phone + car share one queue.
    fun emitEnded() {
      emitter?.invoke("onEnded", Arguments.createMap())
    }
  }
}

@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class HearthShelfAutoPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(HearthShelfAutoModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
