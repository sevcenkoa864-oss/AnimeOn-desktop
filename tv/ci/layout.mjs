// Layout check for the TV app, runs on a PC (no emulator needed): loads the real site in headless Chrome/Edge at the
// viewports Android TV really gives a WebView, injects the app's own tv-site.css and measures what fits.
//
//   node tv/ci/layout.mjs [outDir]       screenshots + report.json go to outDir (default tv-shots/layout)
//   CHROME=<path to chrome/msedge>       override browser auto-detection
//
// Google's TV guidance is to design for 960x540 dp: a 1080p TV is 320 dpi, 720p is 213 dpi and 4K is 640 dpi, and all
// three give a WebView a 960x540 CSS px viewport. Overscan-safe margins are 5%: 48 px left/right, 27 px top/bottom.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2] ?? join(root, 'tv-shots', 'layout');
mkdirSync(out, { recursive: true });

const VIEW = { w: 960, h: 540 };
const SAFE = { x: 48, y: 27 };
const MIN_TEXT_PX = 12; // Material / Android TV minimum for any text
const PROFILES = [
  { name: '1080p-320dpi', dsf: 2 },
  { name: '720p-213dpi', dsf: 4 / 3 },
  { name: '4k-640dpi', dsf: 4 },
];
const PAGES = [
  ['home', '/'],
  ['catalog', '/catalog'],
  ['title', '/anime/monolog-farmacevta-3-61987'],
  ['news', '/news'],
  ['premium', '/premium'],
];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function findBrowser() {
  const c = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ];
  const found = c.find((p) => p && existsSync(p));
  if (!found) throw new Error('no Chrome/Edge found, set CHROME');
  return found;
}

/** tv-site.css the way the app serves it: fonts inlined (the app serves them under /__tv/). */
function appCss() {
  const fontsDir = join(root, 'src', 'renderer', 'fonts');
  let fonts = readFileSync(join(fontsDir, 'manrope.css'), 'utf8').replace(/url\((manrope[^)]+\.woff2)\)/g, (_, f) => {
    return `url(data:font/woff2;base64,${readFileSync(join(fontsDir, f)).toString('base64')})`;
  });
  const css = readFileSync(join(root, 'tv', 'app', 'src', 'main', 'assets', 'tv-site.css'), 'utf8').replace(
    /@import url\([^)]*\);/,
    '',
  );
  return fonts + css;
}

/** The offline page string from MainActivity.kt, so it is tested too. */
function offlineHtml() {
  const kt = readFileSync(
    join(root, 'tv', 'app', 'src', 'main', 'java', 'cc', 'animeon', 'tv', 'MainActivity.kt'),
    'utf8',
  );
  return /OFFLINE_HTML = """([\s\S]*?)"""/.exec(kt)[1];
}

// ---------- DevTools plumbing ----------

async function launch() {
  const port = 9340 + Math.floor(Math.random() * 100);
  const profile = mkdtempSync(join(tmpdir(), 'tv-layout-'));
  const child = spawn(
    findBrowser(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-sandbox',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return { child, ws: page.webSocketDebuggerUrl };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('browser did not start');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      waiters.filter((w) => w.method === msg.method).forEach((w) => w.resolve());
    }
  });
  const opened = new Promise((r) => ws.addEventListener('open', r));
  return {
    opened,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    once: (method) => new Promise((resolve) => waiters.push({ method, resolve })),
    close: () => ws.close(),
  };
}

// ---------- measurements, evaluated in the page ----------

