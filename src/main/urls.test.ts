import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeUserAgent, isAppUrl, isAuthFlowUrl, isAuthPopupUrl, isWebUrl, toHostname } from './urls.js';

void test('url policy', () => {
  assert.ok(isAppUrl('https://animeon.cc/anime/x'));
  assert.ok(isAppUrl('https://www.animeon.cc/'));
  assert.ok(!isAppUrl('http://animeon.cc/')); // https only
  assert.ok(!isAppUrl('https://animeon.cc.evil.com/'));
  assert.ok(!isAppUrl('https://evilanimeon.cc/'));
  assert.ok(!isAppUrl('file:///C:/Windows'));

  assert.ok(isAuthPopupUrl('https://accounts.google.com/gsi/select?x'));
  assert.ok(!isAuthPopupUrl('https://t.me/somebot'));
  assert.ok(isAuthFlowUrl('https://accounts.youtube.com/accounts/SetSID'));

  assert.ok(isWebUrl('https://t.me/x'));
  assert.ok(isWebUrl('http://example.com'));
  for (const bad of ['file:///C:/x', 'javascript:alert(1)', 'ms-settings:', 'tg://resolve', 'not a url']) {
    assert.ok(!isWebUrl(bad), bad);
  }

  assert.equal(toHostname(' https://Kodik.info/path '), 'kodik.info');
  assert.equal(toHostname('kodikplayer.com'), 'kodikplayer.com');
  assert.equal(toHostname('not a host'), null);
  assert.equal(toHostname('$domain=x'), null);

  const ua = chromeUserAgent('win32', '146.0.7680.31');
  assert.equal(
    ua,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  );
});
