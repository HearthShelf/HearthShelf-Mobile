package com.hearthshelf.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.widget.RemoteViews
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONObject

/**
 * Home-screen widget: resume the current book without opening the app.
 *
 * Runs in the LAUNCHER's process, so there is no React runtime here and no
 * bridge - everything it draws comes from the `hearthshelf_auto` SharedPreferences
 * store that JS writes (see HearthShelfAutoModule.setNowPlaying), and everything
 * it does goes through the existing MediaSession.
 *
 * Two hard constraints shaped this:
 *  - RemoteViews cannot load a network url, so the cover is decoded from the
 *    downloaded file:// path when there is one and falls back to a typeset tile.
 *    The decode is bounded: a full-resolution cover blows the ~1.5MB RemoteViews
 *    transaction limit and silently renders nothing at all.
 *  - Android 12+ forbids starting a foreground service from the background, so a
 *    play tap connects a MediaController (exempt for media) rather than firing a
 *    service intent. When nothing is loaded it opens the app to the player
 *    instead, which always works.
 */
class HearthShelfWidgetProvider : AppWidgetProvider() {

  override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
    for (id in ids) render(ctx, mgr, id)
  }

  /** Resize: the tall layout adds the up-next section, so re-render on the edge. */
  override fun onAppWidgetOptionsChanged(
    ctx: Context,
    mgr: AppWidgetManager,
    id: Int,
    newOptions: Bundle,
  ) {
    render(ctx, mgr, id)
  }

  override fun onReceive(ctx: Context, intent: Intent) {
    super.onReceive(ctx, intent)
    when (intent.action) {
      ACTION_PLAY_PAUSE -> transport(ctx) { c ->
        if (c.isPlaying) c.pause() else c.play()
      }
      ACTION_BACK -> transport(ctx) { c ->
        c.seekTo((c.currentPosition - skipBackMs(ctx)).coerceAtLeast(0))
      }
      ACTION_FORWARD -> transport(ctx) { c ->
        c.seekTo(c.currentPosition + skipForwardMs(ctx))
      }
    }
  }

  /**
   * Drive the SAME MediaSession the notification uses - never an ExoPlayer
   * directly. The widget is a THIRD control surface alongside the phone and car
   * players, and every "which player owns playback" bug this project has had came
   * from a surface talking past the session.
   *
   * If nothing is playing there is no session to connect to; the tap falls back
   * to opening the app, which is honest and always works.
   */
  private fun transport(ctx: Context, action: (MediaController) -> Unit) {
    val token = SessionToken(ctx, ComponentName(ctx, HearthShelfPlayerService::class.java))
    val future = MediaController.Builder(ctx, token).buildAsync()
    future.addListener({
      try {
        val controller = future.get()
        action(controller)
        controller.release()
      } catch (_: Throwable) {
        // No live session (app cold, nothing loaded). Opening the player is the
        // honest fallback - resolving a stream url here would need an
        // authenticated request the launcher process cannot make.
        openApp(ctx).send()
      }
      refresh(ctx)
    }, MoreExecutors.directExecutor())
  }

  private fun render(ctx: Context, mgr: AppWidgetManager, id: Int) {
    val np = readNowPlaying(ctx)
    // Height in dp of the cell the user actually sized. Below the threshold the
    // short layout is used; the tall one adds the up-next rows. minSdk is 26, so
    // the API-31 size buckets are not available - this option has been there
    // since API 16 and works on every flavor we ship.
    val minHeight = mgr.getAppWidgetOptions(id)
      ?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
    val tall = minHeight >= TALL_DP
    val layout = if (tall) R.layout.hs_widget_tall else R.layout.hs_widget
    val views = RemoteViews(ctx.packageName, layout)

    if (np == null) {
      // Never a blank card: a fresh install with nothing played must read as
      // ready, not broken.
      views.setTextViewText(R.id.hs_widget_title, "Your hearth is ready")
      views.setTextViewText(R.id.hs_widget_author, "Tap to pick a book")
      views.setViewVisibility(R.id.hs_widget_transport, android.view.View.GONE)
      views.setProgressBar(R.id.hs_widget_progress, 100, 0, false)
      views.setOnClickPendingIntent(R.id.hs_widget_root, openApp(ctx))
      mgr.updateAppWidget(id, views)
      return
    }

    views.setViewVisibility(R.id.hs_widget_transport, android.view.View.VISIBLE)
    views.setTextViewText(R.id.hs_widget_title, np.title)
    views.setTextViewText(R.id.hs_widget_author, np.author)

    val pct = if (np.duration > 0) ((np.position / np.duration) * 100).toInt() else 0
    views.setProgressBar(R.id.hs_widget_progress, 100, pct.coerceIn(0, 100), false)

    decodeCover(np.cover)?.let { views.setImageViewBitmap(R.id.hs_widget_cover, it) }
      ?: views.setImageViewResource(R.id.hs_widget_cover, R.drawable.hs_widget_cover_fallback)

    views.setImageViewResource(
      R.id.hs_widget_play,
      if (np.isPlaying) R.drawable.ic_hs_pause else R.drawable.ic_hs_play,
    )
    // Skip glyphs carry the user's configured seconds, not a hardcoded 15/30.
    views.setImageViewResource(R.id.hs_widget_back, skipBackIcon(ctx))
    views.setImageViewResource(R.id.hs_widget_forward, skipForwardIcon(ctx))

    views.setOnClickPendingIntent(R.id.hs_widget_play, action(ctx, ACTION_PLAY_PAUSE))
    views.setOnClickPendingIntent(R.id.hs_widget_back, action(ctx, ACTION_BACK))
    views.setOnClickPendingIntent(R.id.hs_widget_forward, action(ctx, ACTION_FORWARD))
    // Artwork and title open the player; only the transport row acts in place.
    views.setOnClickPendingIntent(R.id.hs_widget_cover, openApp(ctx))
    views.setOnClickPendingIntent(R.id.hs_widget_title, openApp(ctx))

    if (tall) renderUpNext(ctx, views)

    mgr.updateAppWidget(id, views)
  }

  /** The queue section, shown only when the user sized the widget tall enough. */
  private fun renderUpNext(ctx: Context, views: RemoteViews) {
    val rows = readQueue(ctx)
    if (rows.isEmpty()) {
      views.setViewVisibility(R.id.hs_widget_upnext, android.view.View.GONE)
      return
    }
    views.setViewVisibility(R.id.hs_widget_upnext, android.view.View.VISIBLE)
    val ids = intArrayOf(R.id.hs_widget_next1, R.id.hs_widget_next2, R.id.hs_widget_next3)
    for (i in ids.indices) {
      if (i < rows.size) {
        views.setTextViewText(ids[i], rows[i])
        views.setViewVisibility(ids[i], android.view.View.VISIBLE)
      } else {
        views.setViewVisibility(ids[i], android.view.View.GONE)
      }
    }
  }

  private data class NowPlaying(
    val title: String,
    val author: String,
    val cover: String,
    val position: Double,
    val duration: Double,
    val isPlaying: Boolean,
  )

  private fun readNowPlaying(ctx: Context): NowPlaying? {
    val raw = prefs(ctx).getString("nowPlaying", null) ?: return null
    return try {
      val o = JSONObject(raw)
      val title = o.optString("title")
      if (title.isEmpty()) return null
      NowPlaying(
        title = title,
        author = o.optString("author"),
        cover = o.optString("cover"),
        position = o.optDouble("position", 0.0),
        duration = o.optDouble("duration", 0.0),
        isPlaying = o.optBoolean("isPlaying", false),
      )
    } catch (_: Throwable) {
      null
    }
  }

  private fun readQueue(ctx: Context): List<String> {
    val raw = prefs(ctx).getString("widgetQueue", null) ?: return emptyList()
    return try {
      val arr = JSONObject(raw).optJSONArray("items") ?: return emptyList()
      (0 until minOf(arr.length(), 3)).mapNotNull { i ->
        arr.optJSONObject(i)?.optString("title")?.takeIf { it.isNotEmpty() }
      }
    } catch (_: Throwable) {
      emptyList()
    }
  }

  /**
   * Decode the downloaded cover, bounded.
   *
   * RemoteViews ships the bitmap across a Binder transaction capped around 1.5MB;
   * a full-resolution cover exceeds it and the widget renders NOTHING, with no
   * error. So measure first and subsample to roughly the drawn size.
   */
  private fun decodeCover(uri: String): Bitmap? {
    if (uri.isEmpty()) return null
    val path = try {
      Uri.parse(uri).path ?: return null
    } catch (_: Throwable) {
      return null
    }
    return try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0) return null
      var sample = 1
      while (bounds.outWidth / sample > COVER_PX) sample *= 2
      BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    } catch (_: Throwable) {
      // A stale path (the download was removed, or the container moved) must fall
      // back to the placeholder, never crash the launcher's render.
      null
    }
  }

  private fun prefs(ctx: Context) =
    ctx.getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)

  private fun skipBackMs(ctx: Context) = prefs(ctx).getInt("skipBackSec", 15) * 1000L
  private fun skipForwardMs(ctx: Context) = prefs(ctx).getInt("skipForwardSec", 30) * 1000L

  /** Reuse the generated numeral glyphs the notification already uses, so the
   *  widget shows the seconds the user actually configured. */
  private fun skipBackIcon(ctx: Context): Int {
    val sec = prefs(ctx).getInt("skipBackSec", 15)
    val name = "ic_hs_rewind_" + nearestIconSec(sec, intArrayOf(5, 10, 15, 30, 60))
    return ctx.resources.getIdentifier(name, "drawable", ctx.packageName)
  }

  private fun skipForwardIcon(ctx: Context): Int {
    val sec = prefs(ctx).getInt("skipForwardSec", 30)
    val name = "ic_hs_forward_" + nearestIconSec(sec, intArrayOf(10, 15, 30, 60, 90))
    return ctx.resources.getIdentifier(name, "drawable", ctx.packageName)
  }

  /** A custom skip amount has no generated glyph; draw the closest one rather
   *  than an empty button. */
  private fun nearestIconSec(sec: Int, available: IntArray): Int {
    var best = available[0]
    for (candidate in available) {
      if (Math.abs(candidate - sec) < Math.abs(best - sec)) best = candidate
    }
    return best
  }

  private fun action(ctx: Context, what: String): PendingIntent {
    val intent = Intent(ctx, HearthShelfWidgetProvider::class.java).setAction(what)
    return PendingIntent.getBroadcast(
      ctx,
      what.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun openApp(ctx: Context): PendingIntent {
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      ?: Intent(Intent.ACTION_MAIN)
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      ctx,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  companion object {
    const val ACTION_PLAY_PAUSE = "com.hearthshelf.WIDGET_PLAY_PAUSE"
    const val ACTION_BACK = "com.hearthshelf.WIDGET_BACK"
    const val ACTION_FORWARD = "com.hearthshelf.WIDGET_FORWARD"

    /** Cell height (dp) at which the up-next section earns its place. Roughly
     *  three rows tall on a standard launcher grid. */
    private const val TALL_DP = 220

    /** Target cover edge in px. Comfortably above the drawn size on an xxhdpi
     *  screen and far below the RemoteViews transaction cap. */
    private const val COVER_PX = 256

    /**
     * Repaint every placed widget.
     *
     * Called from JS on a nowPlaying write, and from the player service's own
     * playback-state edges - `updatePeriodMillis` has a 30-minute floor and
     * cannot track a playhead, so the widget is push-driven or it is stale.
     */
    @JvmStatic
    fun refresh(ctx: Context) {
      try {
        val mgr = AppWidgetManager.getInstance(ctx) ?: return
        val ids = mgr.getAppWidgetIds(ComponentName(ctx, HearthShelfWidgetProvider::class.java))
        if (ids.isEmpty()) return
        val intent = Intent(ctx, HearthShelfWidgetProvider::class.java)
          .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
          .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
        ctx.sendBroadcast(intent)
      } catch (_: Throwable) {
        // A widget repaint must never take down playback.
      }
    }
  }
}
