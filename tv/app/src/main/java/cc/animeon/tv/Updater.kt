package cc.animeon.tv

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Self-update from this repository's GitHub Releases. On start (at most every few hours) it asks the API for the
 * latest release; when that is newer than the installed version it offers to download the `.apk` asset and hands it
 * to the system package installer. Android itself refuses the install unless the APK is signed with the same key as
 * the installed app, so a tampered download can't replace the app. The first time, the system asks to allow
 * "install unknown apps" for this app.
 */
class Updater(private val activity: Activity) {
    private val ui = Handler(Looper.getMainLooper())
    private val prefs = activity.getSharedPreferences("updater", Context.MODE_PRIVATE)

    /** Quiet check in the background; nothing is shown unless a newer version exists. */
    fun checkSoon() {
        if (System.currentTimeMillis() - prefs.getLong(KEY_LAST_CHECK, 0) < CHECK_EVERY_MS) return
        Thread {
            try {
                val release = latest() ?: return@Thread
                prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
                if (isNewer(release.version, installedVersion())) ui.post { offer(release) }
            } catch (e: Exception) {
                Log.i(TAG, "update check failed: $e") // offline, rate-limited...: try again next start
            }
        }.start()
    }

    private class Release(val version: String, val apkUrl: String, val size: Long)

    private fun installedVersion(): String =
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "0"

    private fun latest(): Release? {
        val c = URL(API).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000
        c.readTimeout = 15_000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        val json = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
        val assets = json.getJSONArray("assets")
        for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            val url = a.getString("browser_download_url")
            if (a.getString("name").endsWith(".apk") && url.startsWith(DOWNLOAD_PREFIX)) {
                return Release(json.getString("tag_name").removePrefix("v"), url, a.optLong("size", 0))
            }
        }
        return null
    }

    private fun offer(release: Release) {
        if (activity.isFinishing || activity.isDestroyed) return
        AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Update available")
            .setMessage("AnimeOn ${release.version} is available (you have ${installedVersion()}). Install it now?")
            .setPositiveButton("Install") { _, _ -> download(release) }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun download(release: Release) {
        val dialog = AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Updating")
            .setMessage("Downloading ${release.version}…")
            .setCancelable(false)
            .show()
        Thread {
            try {
                val file = File(activity.cacheDir, "update.apk")
                val c = URL(release.apkUrl).openConnection() as HttpURLConnection
                c.connectTimeout = 15_000
                c.readTimeout = 30_000
                val total = c.contentLengthLong.takeIf { it > 0 } ?: release.size
                var done = 0L
                var shown = -1
                c.inputStream.use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            val pct = if (total > 0) (done * 100 / total).toInt() else 0
                            if (pct != shown) {
                                shown = pct
                                ui.post { dialog.setMessage("Downloading ${release.version}… $pct%") }
                            }
                        }
                    }
                }
                ui.post {
                    dialog.setMessage("Installing…")
                    install(file, dialog)
                }
            } catch (e: Exception) {
                Log.i(TAG, "update download failed: $e")
                ui.post {
                    dialog.dismiss()
                    Toast.makeText(activity, "Update failed: check your connection", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    /** Streams the APK into a PackageInstaller session; the system then asks to confirm and replaces the app. */
    private fun install(file: File, dialog: AlertDialog) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(activity.packageName)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        @Suppress("DEPRECATION")
                        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { activity.startActivity(it) }
                    }
                    PackageInstaller.STATUS_SUCCESS -> Unit // the system restarts the app
                    else -> {
                        dialog.dismiss()
                        runCatching { activity.unregisterReceiver(this) }
                        val why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
                        Log.i(TAG, "update install failed: $why")
                        Toast.makeText(activity, "Update not installed: $why", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
        val filter = IntentFilter(ACTION)
        if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else activity.registerReceiver(receiver, filter)

        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("app.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            val pending = PendingIntent.getBroadcast(activity, id, Intent(ACTION).setPackage(activity.packageName), flags)
            session.commit(pending.intentSender)
        }
    }

    private companion object {
        const val TAG = "AnimeOnTV"
        const val ACTION = "cc.animeon.tv.UPDATE_STATUS"
        const val REPO = "sevcenkoa864-oss/AnimeOn-desktop"
        const val API = "https://api.github.com/repos/$REPO/releases/latest"
        const val DOWNLOAD_PREFIX = "https://github.com/$REPO/releases/download/"
        const val KEY_LAST_CHECK = "lastCheck"
        const val CHECK_EVERY_MS = 6 * 60 * 60 * 1000L

        /** Numeric comparison of dotted versions ("1.0.10" is newer than "1.0.9"). */
        fun isNewer(candidate: String, installed: String): Boolean {
            val a = candidate.split(".").map { it.toIntOrNull() ?: 0 }
            val b = installed.split(".").map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(a.size, b.size)) {
                val x = a.getOrElse(i) { 0 }
                val y = b.getOrElse(i) { 0 }
                if (x != y) return x > y
            }
            return false
        }
    }
}
