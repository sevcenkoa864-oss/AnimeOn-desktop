#!/usr/bin/env bash
# Runs inside the Android emulator job (see .github/workflows/tv-test.yml): installs the debug build, "uses the
# remote" through adb and saves screenshots + a report to tv-shots/. Nothing here fails the job on its own: the
# report is what gets read.
set -u
cd "$(dirname "$0")/../.."
OUT=tv-shots
mkdir -p "$OUT"
PKG=cc.animeon.tv.unofficial
D="node tv/ci/drive.mjs"
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
report() { echo "### $*" | tee -a "$OUT/report.txt"; }
alive() { echo "alive($1): pid=$(adb shell pidof "$PKG" | tr -d '') top=$(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | cut -c1-120)" | tee -a "$OUT/report.txt"; }
run() { echo "\$ $*" | tee -a "$OUT/report.txt"; "$@" 2>&1 | tee -a "$OUT/report.txt"; }

adb install -r tv/app/build/outputs/apk/debug/app-debug.apk
report "device"; run adb shell wm size; run adb shell wm density
run adb shell getprop ro.build.version.release
adb shell am start -n "$PKG/cc.animeon.tv.MainActivity"
sleep 35
shot 01-start

PID=$(adb shell pidof "$PKG" | tr -d '\r')
adb forward tcp:9222 "localabstract:webview_devtools_remote_$PID"
report "page after start"
run $D eval "({url: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, manrope: document.fonts.check('16px Manrope', 'Привет'), footers: [...document.querySelectorAll('footer')].map(f => f.offsetHeight), tgBanner: [...document.querySelectorAll('main section')].some(s => /Подписывайся на наш Telegram/.test(s.textContent) && s.offsetHeight > 0), posters: [...document.images].filter(i => i.getBoundingClientRect().width > 80).map(i => i.complete && i.naturalWidth > 0)})"

report "scroll: push the pointer down against the bottom edge"
run $D eval "scrollY"
run $D move down 75
sleep 2
run $D eval "scrollY"
shot 02b-scrolled

report "pointer: walk to the login button and press OK"
run $D point "[...document.querySelectorAll('button')].find(b => /Войти/.test(b.textContent))" click
sleep 3
shot 02-after-login-click
run $D eval "({dialog: !!document.querySelector('[role=dialog]'), text: (document.querySelector('[role=dialog]') || {}).innerText?.slice(0, 80)})"

report "anime page: open the player with the pointer"
run $D nav "https://animeon.cc/anime/ataka-titanov-16498"
sleep 12
run $D point "[...document.querySelectorAll('a,button')].find(e => /^Смотреть$/.test(e.textContent.trim()))" click
sleep 4
alive "after clicking Смотреть"
run $D point "document.querySelector('div.aspect-video div.cursor-pointer')" click
sleep 20
alive "after clicking play"
shot 03-player
run $D eval "({iframes: [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 70)), video: [...document.querySelectorAll('video')].length})"

report "media key: play/pause"
alive "before media key"
adb shell input keyevent 85
sleep 3
shot 04-after-playpause

report "fullscreen from the player, then Back"
run $D eval "(() => { const f = document.querySelector('iframe'); if (!f) return 'no iframe'; f.requestFullscreen().catch(() => {}); return 'requested'; })()"
sleep 4
shot 05-fullscreen
adb shell input keyevent 4
sleep 3
shot 06-after-back
run $D eval "({fullscreenElement: !!document.fullscreenElement, url: location.pathname})"

adb logcat -d > "$OUT/logcat-full.txt" 2>&1
adb logcat -d -s AnimeOnTV:I > "$OUT/logcat.txt" 2>&1
grep -E "FATAL|AndroidRuntime|has died|lowmemorykiller|am_kill|Fatal signal|ANR in|am_crash|am_proc_died|am_anr" "$OUT/logcat-full.txt" | cut -c1-300 | head -40 > "$OUT/problems.txt"
echo done
