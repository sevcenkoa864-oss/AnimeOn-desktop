package cc.animeon.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.Toast

/**
 * AnimeOn Desktop (Unofficial) for Android TV: the animeon.cc website in a full-screen WebView, driven with the
 * remote. There is no pointer: the D-pad moves real focus between the page's links and buttons (assets/tv-nav.js),
 * OK activates, Back closes things and then goes back, the media keys and OK/arrows on the player control the video.
 */
class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var splash: View
    private lateinit var filter: SiteFilter
    private val ui = Handler(Looper.getMainLooper())

    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var offlineFor: String? = null // the URL that failed while the offline page is shown
    private var lastBackMs = 0L
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val navJs: String by lazy { assets.open("tv-nav.js").bufferedReader().use { it.readText() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        filter = SiteFilter(this)

        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        web = createWebView()
        root.addView(web, match())
        splash = buildSplash()
        root.addView(splash, match())
        setContentView(root)
        web.requestFocus()

        watchNetwork()
        web.loadUrl(HOME)
        ui.postDelayed({ Updater(this).checkSoon() }, UPDATE_CHECK_DELAY_MS) // after the page is up, not while it loads
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(this)
        view.setBackgroundColor(BG)
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // autoplay
            useWideViewPort = true
            loadWithOverviewMode = false // keep the TV's natural scale: big, readable from the couch
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            setSupportMultipleWindows(true) // so onCreateWindow can refuse pop-ups
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = desktopUserAgent(userAgentString)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true) // the video players' cookies
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        return view
    }

    /** Desktop Chrome on Linux, built from this WebView's own Chrome version: the full desktop layout, no "wv". */
    private fun desktopUserAgent(default: String): String {
        val chrome = Regex("Chrome/([\\d.]+)").find(default)?.groupValues?.get(1) ?: "130.0.0.0"
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$chrome Safari/537.36"
    }

    private fun buildSplash(): View {
        val frame = FrameLayout(this)
        frame.setBackgroundColor(BG)
        val logo = ImageView(this)
        logo.setImageResource(R.mipmap.ic_launcher)
        val size = (96 * resources.displayMetrics.density).toInt()
        frame.addView(logo, FrameLayout.LayoutParams(size, size, android.view.Gravity.CENTER))
        logo.animate().alpha(0.55f).setDuration(900).withEndAction(object : Runnable {
            override fun run() { // gentle pulse while the page loads
                if (splash.visibility != View.VISIBLE) return
                logo.animate().alpha(if (logo.alpha < 0.8f) 1f else 0.55f).setDuration(900).withEndAction(this).start()
            }
        }).start()
        return frame
    }

    private fun hideSplash() {
        if (splash.visibility != View.VISIBLE) return
        splash.animate().alpha(0f).setDuration(250).withEndAction { splash.visibility = View.GONE }.start()
    }

    // ---------- page ----------

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val r = request ?: return false
            return r.isForMainFrame && !isSite(r.url) // anything outside animeon.cc is refused
        }

        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
            request?.url?.let { filter.intercept(it) }

        override fun onPageCommitVisible(view: WebView?, url: String?) {
            if (url != OFFLINE_URL) offlineFor = null
            inject()
            hideSplash()
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            inject()
            hideSplash()
        }

        /** Single-page navigations: make sure our CSS is still there. */
        override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) = inject()

        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            if (request?.isForMainFrame == true) showOffline(request.url.toString())
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            ui.post { recreate() } // the page's renderer crashed or was killed: start over
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView?, newProgress: Int) {
            if (newProgress >= 70) hideSplash()
        }

        override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
            if (view == null || fullscreenView != null) {
                callback?.onCustomViewHidden()
                return
            }
            fullscreenView = view
            fullscreenCallback = callback
            view.setBackgroundColor(Color.BLACK)
            root.addView(view, match())
        }

        override fun onHideCustomView() = leaveFullscreen()

        override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean =
            false // no pop-ups, no pop-unders

        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)

        override fun onConsoleMessage(m: ConsoleMessage?): Boolean {
            m?.message()?.takeIf { it.startsWith("[tv]") }?.let {
                Log.i(TAG, it)
                if (it.startsWith("[tv] playing=")) keepScreenOn(it.endsWith("=1"))
            }
            return true
        }
    }

    /** The TV may go to sleep on a menu page; only a playing video keeps the screen on. */
    private fun keepScreenOn(on: Boolean) {
        runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun isSite(uri: Uri): Boolean =
        uri.scheme == "https" && (uri.host == SiteFilter.SITE_HOST || uri.host?.endsWith(".${SiteFilter.SITE_HOST}") == true)

    private fun inject() {
        web.evaluateJavascript(PAGE_JS, null)
        web.evaluateJavascript("!!window.__tvnav") { has -> if (has != "true") web.evaluateJavascript(navJs, null) }
    }

    private fun showOffline(failedUrl: String) {
        offlineFor = failedUrl
        web.loadDataWithBaseURL(OFFLINE_URL, OFFLINE_HTML, "text/html", "utf-8", null)
        hideSplash()
    }

    /** Reloads by itself as soon as the network is back. */
    private fun watchNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                ui.post { offlineFor?.let { web.loadUrl(it) } }
            }
        }
        networkCallback = callback
        runCatching { cm.registerDefaultNetworkCallback(callback) }
    }

    private fun leaveFullscreen() {
        val view = fullscreenView ?: return
        fullscreenView = null
        root.removeView(view)
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
    }

    // ---------- remote control ----------

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val down = e.action == KeyEvent.ACTION_DOWN
        val first = down && e.repeatCount == 0
        when (e.keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                if (e.action == KeyEvent.ACTION_UP) goBack()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { if (first) player("toggle"); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { if (first) player("play"); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { if (first) player("pause"); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_NEXT -> { if (down) player("seek", SEEK_SECONDS); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_PREVIOUS -> { if (down) player("seek", -SEEK_SECONDS); return true }
            KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_CHANNEL_UP -> { if (down) scrollPage(-1); return true }
            KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> { if (down) scrollPage(1); return true }
            KeyEvent.KEYCODE_MENU -> { if (first) menu(); return true }
        }
        if (fullscreenView != null) { // the page can't see keys while the video is fullscreen: drive it from here
            when (e.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { if (first) player("toggle"); return true }
                KeyEvent.KEYCODE_DPAD_LEFT -> { if (down) player("seek", -SEEK_SECONDS); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { if (down) player("seek", SEEK_SECONDS); return true }
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> return true
            }
        }
        return super.dispatchKeyEvent(e) // arrows, OK and typing go to the page, where tv-nav.js moves the focus
    }

    /** Fullscreen video first, then whatever the page wants to close or step out of, then page history. */
    private fun goBack() {
        if (fullscreenView != null) return leaveFullscreen()
        web.evaluateJavascript("window.__tvnav ? window.__tvnav.back() : 'history'") { result ->
            if (result?.contains("handled") != true) goBackInHistory()
        }
    }

    private fun goBackInHistory() {
        when {
            web.canGoBack() -> web.goBack()
            SystemClock.uptimeMillis() - lastBackMs < 2000 -> finish()
            else -> {
                lastBackMs = SystemClock.uptimeMillis()
                Toast.makeText(this, "Press Back again to exit", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /** Menu: fullscreen for the focused player, leave it when already there, otherwise reload the page. */
    private fun menu() {
        if (fullscreenView != null) return leaveFullscreen()
        web.evaluateJavascript("window.__tvnav ? window.__tvnav.menu() : false") { handled ->
            if (handled != "true") web.reload()
        }
    }

    private fun scrollPage(dir: Int) {
        web.evaluateJavascript("scrollBy({top: ${dir * 400}, behavior: 'instant'})", null)
    }

    /** Play, pause or seek the video: a <video> in the page, or a Kodik iframe through its postMessage API. */
    private fun player(method: String, delta: Int = 0) {
        web.evaluateJavascript("window.__tv && window.__tv.cmd('$method', $delta)", null)
    }

    // ---------- lifecycle ----------

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
    }

    override fun onDestroy() {
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) } }
        web.destroy()
        super.onDestroy()
    }

    private fun match() = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

    private companion object {
        const val TAG = "AnimeOnTV"
        const val HOME = "https://animeon.cc/"
        const val OFFLINE_URL = "https://animeon.cc/__tv/offline"
        const val SEEK_SECONDS = 10
        const val UPDATE_CHECK_DELAY_MS = 20_000L
        val BG = Color.parseColor("#0A0A0A")

        /**
         * Runs on every page (idempotent): loads our CSS (Manrope, hidden blocks, hero fix) and tracks the Kodik
         * player's state for the media keys.
         */
        const val PAGE_JS = """(function () {
  var d = document;
  if (!d.getElementById('__tvcss')) {
    var l = d.createElement('link');
    l.id = '__tvcss';
    l.rel = 'stylesheet';
    l.href = 'https://animeon.cc/__tv/tv-site.css';
    (d.head || d.documentElement).appendChild(l);
  }
  if (window.__tv) return;
  var tv = window.__tv = { paused: true, t: 0, last: false };
  // tells the app whether something is playing, so it can keep the screen on only then
  function report() {
    var playing = !tv.paused;
    if (playing !== tv.last) { tv.last = playing; console.log('[tv] playing=' + (playing ? 1 : 0)); }
  }
  window.addEventListener('message', function (e) {
    var k = e.data && e.data.key;
    if (k === 'kodik_player_play') tv.paused = false;
    else if (k === 'kodik_player_pause') tv.paused = true;
    else if (k === 'kodik_player_time_update') tv.t = Number(e.data.value) || 0;
    report();
  });
  ['play', 'pause', 'ended'].forEach(function (ev) {
    d.addEventListener(ev, function (e) {
      if (e.target.tagName !== 'VIDEO' || (e.target.muted && e.target.loop)) return;
      tv.paused = ev !== 'play';
      report();
    }, true);
  });
  setInterval(function () { // left the player page without a pause event
    if (tv.last && !d.querySelector('iframe,video')) { tv.paused = true; report(); }
  }, 5000);
  tv.cmd = function (method, delta) {
    var want = method === 'toggle' ? (tv.paused ? 'play' : 'pause') : method;
    var v = d.querySelector('video');
    if (v) {
      if (want === 'seek') v.currentTime = Math.max(0, v.currentTime + delta);
      else if (want === 'play') v.play();
      else v.pause();
      return;
    }
    var msg = want === 'seek' ? { method: 'seek', seconds: Math.max(0, tv.t + delta) } : { method: want };
    d.querySelectorAll('iframe').forEach(function (f) {
      try { f.contentWindow.postMessage({ key: 'kodik_player_api', value: msg }, '*'); } catch (err) {}
    });
  };
  console.log('[tv] ready innerWidth=' + innerWidth + ' dpr=' + devicePixelRatio);
})();"""

        const val OFFLINE_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>No connection</title><style>
body{margin:0;background:#0a0a0a;color:#fafafa;font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}
h1{font-size:44px;margin:0 0 12px}p{color:#a1a1a1;font-size:24px;margin:8px 0}
a{display:inline-block;margin-top:28px;padding:18px 48px;background:#7c4dff;color:#fff;border-radius:14px;font-size:28px;font-weight:600;text-decoration:none}
</style></head><body><div><h1>No connection</h1><p>Couldn't reach animeon.cc. Check your internet connection.</p>
<p>It will reload by itself when the network is back.</p><a href="https://animeon.cc/">Retry</a></div></body></html>"""
    }
}
