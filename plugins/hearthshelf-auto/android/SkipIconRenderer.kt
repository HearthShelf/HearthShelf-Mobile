package com.hearthshelf.mobile

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import androidx.core.graphics.PathParser
import androidx.core.graphics.drawable.IconCompat

/**
 * Draws a skip button icon - a broken circular arrow with the exact skip amount
 * rendered as a bold numeral in the center - for ANY number of seconds, at
 * runtime. This replaces the pre-baked ic_hs_rewind_N.xml drawables, which only
 * covered a handful of amounts; the settings slider allows any multiple of 5 up
 * to 300, so the icon has to be generated to match whatever the user picks.
 *
 * The ring + digit path data is ported verbatim from res/gen-skip-icons.js so the
 * runtime glyphs match the in-app / previously-baked look. All paths live on a
 * 48x48 viewport (digits on a 12-wide x 16-tall cell, scaled + translated to
 * center in the ring).
 */
object SkipIconRenderer {
  // Circular arrow broken at the top with an arrowhead. Back points left; forward
  // is the same ring mirrored so the head points right.
  private const val RING_BACK =
    "M24,8 L24,2 L15,9.5 L24,17 L24,11.2 " +
      "C31.1,11.2 36.8,16.9 36.8,24 C36.8,31.1 31.1,36.8 24,36.8 " +
      "C16.9,36.8 11.2,31.1 11.2,24 C11.2,20.7 12.4,17.8 14.5,15.5 " +
      "L12.2,13.2 C9.5,16 7.9,19.8 7.9,24 C7.9,32.9 15.1,40.1 24,40.1 " +
      "C32.9,40.1 40.1,32.9 40.1,24 C40.1,15.1 32.9,8 24,8 Z"
  private const val RING_FWD =
    "M24,8 L24,2 L33,9.5 L24,17 L24,11.2 " +
      "C16.9,11.2 11.2,16.9 11.2,24 C11.2,31.1 16.9,36.8 24,36.8 " +
      "C31.1,36.8 36.8,31.1 36.8,24 C36.8,20.7 35.6,17.8 33.5,15.5 " +
      "L35.8,13.2 C38.5,16 40.1,19.8 40.1,24 C40.1,32.9 32.9,40.1 24,40.1 " +
      "C15.1,40.1 7.9,32.9 7.9,24 C7.9,15.1 15.1,8 24,8 Z"

