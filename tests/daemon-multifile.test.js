// One daemon, several open files. Each request names its file (FIGMA_FILE)
// and goes to that file's connection. Before, the daemon held one connection;
// a request for another file made the CLI restart it, killing what other
// agents had in flight, and a second plugin replaced the first.
//
// Runs a real daemon on a spare port with its own HOME (own token, own pid
// file), so it never meets a daemon the user is running. Fake plugins stand in
// for Figma: they answer evals after a random delay, tagged with their file.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.js');
const TOKEN = 'test-token-' + process.pid;

const freePort = () => new Promise((resolve) => {
  const srv = createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

let port, home, daemon;
const plugins = [];

async function request(path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Daemon-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const exec = (code, file) => request('/exec', { action: 'eval', code, file });

/** A fake FigCli plugin running in `file`. hold(): park evals until release(). */
function fakePlugin(file) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
    const plugin = { ws, file, held: null };
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', mode: 'plugin', version: 'test' })); resolve(plugin); });
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.action !== 'eval') return;
      const reply = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({
        type: 'result', id: msg.id,
        result: msg.code === 'figma.root.name' ? file : { file, code: msg.code },
      }));
      if (plugin.held && msg.code !== 'figma.root.name') plugin.held.push(reply);
      else setTimeout(reply, Math.random() * 15);
    });
    plugins.push(plugin);
  });
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
}

describe('daemon serves several files at once', () => {
  before(async () => {
    port = await freePort();
    home = mkdtempSync(join(tmpdir(), 'figma-cli-multifile-'));
    mkdirSync(join(home, '.figma-ds-cli'), { recursive: true });
    writeFileSync(join(home, '.figma-ds-cli', '.daemon-token'), TOKEN);
    daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, HOME: home, USERPROFILE: home, DAEMON_PORT: String(port), DAEMON_MODE: 'plugin', FIGMA_FILE: '' },
      stdio: 'ignore',
    });
    await waitFor(async () => (await request('/health')).status === 200);
    await fakePlugin('Alpha Design System');
    await fakePlugin('Beta Marketing Site');
    await waitFor(async () => (await request('/health')).body.files.length === 2);
  });

  after(() => {
    for (const p of plugins) { try { p.ws.close(); } catch {} }
    if (daemon) daemon.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });

  it('health lists every connected file', async () => {
    const { body } = await request('/health');
    assert.equal(body.multiFile, true);
    assert.deepEqual([...body.files].sort(), ['Alpha Design System', 'Beta Marketing Site']);
  });

  it('routes parallel requests to the file each one names', async () => {
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      const file = i % 2 ? 'beta' : 'Alpha';
      jobs.push(exec(`job ${i}`, file).then(r => ({ i, file, r })));
    }
    for (const { i, file, r } of await Promise.all(jobs)) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.result.code, `job ${i}`);
      assert.match(r.body.result.file, new RegExp(file, 'i'));
    }
  });

  it('a request without a file goes to the most recently connected plugin', async () => {
    const r = await exec('no pin');
    assert.equal(r.body.result.file, 'Beta Marketing Site');
  });

  it('a file nobody has open is an error, not the wrong file', async () => {
    const r = await exec('lost', 'Gamma');
    assert.equal(r.status, 500);
    assert.match(r.body.error, /No connection to a Figma file matching "Gamma"/);
  });

  it('one file closing does not fail the other file\'s requests', async () => {
    const alpha = plugins.find(p => p.file.startsWith('Alpha'));
    const beta = plugins.find(p => p.file.startsWith('Beta'));
    beta.held = [];
    const betaJob = exec('beta keeps going', 'Beta');
    await waitFor(() => beta.held.length === 1);
    const alphaJob = exec('alpha in flight', 'Alpha');
    alpha.ws.close();
    const a = await alphaJob;
    assert.equal(a.status, 500);
    beta.held.forEach(reply => reply());
    beta.held = null;
    const b = await betaJob;
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.result.code, 'beta keeps going');
    await waitFor(async () => (await request('/health')).body.files.length === 1);
  });
});
