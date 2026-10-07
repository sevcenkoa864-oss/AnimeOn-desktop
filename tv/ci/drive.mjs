// CI helper for the Android TV emulator test (debug build). Talks to the app's WebView over the DevTools port
// forwarded by emulator-test.sh (adb forward tcp:9222 ...), and presses the "remote" with adb.
//
//   node drive.mjs eval  "<js expression>"        evaluate in the page, print the JSON result
//   node drive.mjs nav   <url>                    navigate the page
//   node drive.mjs point "<js returning element>" [click]
//        move the pointer onto the element with D-pad key events, optionally press OK
//
// The pointer starts in the middle of the screen and one key press moves it exactly 9dp, so the script can track
// where it is (state in cursor.json) and walk it to any element, the same way a person would with the remote.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [cmd, arg, opt] = process.argv.slice(2);
const STATE = 'cursor.json';
const KEYS = { up: 19, down: 20, left: 21, right: 22, center: 23 };

const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8' }).trim();

async function page() {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const t = list.find((x) => x.type === 'page');
  if (!t) throw new Error('no page target: ' + JSON.stringify(list));
  return t;
}

async function cdp(method, params) {
  const ws = new WebSocket((await page()).webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  return new Promise((resolve) => {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) {
        ws.close();
        resolve(msg.result);
      }
    });
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
}

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', {
    expression: `(async () => (${expression}))()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

function press(key, times) {
  // `input keyevent` takes many key codes at once; chunk to keep the command line short.
  for (let left = times; left > 0; left -= 40)
    adb('shell', 'input', 'keyevent', ...Array(Math.min(left, 40)).fill(String(key)));
}

if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(arg), null, 1));
} else if (cmd === 'nav') {
  await cdp('Page.navigate', { url: arg });
} else if (cmd === 'point') {
  const screen = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)\s*$/);
  const dens = Number(adb('shell', 'wm', 'density').match(/(\d+)\s*$/)[1]);
  const [W, H] = [Number(screen[1]), Number(screen[2])];
  const step = (9 * dens) / 160;
  const here = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { x: W / 2, y: H / 2 };

  await evaluate(`(${arg}).scrollIntoView({ block: 'center' })`);
  await new Promise((r) => setTimeout(r, 1500));
  const r = await evaluate(`(() => { const b = (${arg}).getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, iw: innerWidth }; })()`);
  const scale = W / r.iw; // the page is laid out iw CSS px wide across the whole screen
  const want = { x: r.x * scale, y: r.y * scale };
  const dx = Math.round((want.x - here.x) / step);
  const dy = Math.round((want.y - here.y) / step);
  console.log(
    `screen ${W}x${H} dpi ${dens} step ${step.toFixed(1)}px; ${JSON.stringify(here)} -> ${JSON.stringify(want)}: ${dx},${dy} presses`,
  );
  if (dx) press(dx > 0 ? KEYS.right : KEYS.left, Math.abs(dx));
  if (dy) press(dy > 0 ? KEYS.down : KEYS.up, Math.abs(dy));
  writeFileSync(STATE, JSON.stringify({ x: here.x + dx * step, y: here.y + dy * step }));
  if (opt === 'click') press(KEYS.center, 1);
} else {
  throw new Error('unknown command ' + cmd);
}