  // Bold filled digit glyphs on a 0..12 wide, 0..16 tall cell (baseline at 16).
  private val DIGIT = mapOf(
    '0' to "M6,0 C9,0 11,2.6 11,8 C11,13.4 9,16 6,16 C3,16 1,13.4 1,8 C1,2.6 3,0 6,0 Z M6,2.4 C4.5,2.4 3.6,4.2 3.6,8 C3.6,11.8 4.5,13.6 6,13.6 C7.5,13.6 8.4,11.8 8.4,8 C8.4,4.2 7.5,2.4 6,2.4 Z",
    '1' to "M4.6,0 L8,0 L8,16 L5.4,16 L5.4,3 L3,3.6 L3,1.3 Z",
    '2' to "M1.3,4.3 C1.7,1.7 3.6,0 6.1,0 C8.8,0 10.7,1.8 10.7,4.4 C10.7,6.2 9.8,7.7 7.7,9.6 L4.8,12.3 L4.8,13.4 L10.9,13.4 L10.9,16 L1.1,16 L1.1,13.7 L5.9,9.3 C7.6,7.7 8.1,6.6 8.1,4.5 C8.1,3.2 7.3,2.5 6.1,2.5 C4.9,2.5 4.1,3.2 3.9,4.7 Z",
    '3' to "M1.4,3.2 C2,1.1 3.8,0 6,0 C8.8,0 10.8,1.7 10.8,4.2 C10.8,5.9 9.9,7.1 8.4,7.6 C10.1,8 11.2,9.4 11.2,11.3 C11.2,14.1 9,16 6,16 C3.6,16 1.6,14.7 1,12.5 L3.6,11.6 C3.9,12.8 4.8,13.5 6,13.5 C7.4,13.5 8.4,12.6 8.4,11.2 C8.4,9.8 7.4,9 5.8,9 L4.7,9 L4.7,6.6 L5.7,6.6 C7.1,6.6 8,5.8 8,4.5 C8,3.3 7.2,2.5 6,2.5 C4.9,2.5 4.1,3.1 3.8,4.2 Z",
    '4' to "M7.3,0 L10,0 L10,10.2 L11.6,10.2 L11.6,12.6 L10,12.6 L10,16 L7.4,16 L7.4,12.6 L0.6,12.6 L0.6,10.4 Z M7.4,10.2 L7.4,3.8 L3.3,10.2 Z",
    '5' to "M1.8,0 L10,0 L10,2.6 L4.3,2.6 L4.3,5.8 C4.9,5.5 5.6,5.4 6.3,5.4 C9.1,5.4 11,7.3 11,10.4 C11,13.6 8.9,16 5.9,16 C3.6,16 1.7,14.8 1,12.8 L3.6,11.7 C4,12.8 4.8,13.4 5.9,13.4 C7.3,13.4 8.3,12.2 8.3,10.5 C8.3,8.8 7.3,7.7 5.9,7.7 C5,7.7 4.3,8.1 3.8,8.9 L1.4,8.4 Z",
    '6' to "M6.2,0 C8.2,0 9.8,0.9 10.6,2.6 L8.2,3.8 C7.8,3 7.1,2.5 6.2,2.5 C4.6,2.5 3.6,4 3.6,6.6 L3.6,7.2 C4.3,6.2 5.4,5.6 6.7,5.6 C9.2,5.6 11,7.7 11,10.6 C11,13.7 8.9,16 6,16 C2.9,16 1,13.5 1,9 C1,3.4 3,0 6.2,0 Z M6,7.9 C4.6,7.9 3.6,9 3.6,10.7 C3.6,12.4 4.6,13.6 6,13.6 C7.4,13.6 8.4,12.4 8.4,10.7 C8.4,9 7.4,7.9 6,7.9 Z",
    '7' to "M1.2,0 L10.8,0 L10.8,2.2 L5.9,16 L3,16 L7.8,2.6 L1.2,2.6 Z",
    '8' to "M6,0 C8.7,0 10.6,1.6 10.6,4 C10.6,5.6 9.7,6.8 8.2,7.4 C10,8 11,9.3 11,11.2 C11,13.8 8.9,16 6,16 C3.1,16 1,13.8 1,11.2 C1,9.3 2,8 3.8,7.4 C2.3,6.8 1.4,5.6 1.4,4 C1.4,1.6 3.3,0 6,0 Z M6,2.3 C4.8,2.3 4,3.1 4,4.3 C4,5.5 4.8,6.3 6,6.3 C7.2,6.3 8,5.5 8,4.3 C8,3.1 7.2,2.3 6,2.3 Z M6,8.5 C4.6,8.5 3.6,9.4 3.6,10.8 C3.6,12.2 4.6,13.2 6,13.2 C7.4,13.2 8.4,12.2 8.4,10.8 C8.4,9.4 7.4,8.5 6,8.5 Z",
    '9' to "M5.8,16 C3.8,16 2.2,15.1 1.4,13.4 L3.8,12.2 C4.2,13 4.9,13.5 5.8,13.5 C7.4,13.5 8.4,12 8.4,9.4 L8.4,8.8 C7.7,9.8 6.6,10.4 5.3,10.4 C2.8,10.4 1,8.3 1,5.4 C1,2.3 3.1,0 6,0 C9.1,0 11,2.5 11,7 C11,12.6 9,16 5.8,16 Z M6,2.4 C4.6,2.4 3.6,3.6 3.6,5.3 C3.6,7 4.6,8.1 6,8.1 C7.4,8.1 8.4,7 8.4,5.3 C8.4,3.6 7.4,2.4 6,2.4 Z",
  )

  private const val CELL_W = 12f
  private const val CELL_H = 16f
  private const val SCALE = 0.62f // 16-tall cell -> ~10 units tall
  private const val GAP = 0.6f

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    style = Paint.Style.FILL
  }

  /**
   * Render the skip icon for `seconds` in `direction` (-1 back / +1 forward) to a
   * white-on-transparent bitmap sized `px` square, wrapped as an IconCompat ready
   * for CommandButton.setCustomIcon.
   */
  fun icon(direction: Int, seconds: Int, px: Int): IconCompat =
    IconCompat.createWithBitmap(bitmap(direction, seconds, px))

  private fun bitmap(direction: Int, seconds: Int, px: Int): Bitmap {
    val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val vpScale = px / 48f
    canvas.scale(vpScale, vpScale)

    // Ring.
    canvas.drawPath(PathParser.createPathFromPathData(if (direction < 0) RING_BACK else RING_FWD), fill)

    // Centered numeral. Digits with no glyph (shouldn't happen for 0-9) are skipped.
    val s = seconds.toString()
    val cellW = CELL_W * SCALE
    val totalW = s.length * cellW + (s.length - 1) * GAP
    val startX = 24f - totalW / 2f
    val topY = 24f - (CELL_H * SCALE) / 2f - 1.3f // arrowhead notch sits up top
    for (i in s.indices) {
      val g = DIGIT[s[i]] ?: continue
      val path = PathParser.createPathFromPathData(g)
      val m = Matrix()
      m.postScale(SCALE, SCALE)
      m.postTranslate(startX + i * (cellW + GAP), topY)
      path.transform(m)
      canvas.drawPath(path, fill)
    }
    return bmp
  }
}
