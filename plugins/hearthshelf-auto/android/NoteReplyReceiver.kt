package com.hearthshelf.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Receives the voice/text reply from a club note-pop notification (Android Auto's
 * RemoteInput, or the phone's inline reply) and POSTs it to /hs/notes as a reply
 * to the crossed note. See HearthShelfAutoService.postNoteNotification and
 * docs/social.md "Phase 7".
 *
 * The reply is a normal note with parentId set to the crossed note's id, so it
 * threads under it (the notes API gates a reply at its PARENT's timeSec, so a
 * reply is always visible to anyone who could see the note they're replying to).
 * Server URL + ABS token are read from the same "hearthshelf_auto" prefs the
 * service uses; the POST mirrors httpPostSync's request shape (Bearer + JSON).
 */
class NoteReplyReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_REPLY) return
    val reply = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY)?.toString()?.trim()
    val clubId = intent.getStringExtra(EXTRA_CLUB_ID)
    val itemId = intent.getStringExtra(EXTRA_ITEM_ID)
    val parentId = intent.getStringExtra(EXTRA_PARENT_ID)
    val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, 0)

    // Clear the notification regardless (the user acted on it).
    if (notifId != 0) {
      try {
        NotificationManagerCompat.from(context).cancel(notifId)
      } catch (e: Exception) {
        // best-effort
      }
    }

    if (reply.isNullOrEmpty() || clubId == null || itemId == null || parentId == null) return

    val prefs = context.getSharedPreferences("hearthshelf_auto", Context.MODE_PRIVATE)
    val base = prefs.getString("serverUrl", null)?.trimEnd('/') ?: return
    val tok = prefs.getString("token", null) ?: return

    // Broadcast receivers get a short window on the main thread; do the network
    // call off-thread. A goAsync()/pendingResult keeps the process alive briefly.
    val pending = goAsync()
    io.execute {
      try {
        postReply(base, tok, clubId, itemId, parentId, reply)
      } catch (e: Exception) {
        Log.w(TAG, "note reply post failed: ${e.message}")
      } finally {
        pending.finish()
      }
    }
  }

  private fun postReply(
    base: String,
    tok: String,
    clubId: String,
    itemId: String,
    parentId: String,
    body: String,
  ) {
    val conn = (URL("$base/hs/notes").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      setRequestProperty("Authorization", "Bearer $tok")
      setRequestProperty("Content-Type", "application/json")
      doOutput = true
      connectTimeout = 8000
      readTimeout = 8000
    }
    val json = JSONObject()
      .put("libraryItemId", itemId)
      .put("clubId", clubId)
      .put("parentId", parentId)
      // A reply gates at its parent's timeSec, so it carries no timeSec of its own.
      .put("timeSec", JSONObject.NULL)
      .put("body", body)
    conn.outputStream.use { it.write(json.toString().toByteArray()) }
    val code = conn.responseCode
    if (code !in 200..299) Log.w(TAG, "note reply POST -> HTTP $code")
  }

  companion object {
    private const val TAG = "HSAutoReply"
    private val io = Executors.newSingleThreadExecutor()

    const val ACTION_REPLY = "com.hearthshelf.NOTE_REPLY"
    const val KEY_REPLY = "hs_note_reply_text"
    const val EXTRA_CLUB_ID = "clubId"
    const val EXTRA_ITEM_ID = "libraryItemId"
    const val EXTRA_PARENT_ID = "parentId"
    const val EXTRA_NOTIF_ID = "notifId"
  }
}
