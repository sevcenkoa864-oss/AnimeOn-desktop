package cc.animeon.tv

import android.content.Context
import android.content.res.AssetManager
import android.net.Uri
import android.net.http.HttpResponseCache
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Everything the app answers itself instead of letting the page's network request through:
 * ad/tracker blocking, our CSS + fonts, and posters from hosts that are unreachable from some countries.
 * Mirrors what the desktop app does (src/main/adblock.ts, imageproxy.ts, main.ts).
 */
class SiteFilter(context: Context) {
    private val assets: AssetManager = context.assets
    private val prefs = context.getSharedPreferences("imageproxy", Context.MODE_PRIVATE)
    private val blockedImageHosts = HashSet(prefs.getStringSet(KEY_BLOCKED, emptySet()) ?: emptySet())

    init {
        // Responses we fetch ourselves (posters) bypass WebView's own HTTP cache, so give them one.
        runCatching { HttpResponseCache.install(File(context.cacheDir, "http"), 100L * 1024 * 1024) }
    }

    fun intercept(uri: Uri): WebResourceResponse? {
        val host = uri.host ?: return null
        if (host == SITE_HOST && uri.path?.startsWith(ASSET_PREFIX) == true) return asset(uri.path!!.removePrefix(ASSET_PREFIX))
        if (isBlocked(host, uri.path.orEmpty())) return empty()
        if (host in IMAGE_PROXY_HOSTS) return poster(uri.toString())
        return null
    }

    private fun isBlocked(host: String, path: String): Boolean {
        if (BLOCKED_HOSTS.any { host == it || host.endsWith(".$it") }) return true
        return host == "yandex.ru" && path.startsWith("/ads/") // Adfox
    }

    private fun empty() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun asset(name: String): WebResourceResponse? {
        if ('/' in name || name.contains("..")) return null
        val mime = when (name.substringAfterLast('.')) {
            "css" -> "text/css"
            "js" -> "text/javascript"
            "woff2" -> "font/woff2"
            else -> return null
        }
        return try {
            WebResourceResponse(mime, "utf-8", 200, "OK", mapOf("Cache-Control" to "max-age=86400"), assets.open(name))
        } catch (e: Exception) {
            null
        }
    }

    /** Direct first (with a short timeout); once a host has failed, always via the wsrv.nl image proxy. */
    private fun poster(url: String): WebResourceResponse? {
        val host = Uri.parse(url).host ?: return null
        if (host !in blockedImageHosts) {
            open(url, DIRECT_TIMEOUT_MS)?.let { return it }
            blockedImageHosts.add(host)
            prefs.edit().putStringSet(KEY_BLOCKED, blockedImageHosts).apply()
        }
        return open("https://wsrv.nl/?url=" + URLEncoder.encode(url, "UTF-8"), PROXY_TIMEOUT_MS)
    }

    private fun open(url: String, timeoutMs: Int): WebResourceResponse? = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs * 2
        c.setRequestProperty("User-Agent", USER_AGENT)
        if (c.responseCode in 200..299) {
            val type = c.contentType?.substringBefore(';')?.trim().takeUnless { it.isNullOrEmpty() } ?: "image/jpeg"
            WebResourceResponse(type, null, c.responseCode, "OK", mapOf("Access-Control-Allow-Origin" to "*"), c.inputStream)
        } else {
            c.disconnect()
            null
        }
    } catch (e: Exception) {
        null
    }

    companion object {
        const val SITE_HOST = "animeon.cc"
        const val ASSET_PREFIX = "/__tv/"
        private const val KEY_BLOCKED = "blocked"
        private const val DIRECT_TIMEOUT_MS = 4000
        private const val PROXY_TIMEOUT_MS = 10000
        private const val USER_AGENT = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

        // Russian CDNs the site takes most posters from. Selectel is unstable and Kinopoisk is blocked in Ukraine.
        private val IMAGE_PROXY_HOSTS = setOf("ab18cf62-4b99-4613-a8c1-c801eda74545.selcdn.net", "st.kp.yandex.net")

        // Ad networks seen in the Kodik player's pre-roll requests, plus the trackers the site loads.
        private val BLOCKED_HOSTS = listOf(
            "buzzoola.com", "traffer.net", "moviead55.ru", "vidalak.com", "traffmovie.com", "oritooep.win",
            "franecki.net", "mc.yandex.ru", "mc.yandex.com", "googletagmanager.com", "google-analytics.com",
            "analytics.google.com", "doubleclick.net", "googlesyndication.com", "static.cloudflareinsights.com",
        )
    }
}
