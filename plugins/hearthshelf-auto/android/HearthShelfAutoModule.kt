package com.hearthshelf.mobile

import android.content.Context
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * Tiny bridge so JS can hand the connected ABS server URL + token to the native
 * Android Auto service (which runs in its own process and can't read JS state).
 * Values land in SharedPreferences; HearthShelfAutoService reads them.
 *
 * Plain RN module (old arch is fine for two setters) registered via
 * HearthShelfAutoPackage in MainApplication (injected by the config plugin).
 */
class HearthShelfAutoModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "HearthShelfAuto"

  private fun prefs() =
    ctx.getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)

  @ReactMethod
  fun setSession(serverUrl: String, token: String) {
    prefs().edit().putString("serverUrl", serverUrl).putString("token", token).apply()
  }

  @ReactMethod
  fun clearSession() {
    prefs().edit().remove("serverUrl").remove("token").apply()
  }
}

class HearthShelfAutoPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(HearthShelfAutoModule(ctx))

  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
