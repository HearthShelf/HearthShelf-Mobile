package com.hearthshelf.mobile

import android.content.Context
import android.os.Bundle
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
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
  private val io = Executors.newSingleThreadExecutor()

  private val TAG = "HSAuto"

  private val prefs by lazy {
    getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)
  }
  private val serverUrl: String?
    get() = prefs.getString("serverUrl", null)?.trimEnd('/')
  private val token: String?
    get() = prefs.getString("token", null)

  // Skip amounts (seconds) for the seek buttons. Match the in-app player's
  // rewind/forward defaults; a later pass can read the user's setting.
  private val REWIND_SEC = 15L
  private val FORWARD_SEC = 30L

  // Custom transport commands surfaced with our own circular icons, so the
  // notification / Android Auto stop showing the default fast-forward/rewind
  // glyphs. Handled in LibraryCallback.onCustomCommand.
  private val CMD_REWIND = "com.hearthshelf.REWIND"
  private val CMD_FORWARD = "com.hearthshelf.FORWARD"

  private fun rewindButton(): CommandButton =
    CommandButton.Builder()
      .setDisplayName("Back ${REWIND_SEC}s")
      .setIconResId(resources.getIdentifier("ic_hs_rewind", "drawable", packageName))
      .setSessionCommand(SessionCommand(CMD_REWIND, Bundle.EMPTY))
      .build()

  private fun forwardButton(): CommandButton =
    CommandButton.Builder()
      .setDisplayName("Forward ${FORWARD_SEC}s")
      .setIconResId(resources.getIdentifier("ic_hs_forward", "drawable", packageName))
      .setSessionCommand(SessionCommand(CMD_FORWARD, Bundle.EMPTY))
      .build()

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "onCreate: serverUrl=${serverUrl != null}, token=${token != null}")
    val player = ExoPlayer.Builder(this).build()
    session = MediaLibrarySession.Builder(this, player, LibraryCallback())
      // Rewind | (play/pause is standard) | Forward, with our circular icons.
      .setCustomLayout(ImmutableList.of(rewindButton(), forwardButton()))
      .build()
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

  /**
   * Last search's results, cached so onGetSearchResult can serve them without a
   * second round-trip to ABS. onSearch does the query, stashes the books here,
   * then notifies the client of the count; the client then pulls pages from this.
   */
  @Volatile private var lastSearchQuery: String? = null
  @Volatile private var lastSearchBooks: List<Book> = emptyList()

  private inner class LibraryCallback : MediaLibrarySession.Callback {

    /** Grant our custom seek commands so the buttons are actionable, and publish
     *  the custom layout (rewind | forward) to this controller. */
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo
    ): MediaSession.ConnectionResult {
      val available = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS
        .buildUpon()
        .add(SessionCommand(CMD_REWIND, Bundle.EMPTY))
        .add(SessionCommand(CMD_FORWARD, Bundle.EMPTY))
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(available)
        .setCustomLayout(ImmutableList.of(rewindButton(), forwardButton()))
        .build()
    }

    /** Seek by our fixed amounts when the custom rewind/forward buttons fire. */
    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle
    ): ListenableFuture<SessionResult> {
      val player = session.player
      when (customCommand.customAction) {
        CMD_REWIND -> player.seekTo((player.currentPosition - REWIND_SEC * 1000).coerceAtLeast(0))
        CMD_FORWARD -> {
          val dur = player.duration
          val target = player.currentPosition + FORWARD_SEC * 1000
          player.seekTo(if (dur > 0) target.coerceAtMost(dur) else target)
        }
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
        mediaItems.map { item ->
          val id = item.mediaId.removePrefix(PLAY_PREFIX)
          resolvePlayable(id) ?: item
        }.toMutableList()
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
    for (lib in absLibraries(base, tok)) {
      for (b in absSearchLibrary(base, tok, lib.first, query)) {
        if (seen.add(b.id)) out.add(b)
      }
    }
    return out
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