const MEASURE = `(${function measure(view, safe, minText) {
  const vw = innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  /** True when an ancestor clips horizontally (a carousel, an overflow-hidden card) inside the viewport. */
  const clippedX = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o !== 'visible' && p.getBoundingClientRect().right <= vw + 1) return true;
    }
    return false;
  };
  const desc = (el) =>
    el.tagName.toLowerCase() +
    (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '') +
    ' "' +
    (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) +
    '"';

  const overflowX = [];
  const smallText = [];
  const unsafe = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !clippedX(el)) overflowX.push(desc(el) + ' right=' + Math.round(r.right));
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && parseFloat(getComputedStyle(el).fontSize) < minText)
      smallText.push(desc(el) + ' ' + getComputedStyle(el).fontSize);
    const interactive = el.matches('a[href],button,input,[role=button]');
    if (interactive && r.top < view.h && r.bottom > 0 && el.textContent.trim()) {
      const inX = r.left >= safe.x - 1 && r.right <= vw - safe.x + 1;
      const inY = r.top >= safe.y - 1 && r.bottom <= view.h - safe.y + 1;
      if (!inX || !inY)
        unsafe.push(
          desc(el) + ` [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`,
        );
    }
  }
  const dedupe = (a) => [...new Set(a)];
  return {
    innerWidth: vw,
    innerHeight: innerHeight,
    dpr: devicePixelRatio,
    scrollWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    overflowX: dedupe(overflowX).slice(0, 12),
    smallText: dedupe(smallText).slice(0, 12),
    unsafe: dedupe(unsafe).slice(0, 12),
    unsafeCount: dedupe(unsafe).length,
    smallTextCount: dedupe(smallText).length,
    h1: (document.querySelector('h1') || {}).textContent?.slice(0, 40) ?? null,
    primary: (() => {
      const b = [...document.querySelectorAll('a,button')].find((e) => /^Смотреть$/.test(e.textContent.trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), inFirstScreen: r.bottom <= view.h };
    })(),
  };
}})(${JSON.stringify(VIEW)}, ${JSON.stringify(SAFE)}, ${MIN_TEXT_PX})`;

// ---------- run ----------

const css = appCss();
const { child, ws } = await launch();
const cdp = connect(ws);
await cdp.opened;
await cdp.send('Page.enable');
await cdp.send('Network.setUserAgentOverride', { userAgent: UA });

const results = [];
const failures = [];

async function shot(file, dsf) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(out, file), Buffer.from(data, 'base64'));
}

for (const profile of PROFILES) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.w,
    height: VIEW.h,
    deviceScaleFactor: profile.dsf,
    mobile: false,
  });
  const targets = [
    ...PAGES.map(([name, path]) => ({ name, url: 'https://animeon.cc' + path })),
    { name: 'offline', html: offlineHtml() },
  ];
  for (const t of targets) {
    const loaded = cdp.once('Page.loadEventFired');
    if (t.html) await cdp.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(t.html) });
    else await cdp.send('Page.navigate', { url: t.url });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 30000))]);
    if (!t.html) {
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { const s = document.createElement('style'); s.id='__tvcss'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`,
      });
    }
    await new Promise((r) => setTimeout(r, t.html ? 300 : 5000)); // hydration + lazy images
    const { result } = await cdp.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const m = result.value;
    const tag = `${profile.name}/${t.name}`;
    results.push({ tag, ...m });
    if (profile.name === '1080p-320dpi') await shot(`${t.name}.png`, profile.dsf);

    if (m.innerWidth !== VIEW.w) failures.push(`${tag}: viewport is ${m.innerWidth} px wide, expected ${VIEW.w}`);
    if (m.scrollWidth > m.innerWidth)
      failures.push(`${tag}: horizontal scroll (scrollWidth ${m.scrollWidth} > ${m.innerWidth})`);
    if (m.overflowX.length)
      failures.push(
        `${tag}: ${m.overflowX.length} element(s) stick out of the screen: ${m.overflowX.slice(0, 3).join(' | ')}`,
      );
    if (t.name === 'title' && m.primary && !m.primary.inFirstScreen)
      failures.push(`${tag}: "Смотреть" is below the first screen (bottom ${m.primary.bottom})`);
  }
}

cdp.close();
child.kill();
writeFileSync(join(out, 'report.json'), JSON.stringify(results, null, 2));

console.log(`viewport ${VIEW.w}x${VIEW.h} css px, safe area ${SAFE.x}/${SAFE.y}, min text ${MIN_TEXT_PX}px\n`);
for (const r of results) {
  console.log(
    `${r.tag.padEnd(24)} w=${r.innerWidth} scrollW=${r.scrollWidth} h=${r.pageHeight} ` +
      `outside=${r.overflowX.length} smallText=${r.smallTextCount} outsideSafeArea=${r.unsafeCount}` +
      (r.primary ? ` watchBtn.bottom=${r.primary.bottom}` : ''),
  );
}
const r1080 = results.filter((r) => r.tag.startsWith('1080p'));
for (const r of r1080) {
  for (const k of ['overflowX', 'smallText', 'unsafe']) {
    if (r[k].length) console.log(`\n${r.tag} ${k}:\n  ` + r[k].join('\n  '));
  }
}
console.log(failures.length ? `\nFAIL\n${failures.map((f) => '- ' + f).join('\n')}` : '\nPASS');
process.exit(failures.length ? 1 : 0);
