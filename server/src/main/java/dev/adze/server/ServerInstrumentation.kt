package dev.adze.server

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Bitmap
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * The on-device half of adze. Started detached from the host's adb session:
 *
 *   adb shell "nohup am instrument -w -e port 7912 \
 *     dev.adze.server/.ServerInstrumentation >/dev/null 2>&1 &"
 *
 * and reached through `adb forward`. Each connection speaks JSON lines: one
 * request object per line, one response object per line, after an initial
 * `{"ready":true,...}`. All coordinates on the wire are in dp.
 *
 * The server keeps to primitives (dump, touch, key, text, screenshot). Element
 * resolution, waiting and output formatting live in the host CLI,
 * where they can be tested without a device.
 */
class ServerInstrumentation : Instrumentation() {
    private lateinit var automation: UiAutomation
    private val lock = Any()
    private var port = DEFAULT_PORT
    private var density = 1f

    /** Down time of a touch started by `touch-down` and not yet lifted. */
    private var openTouchDownAt: Long? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        port = arguments?.getString("port")?.toIntOrNull() ?: port
        start()
    }

    override fun onStart() {
        super.onStart()
        automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        configureAutomation()
        density = context.resources.displayMetrics.density
        ServerSocket(port, 8, InetAddress.getLoopbackAddress()).use { server ->
            Log.i(TAG, "adze server ${BuildConfig.VERSION_NAME} listening on $port")
            while (true) {
                val socket = server.accept()
                thread(name = "adze-connection") {
                    // An exception escaping any thread kills the whole app
                    // process, and with it every other client's connection.
                    // A client that hangs up mid-request is routine (a
                    // timeout, Ctrl-C), so it ends only its own connection.
                    try {
                        socket.use(::serve)
                    } catch (error: Throwable) {
                        Log.i(TAG, "connection ended: ${error.message}")
                    }
                }
            }
        }
    }

    private fun serve(socket: Socket) {
        // Nagle off and one write per response: otherwise every response
        // larger than a segment waits ~40ms on the host's delayed ACK.
        socket.tcpNoDelay = true
        val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
        val out = socket.getOutputStream()
        val send = { response: JSONObject ->
            out.write((response.toString() + "\n").toByteArray(Charsets.UTF_8))
            out.flush()
        }
        send(JSONObject().put("ready", true).put("version", BuildConfig.VERSION_NAME))
        while (true) {
            val line = reader.readLine() ?: return
            val response = try {
                val request = JSONObject(line)
                synchronized(lock) { handle(request) }
            } catch (error: Throwable) {
                Log.w(TAG, "request failed: $line", error)
                JSONObject().put("ok", false).put("error", error.message ?: error.toString())
            }
            send(response)
        }
    }

    private fun handle(request: JSONObject): JSONObject = when (val command = request.getString("cmd")) {
        "ping" -> ok()
        "info" -> info()
        "dump" -> dump()
        "tap" -> {
            tap(px(request.getDouble("x")), px(request.getDouble("y")), request.optLong("holdMs", 0))
            ok()
        }
        "touch-down" -> {
            touchDown(px(request.getDouble("x")), px(request.getDouble("y")))
            ok()
        }
        "touch-up" -> {
            touchUp(px(request.getDouble("x")), px(request.getDouble("y")))
            ok()
        }
        "swipe" -> {
            swipe(
                px(request.getDouble("startX")), px(request.getDouble("startY")),
                px(request.getDouble("endX")), px(request.getDouble("endY")),
                request.getLong("durationMs"), px(request.getDouble("stepDp")),
            )
            ok()
        }
        "key" -> {
            key(request.getInt("keycode"), request.optInt("metaState", 0), request.optLong("holdMs", 0))
            ok()
        }
        "text" -> {
            insertText(request.getString("text"))
            ok()
        }
        "screenshot" -> screenshot()
        else -> throw IllegalArgumentException("unknown command $command")
    }

    // ── Reading the screen ───────────────────────────────────────────────

    private fun info(): JSONObject = withScreenSize(
        ok()
            .put("version", BuildConfig.VERSION_NAME)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("density", density.toDouble()),
    )

    /** Every dump carries the current screen size: rotation changes it. */
    private fun dump(): JSONObject {
        val windows = JSONArray()
        for (window in automation.windows) {
            val root = window.root ?: continue
            windows.put(windowJson(window).put("root", nodeJson(root)))
        }
        return withScreenSize(ok().put("windows", windows))
    }

    @Suppress("DEPRECATION") // getRealMetrics: the full display, bars included, current rotation.
    private fun withScreenSize(json: JSONObject): JSONObject {
        val metrics = DisplayMetrics()
        context.getSystemService(DisplayManager::class.java)
            .getDisplay(Display.DEFAULT_DISPLAY)
            .getRealMetrics(metrics)
        return json
            .put("widthDp", metrics.widthPixels / density.toDouble())
            .put("heightDp", metrics.heightPixels / density.toDouble())
    }

    private fun windowJson(window: AccessibilityWindowInfo): JSONObject {
        val bounds = Rect().also(window::getBoundsInScreen)
        val json = JSONObject()
            .put("id", window.id)
            .put("type", windowType(window.type))
            .put("layer", window.layer)
            .put("active", window.isActive)
            .put("focused", window.isFocused)
            .put("frame", frameJson(bounds))
        window.title?.let { json.put("title", it.toString()) }
        return json
    }

    private fun nodeJson(node: AccessibilityNodeInfo): JSONObject {
        val json = JSONObject()
            .put("class", node.className?.toString())
            .put("package", node.packageName?.toString())
            .put("frame", frameJson(Rect().also(node::getBoundsInScreen)))
            .put("visible", node.isVisibleToUser)
            .put("enabled", node.isEnabled)
        node.viewIdResourceName?.let { json.put("resourceId", it) }
        node.text?.let { json.put("text", it.toString()) }
        node.contentDescription?.let { json.put("contentDescription", it.toString()) }
        node.hintText?.let { json.put("hint", it.toString()) }
        if (Build.VERSION.SDK_INT >= 30) node.stateDescription?.let { json.put("stateDescription", it.toString()) }
        node.extras?.getCharSequence(ROLE_DESCRIPTION_EXTRA)?.let { json.put("roleDescription", it.toString()) }
        if (node.isShowingHintText) json.put("showingHint", true)
        if (node.isClickable) json.put("clickable", true)
        if (node.isLongClickable) json.put("longClickable", true)
        if (node.isCheckable) json.put("checkable", true).put("checked", node.isChecked)
        if (node.isSelected) json.put("selected", true)
        if (node.isFocused) json.put("focused", true)
        if (node.isEditable) json.put("editable", true)
        if (node.isPassword) json.put("password", true)
        if (node.isScrollable) json.put("scrollable", true)
        val children = JSONArray()
        for (index in 0 until node.childCount) {
            node.getChild(index)?.let { children.put(nodeJson(it)) }
        }
        if (children.length() > 0) json.put("children", children)
        return json
    }

    private fun frameJson(bounds: Rect) = JSONObject()
        .put("x", dp(bounds.left))
        .put("y", dp(bounds.top))
        .put("width", dp(bounds.width()))
        .put("height", dp(bounds.height()))

    private fun screenshot(): JSONObject {
        val bitmap = automation.takeScreenshot() ?: error("The system returned no screenshot.")
        val png = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, png)
        bitmap.recycle()
        return ok().put("png", Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP))
    }

    // ── Driving the screen ───────────────────────────────────────────────

    private fun tap(x: Float, y: Float, holdMs: Long) {
        checkNoTouchDown()
        gesture(x, y) { downAt ->
            if (holdMs > 0) SystemClock.sleep(holdMs)
            inject(motion(downAt, MotionEvent.ACTION_UP, x, y))
        }
    }

    private fun touchDown(x: Float, y: Float) {
        checkNoTouchDown()
        val downAt = SystemClock.uptimeMillis()
        inject(motion(downAt, MotionEvent.ACTION_DOWN, x, y))
        openTouchDownAt = downAt
    }

    /** Ends the open touch whatever happens: a rejected UP must not leave it stuck open. */
    private fun touchUp(x: Float, y: Float) {
        val downAt = openTouchDownAt ?: error("No touch is down; send touch-down first.")
        openTouchDownAt = null
        try {
            inject(motion(downAt, MotionEvent.ACTION_UP, x, y))
        } catch (error: Throwable) {
            cancelQuietly(downAt, x, y)
            throw error
        }
    }

    private fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long, stepPx: Float) {
        checkNoTouchDown()
        val distance = hypot(endX - startX, endY - startY)
        val steps = max(2, ceil(distance / max(stepPx, 1f)).toInt())
        gesture(startX, startY) { downAt ->
            for (step in 1..steps) {
                val fraction = step.toFloat() / steps
                SystemClock.sleep(durationMs / steps)
                inject(
                    motion(downAt, MotionEvent.ACTION_MOVE, startX + (endX - startX) * fraction, startY + (endY - startY) * fraction),
                    sync = false,
                )
            }
            inject(motion(downAt, MotionEvent.ACTION_UP, endX, endY))
        }
    }

    /**
     * Puts a finger down and runs the rest of the gesture. If any later event
     * fails, the gesture is cancelled, so no pointer is left down for the
     * next one to collide with.
     */
    private fun gesture(x: Float, y: Float, rest: (downAt: Long) -> Unit) {
        val downAt = SystemClock.uptimeMillis()
        inject(motion(downAt, MotionEvent.ACTION_DOWN, x, y))
        try {
            rest(downAt)
        } catch (error: Throwable) {
            cancelQuietly(downAt, x, y)
            throw error
        }
    }

    private fun cancelQuietly(downAt: Long, x: Float, y: Float) {
        runCatching { inject(motion(downAt, MotionEvent.ACTION_CANCEL, x, y)) }
    }

    private fun checkNoTouchDown() =
        check(openTouchDownAt == null) { "A touch is down from 'touch --down'; send 'touch --up' first." }

    private fun key(keycode: Int, metaState: Int, holdMs: Long) {
        val downAt = SystemClock.uptimeMillis()
        injectKey(KeyEvent(downAt, downAt, KeyEvent.ACTION_DOWN, keycode, 0, metaState))
        if (holdMs > 0) SystemClock.sleep(holdMs)
        injectKey(KeyEvent(downAt, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keycode, 0, metaState))
    }

    /**
     * Inserts text at the cursor of the focused text field, like typing does,
     * through the accessibility API rather than key events, so any Unicode —
     * curly quotes, emoji — arrives intact. Text replaces the current
     * selection, if there is one.
     */
    private fun insertText(text: String) {
        val node = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: error("No text field has focus. Tap a text field before typing.")
        check(node.isEditable) { "The focused element is not editable." }
        // A password field's text reads back masked, and an empty field's
        // reads back as its hint, so neither can be edited in place.
        val current = if (node.isShowingHintText || node.isPassword) "" else node.text?.toString().orEmpty()
        var start = min(node.textSelectionStart, node.textSelectionEnd)
        var end = max(node.textSelectionStart, node.textSelectionEnd)
        if (start < 0 || end > current.length) {
            start = current.length
            end = current.length
        }
        val next = current.substring(0, start) + text + current.substring(end)
        val setText = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
        }
        check(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setText)) { "The text field rejected the text." }
        val cursor = start + text.length
        val select = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        }
        node.refresh()
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, select)
    }

    private fun motion(downAt: Long, action: Int, x: Float, y: Float): MotionEvent =
        MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action, x, y, 0).apply {
            source = InputDevice.SOURCE_TOUCHSCREEN
        }

    private fun inject(event: MotionEvent, sync: Boolean = true) {
        try {
            check(automation.injectInputEvent(event, sync)) { "The system rejected the touch event." }
        } finally {
            event.recycle()
        }
    }

    private fun injectKey(event: KeyEvent) {
        check(automation.injectInputEvent(event, true)) { "The system rejected the key event." }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * UiAutomation's defaults suit neither half of the job: they omit the
     * window list (so dialogs, the keyboard and system sheets can't be
     * read) and include views that aren't important for accessibility,
     * which triples a React Native tree and makes every read ~20× slower
     * without adding a single label or ID. View IDs carry testIDs.
     */
    private fun configureAutomation() {
        val info = automation.serviceInfo
        info.flags = (info.flags
            or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS) and
            AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS.inv()
        automation.serviceInfo = info
    }

    private fun ok() = JSONObject().put("ok", true)

    private fun px(dp: Double) = (dp * density).toFloat()

    private fun dp(px: Int) = Math.round(px / density * 100) / 100.0

    private fun windowType(type: Int) = when (type) {
        AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "input-method"
        AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "accessibility-overlay"
        AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "split-screen-divider"
        AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY -> "magnification-overlay"
        else -> "unknown"
    }

    private companion object {
        const val TAG = "adze"
        const val DEFAULT_PORT = 7912
        const val ROLE_DESCRIPTION_EXTRA = "AccessibilityNodeInfo.roleDescription"
    }
}
