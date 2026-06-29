package com.hearthshelf.mobile

import android.content.Context
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
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
  private val io = Executors.newSingleThreadExecutor()

  private val TAG = "HSAuto"

  private val prefs by lazy {
    getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)
  }
  private val serverUrl: String?
    get() = prefs.getString("serverUrl", null)?.trimEnd('/')
  private val token: String?
    get() = prefs.getString("token", null)

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "onCreate: serverUrl=${serverUrl != null}, token=${token != null}")
    val player = ExoPlayer.Builder(this).build()
    session = MediaLibrarySession.Builder(this, player, LibraryCallback()).build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
    session

  override fun onDestroy() {
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }

  // ---- browse-tree ids ----
  private val ROOT = "root"
  private val CONTINUE = "continue"
  private val LIB_PREFIX = "lib:"
  private val PLAY_PREFIX = "play:"

  private inner class LibraryCallback : MediaLibrarySession.Callback {

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
        mediaItems.map { item ->
          val id = item.mediaId.removePrefix(PLAY_PREFIX)
          resolvePlayable(id) ?: item
        }.toMutableList()
      }
      return Futures.immediateFuture(resolved.get())
    }
  }

  /** POST /api/items/:id/play -> real stream URL + resume position. */
  private fun resolvePlayable(itemId: String): MediaItem? {
    val base = serverUrl ?: return null
    val tok = token ?: return null
    Log.i(TAG, "resolvePlayable item=$itemId")
    val body = httpPostPlay("$base/api/items/$itemId/play", tok)
    if (body == null) { Log.e(TAG, "play session failed for $itemId"); return null }
    val session = JSONObject(body)
    val tracks = session.optJSONArray("audioTracks") ?: return null
    if (tracks.length() == 0) return null
    val contentUrl = tracks.getJSONObject(0).optString("contentUrl")
    val streamUrl = "$base$contentUrl?token=$tok"
    val startSec = session.optDouble("currentTime", 0.0)
    val art = "$base/api/items/$itemId/cover?token=$tok"
    return MediaItem.Builder()
      .setMediaId("$PLAY_PREFIX$itemId")
      .setUri(streamUrl)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(session.optString("displayTitle", "Audiobook"))
          .setArtist(session.optString("displayAuthor", ""))
          .setArtworkUri(android.net.Uri.parse(art))
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
          .build()
      )
      .build()
  }

  /** Build the children for a browse node by querying ABS directly. */
  private fun childrenOf(parentId: String): ImmutableList<MediaItem> {
    val base = serverUrl ?: return ImmutableList.of()
    val tok = token ?: return ImmutableList.of()

    return when {
      parentId == ROOT -> {
        val root = mutableListOf<MediaItem>()
        // Continue Listening (only if there's anything in progress)
        if (absItemsInProgress(base, tok).isNotEmpty()) {
          root.add(browsable(CONTINUE, "Continue Listening"))
        }
        for (lib in absLibraries(base, tok)) {
          root.add(browsable("$LIB_PREFIX${lib.first}", lib.second))
        }
        ImmutableList.copyOf(root)
      }
      parentId == CONTINUE ->
        ImmutableList.copyOf(absItemsInProgress(base, tok).map { playable(base, tok, it) })
      parentId.startsWith(LIB_PREFIX) -> {
        val libId = parentId.removePrefix(LIB_PREFIX)
        ImmutableList.copyOf(absLibraryItems(base, tok, libId).map { playable(base, tok, it) })
      }
      else -> ImmutableList.of()
    }
  }

  // ---- MediaItem builders ----

  private fun browsable(id: String, title: String): MediaItem =
    MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(title)
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
          .build()
      )
      .build()

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
    val author: String
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

  /** Libraries -> list of (id, name) for book libraries. */
  private fun absLibraries(base: String, tok: String): List<Pair<String, String>> {
    val body = httpGet("$base/api/libraries", tok) ?: return emptyList()
    val arr = JSONObject(body).optJSONArray("libraries") ?: return emptyList()
    val out = mutableListOf<Pair<String, String>>()
    for (i in 0 until arr.length()) {
      val lib = arr.getJSONObject(i)
      if (lib.optString("mediaType") == "book") {
        out.add(lib.getString("id") to lib.optString("name", "Library"))
      }
    }
    return out
  }

  private fun absLibraryItems(base: String, tok: String, libId: String): List<Book> {
    val body = httpGet("$base/api/libraries/$libId/items?limit=100&minified=1", tok)
      ?: return emptyList()
    return parseBooks(JSONObject(body).optJSONArray("results"))
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
      out.add(
        Book(
          id = id,
          title = meta.optString("title", "Untitled"),
          author = meta.optString("authorName", "")
        )
      )
    }
    return out
  }
}
