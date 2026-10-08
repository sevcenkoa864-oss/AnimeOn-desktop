/*
 * D-pad navigation for the TV app (MainActivity.kt injects this into every animeon.cc page; idempotent).
 * The remote's arrows and OK arrive as ordinary keydown events; this script moves real focus between the page's
 * links and buttons, jumping block to block, and treats the video player as one virtual-focus block (the Kodik
 * iframe is cross-origin: real focus must never enter it, or the keys would stop reaching us).
 * pickNext() is pure so it can be tested with node (tv/ci/nav.test.mjs).
 */
(function (root) {
  'use strict';

  var gap = function (a1, a2, b1, b2) {
    return Math.max(0, b1 - a2, a1 - b2);
  };

  /** Cross-axis penalty: the gap between the two intervals, plus how far apart their centres are. A wide item that
   *  overlaps the current one (a filter bar over a card grid) must not lose to a narrow one just for its centre. */
  function cross(a1, a2, b1, b2) {
    var g = gap(a1, a2, b1, b2);
    return g * 3 + Math.abs((b1 + b2) / 2 - (a1 + a2) / 2) * (g === 0 ? 0.1 : 0.5);
  }

  /** Distance from rect f to rect c in direction dir, or null when c is not that way. Rects: {l,t,r,b}. */
  function score(f, c, dir) {
    var fx = (f.l + f.r) / 2, fy = (f.t + f.b) / 2, cx = (c.l + c.r) / 2, cy = (c.t + c.b) / 2;
    if (dir === 'right') {
      if (cx <= fx + 1 || c.r <= f.r) return null;
      return Math.max(0, c.l - f.r) + cross(f.t, f.b, c.t, c.b);
    }
    if (dir === 'left') {
      if (cx >= fx - 1 || c.l >= f.l) return null;
      return Math.max(0, f.l - c.r) + cross(f.t, f.b, c.t, c.b);
    }
    if (dir === 'down') {
      if (cy <= fy + 1 || c.b <= f.b) return null;
      return Math.max(0, c.t - f.b) + cross(f.l, f.r, c.l, c.r);
    }
    if (cy >= fy - 1 || c.t >= f.t) return null;
    return Math.max(0, f.t - c.b) + cross(f.l, f.r, c.l, c.r);
  }

  /**
   * The next item to focus: the nearest one in the same group (row, header, dialog...). Only when the group has
   * nothing that way, another group: first one that is actually in line with the current item, and, for up/down
   * only, the nearest one off to the side (so Down from the far-right header button still goes somewhere).
   * Items: {l,t,r,b,g}.
   */
  function pickNext(cur, items, dir) {
    var vertical = dir === 'up' || dir === 'down';
    var best = null, inLine = null, any = null;
    var bs = Infinity, bl = Infinity, ba = Infinity, s, i, c, aligned;
    for (i = 0; i < items.length; i++) {
      c = items[i];
      if (c === cur) continue;
      s = score(cur, c, dir);
      if (s === null) continue;
      if (c.g === cur.g) {
        if (s < bs) { bs = s; best = c; }
        continue;
      }
      aligned = vertical ? gap(cur.l, cur.r, c.l, c.r) === 0 : gap(cur.t, cur.b, c.t, c.b) === 0;
      if (aligned && s < bl) { bl = s; inLine = c; }
      if (s < ba) { ba = s; any = c; }
    }
    return best || inLine || (vertical ? any : null);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { pickNext: pickNext, score: score };
  if (typeof document === 'undefined' || root.__tvnav) return;

  // ---------- DOM side ----------

  var d = document;
  var CANDIDATES = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[tabindex],div.aspect-video div.cursor-pointer';
  var GROUPS = '[role=dialog],[aria-modal=true],header,nav,aside,section,footer,main';
  var NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
  var player = null; // the virtually focused player element (iframe or video), or null
  var lastPlayerKey = 0;

  function isVisible(el, r) {
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.pointerEvents === 'none') return false;
    // hover-only controls (card buttons faded to opacity 0) must not take focus
    return typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true });
  }

  function topDialog() {
    var all = d.querySelectorAll('[role=dialog],[aria-modal=true]');
    for (var i = all.length - 1; i >= 0; i--) {
      if (isVisible(all[i], all[i].getBoundingClientRect())) return all[i];
    }
    return null;
  }

  function playerEls() {
    return Array.prototype.filter.call(d.querySelectorAll('iframe,video'), function (el) {
      var r = el.getBoundingClientRect();
      if (r.width <= 240 || r.height <= 120 || !isVisible(el, r)) return false;
      if (el.tagName === 'VIDEO') return !(el.muted && el.loop); // not the home page's background slider
      return /kodik|animeon|player/i.test(el.src || '');
    });
  }

  function collect() {
    var scope = topDialog() || d;
    var els = Array.prototype.filter.call(scope.querySelectorAll(CANDIDATES), function (el) {
      if (el.disabled || el.getAttribute('tabindex') === '-1' || el.getAttribute('aria-hidden') === 'true') return false;
      return isVisible(el, el.getBoundingClientRect());
    });
    // only the outermost candidate of a nest (a card link and the buttons inside it count once)
    var set = new Set(els);
    els = els.filter(function (el) {
      for (var p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
    els = els.concat(playerEls().filter(function (p) { return !scope.contains || scope === d || scope.contains(p); }));
    return els.map(function (el) {
      var r = el.getBoundingClientRect();
      return { el: el, l: r.left, t: r.top, r: r.right, b: r.bottom, g: el.closest(GROUPS) || d.body };
    });
  }

  function current(items) {
    var el = player || d.activeElement;
    if (!el || el === d.body) return null;
    for (var i = 0; i < items.length; i++) if (items[i].el === el || items[i].el.contains(el)) return items[i];
    var r = el.getBoundingClientRect();
    return { el: el, l: r.left, t: r.top, r: r.right, b: r.bottom, g: el.closest(GROUPS) || d.body };
  }

  function clearFocusMark() {
    var m = d.querySelectorAll('.tv-focus');
    for (var i = 0; i < m.length; i++) m[i].classList.remove('tv-focus', 'tv-wide');
  }

  function focusItem(item) {
    var el = item.el;
    clearFocusMark();
    var isPlayer = el.tagName === 'IFRAME' || el.tagName === 'VIDEO';
    if (isPlayer) {
      player = el;
      if (d.activeElement && d.activeElement !== d.body) d.activeElement.blur();
    } else {
      player = null;
      el.focus({ preventScroll: true });
    }
    el.classList.add('tv-focus');
    var r = el.getBoundingClientRect();
    if (r.width > innerWidth * 0.45) el.classList.add('tv-wide'); // too wide to scale without leaving the screen
    var needV = r.top < 90 || r.bottom > innerHeight - 30;
    var needH = r.left < 0 || r.right > innerWidth;
    if (needV || needH) el.scrollIntoView({ block: needV ? 'center' : 'nearest', inline: needH ? 'center' : 'nearest', behavior: 'instant' });
  }

  /** First sensible element on the screen: the main action, else the first thing below the header. */
  function firstItem(items) {
    var inView = firstInView(items);
    if (inView && (inView.el.tagName === 'IFRAME' || inView.el.tagName === 'VIDEO')) return inView;
    var watch = items.filter(function (i) { return /^Смотреть$/.test((i.el.textContent || '').trim()); })[0];
    if (watch) return watch;
    var main = items.filter(function (i) { return i.t >= 60 && i.b <= innerHeight && i.g.tagName !== 'HEADER'; });
    return main[0] || items[0] || null;
  }

  /** The first thing on the screen, preferring the player: used when the focus is lost or scrolled out of sight. */
  function firstInView(items) {
    var seen = items.filter(function (i) { return i.b > 70 && i.t < innerHeight && i.g.tagName !== 'HEADER'; });
    return seen.filter(function (i) { return i.el.tagName === 'IFRAME' || i.el.tagName === 'VIDEO' || /aspect-video/.test(i.el.parentElement && i.el.parentElement.className || ''); })[0] || seen[0] || null;
  }

  function move(dir) {
    var items = collect();
    var cur = current(items);
    var offScreen = cur && (cur.b < 0 || cur.t > innerHeight); // the page scrolled away from the focus by itself
    var next = !cur ? firstItem(items) : offScreen ? firstInView(items) : pickNext(cur, items, dir);
    if (next) focusItem(next);
    else if (dir === 'down' || dir === 'up') scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.6, behavior: 'instant' });
    return true;
  }

  function isTextField(el) {
    return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|password|url|tel|number)?$/.test(el.type)));
  }

  var KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  d.addEventListener('keydown', function (e) {
    var dir = KEYS[e.key];
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (player && !topDialog()) {
      if (e.key === 'Enter') { stop(e); root.__tv && root.__tv.cmd('toggle', 0); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { stop(e); root.__tv && root.__tv.cmd('seek', e.key === 'ArrowLeft' ? -10 : 10); return; }
    }
    if (dir) {
      var a = d.activeElement;
      if (isTextField(a) && (dir === 'left' || dir === 'right')) return; // caret movement
      stop(e);
      move(dir);
    } else if (e.key === 'Enter') {
      var el = d.activeElement;
      if (el && el !== d.body && !NATIVE.test(el.tagName) && !player) { stop(e); el.click(); }
    }
  }, true);

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------- Back and Menu (called from MainActivity) ----------

  function isListRoute() {
    return location.pathname.split('/').filter(Boolean).length <= 1;
  }

  /** Returns 'handled' when the page used the Back press, 'history' when the app should go back a page. */
  function back() {
    var dlg = topDialog();
    if (dlg) {
      var close = dlg.querySelector('[aria-label*="акрыть" i],[aria-label*="close" i],button[class*="close"]');
      if (close) close.click();
      else d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return 'handled';
    }
    var a = d.activeElement;
    if (isTextField(a)) { a.blur(); return 'handled'; }
    if (player) { clearFocusMark(); player = null; return 'handled'; }
    if (isListRoute() && a && a !== d.body && !a.closest('header')) {
      var nav = d.querySelector('header a[href]');
      if (nav) {
        scrollTo({ top: 0, behavior: 'instant' });
        var r = nav.getBoundingClientRect();
        focusItem({ el: nav, l: r.left, t: r.top, r: r.right, b: r.bottom });
        return 'handled';
      }
    }
    return 'history';
  }

  /** Menu key: fullscreen for the focused player; returns false when there is none (the app reloads then). */
  function menu() {
    if (!player || !player.requestFullscreen) return false;
    player.requestFullscreen().catch(function () {});
    return true;
  }

  // ---------- performance ----------

  /** Previews must never play by themselves: muted, looping videos (the home slider's background) are kept paused. */
  function isPreview(v) {
    return v.muted && v.loop;
  }
  d.addEventListener('play', function (e) {
    if (e.target.tagName === 'VIDEO' && isPreview(e.target)) e.target.pause();
  }, true);

  function calmVideos() {
    var v = d.querySelectorAll('video');
    for (var i = 0; i < v.length; i++) if (isPreview(v[i]) && !v[i].paused) v[i].pause();
  }

  /** Everything below the first screen loads lazily, and decodes off the main thread. */
  function lazyImages(scope) {
    var imgs = (scope || d).querySelectorAll('img:not([data-tvl])');
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      im.setAttribute('data-tvl', '1');
      im.decoding = 'async';
      if (!im.complete && im.getBoundingClientRect().top > innerHeight) im.loading = 'lazy';
    }
  }

  function onChange() {
    if (player && !d.contains(player)) { player = null; }
    if (!isVisibleNow(player)) player = null;
    calmVideos();
    lazyImages();
  }

  function isVisibleNow(el) {
    return !el || isVisible(el, el.getBoundingClientRect());
  }

  var pending = 0;
  new MutationObserver(function () {
    if (pending) return;
    pending = setTimeout(function () { pending = 0; onChange(); }, 400);
  }).observe(d.documentElement, { childList: true, subtree: true });
  onChange();

  root.__tvnav = { move: move, back: back, menu: menu, pickNext: pickNext };
})(window);
