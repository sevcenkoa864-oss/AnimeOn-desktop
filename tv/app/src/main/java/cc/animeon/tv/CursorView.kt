package cc.animeon.tv

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/** The on-screen mouse pointer moved with the remote's D-pad. Purely visual: it never takes focus or touches. */
class CursorView(context: Context) : View(context) {
    var cx = 0f
    var cy = 0f

    private val scale = resources.displayMetrics.density * 1.25f
    private val arrow = Path().apply {
        moveTo(0f, 0f)
        lineTo(0f, 22f)
        lineTo(5.5f, 17f)
        lineTo(9.5f, 26f)
        lineTo(13.5f, 24.3f)
        lineTo(9.5f, 15.5f)
        lineTo(16.5f, 15.5f)
        close()
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        style = Paint.Style.STROKE
        strokeWidth = 1.6f
        strokeJoin = Paint.Join.ROUND
    }

    init {
        isFocusable = false
        isClickable = false
        alpha = 0f
    }

    /** Moves the pointer, makes it visible and fades it out again after a few idle seconds. */
    fun moveTo(x: Float, y: Float) {
        cx = x
        cy = y
        invalidate()
        wake()
    }

    fun wake() {
        animate().cancel()
        alpha = 1f
        removeCallbacks(fadeOut)
        postDelayed(fadeOut, IDLE_MS)
    }

    private val fadeOut = Runnable { animate().alpha(0f).setDuration(400).start() }

    override fun onDraw(canvas: Canvas) {
        canvas.save()
        canvas.translate(cx, cy)
        canvas.scale(scale, scale)
        canvas.drawPath(arrow, fill)
        canvas.drawPath(arrow, stroke)
        canvas.restore()
    }

    private companion object {
        const val IDLE_MS = 4000L
    }
}
