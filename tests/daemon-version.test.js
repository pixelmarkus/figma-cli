import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionOlder, pinNeedsRestart } from '../src/lib/cli-core.js';

test('only an older daemon counts as stale, so two installs never restart each other', () => {
  assert.equal(versionOlder('2.2.3', '2.2.4'), true);
  assert.equal(versionOlder('2.2.4', '2.2.4'), false);
  assert.equal(versionOlder('2.3.0', '2.2.9'), false);
  assert.equal(versionOlder('2.10.0', '2.9.0'), false);
  assert.equal(versionOlder(undefined, '2.2.4'), true);
});

test('a pinned file restarts only a daemon that cannot serve it', () => {
  const multi = { status: 'ok', multiFile: true, file: 'Order', files: ['Order', 'Untitled'] };
  const single = (file) => ({ status: 'ok', file });
  // multi-file daemons route by the request's file: never restart them
  assert.equal(pinNeedsRestart('Untitled', multi), false);
  assert.equal(pinNeedsRestart('Nowhere', multi), false);
  // a single-file daemon already on the pinned file is fine
  assert.equal(pinNeedsRestart('untitled', single('Untitled – Figma')), false);
  // on another file, or not saying which (old Safe Mode): restart, or the
  // request runs in the wrong file
  assert.equal(pinNeedsRestart('Untitled', single('Order')), true);
  assert.equal(pinNeedsRestart('Untitled', single(null)), true);
  // no pin, or no daemon to judge: leave it alone
  assert.equal(pinNeedsRestart('', single('Order')), false);
  assert.equal(pinNeedsRestart('Untitled', null), false);
});
