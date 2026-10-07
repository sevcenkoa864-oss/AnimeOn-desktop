import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedHosts, configureImageProxy, imageRedirect, noteFailure } from './imageproxy.js';

const SEL = 'https://ab18cf62-4b99-4613-a8c1-c801eda74545.selcdn.net/anime/posters/1_shiki.jpg';
const KP = 'https://st.kp.yandex.net/images/film_big/1.jpg';

void test('image proxy', () => {
  configureImageProxy(true, []);
  assert.equal(imageRedirect(SEL, 'image'), undefined); // nothing marked yet

  // only real image failures on candidate hosts mark a host
  assert.equal(noteFailure(SEL, 'image', 'net::ERR_ABORTED'), false);
  assert.equal(noteFailure(SEL, 'image', 'net::ERR_BLOCKED_BY_CLIENT'), false);
  assert.equal(noteFailure(SEL, 'xhr', 'net::ERR_NAME_NOT_RESOLVED'), false);
  assert.equal(noteFailure('https://shikimori.io/x.jpg', 'image', 'net::ERR_TIMED_OUT'), false);
  assert.equal(noteFailure(SEL, 'image', 'net::ERR_NAME_NOT_RESOLVED'), true);
  assert.equal(noteFailure(SEL, 'image', 'net::ERR_NAME_NOT_RESOLVED'), false); // already marked
  assert.deepEqual(blockedHosts(), [new URL(SEL).hostname]);

  assert.equal(imageRedirect(SEL, 'image'), `https://wsrv.nl/?url=${encodeURIComponent(SEL)}`);
  assert.equal(imageRedirect(SEL, 'script'), undefined); // images only
  assert.equal(imageRedirect(KP, 'image'), undefined); // not marked

  configureImageProxy(false, blockedHosts()); // switched off in settings: no redirects, marks kept
  assert.equal(imageRedirect(SEL, 'image'), undefined);
  assert.deepEqual(blockedHosts(), [new URL(SEL).hostname]);
});
