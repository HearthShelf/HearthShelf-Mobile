package com.hearthshelf.mobile

import android.content.Context
import android.content.Intent
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager

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
  fun setSession(serverUrl: String, token: String) {
    prefs().edit().putString("serverUrl", serverUrl).putString("token", token).apply()
  }

  @ReactMethod
  fun clearSession() {
    prefs().edit().remove("serverUrl").remove("token").apply()
  }

  // ---- phone playback commands (drive HearthShelfPlayerService) ----

  private fun ensureService() {
    // Start the foreground media service if it isn't up yet.
    ctx.startService(Intent(ctx, HearthShelfPlayerService::class.java))
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
  }
}

class HearthShelfAutoPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(HearthShelfAutoModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
