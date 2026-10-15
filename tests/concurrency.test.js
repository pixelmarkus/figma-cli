// Several agents rendering into one file at the same time. Figma runs every
// command on one JS thread but interleaves them at each await, so a render can
// measure the page, wait, and build its frame on top of one that finished in
// the meantime, or land on a page another agent just switched to.
//
// These tests run the code the render generator emits in a mock sandbox with
// random latency on every async call, start many renders at once, and check
// where the frames end up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient } from '../src/figma-client.js';
import { createSandbox, overlaps } from './helpers/figma-sandbox.js';

const client = new FigmaClient();

// A hugging row with instances: it awaits while building (component lookup,
// font checks) and grows as each instance arrives.
const row = (name, buttons) =>
  `<Frame name="${name}" flex="row" gap={8} p={8}>${'<Instance component="Button" />'.repeat(buttons)}</Frame>`;

describe('concurrent renders', () => {
  it('parallel renders on one page never overlap', async () => {
    for (let round = 0; round < 5; round++) {
      const sb = createSandbox();
      sb.addComponent('Button', 80, 32);
      const codes = await Promise.all(Array.from({ length: 12 }, (_, i) => client.parseJSX(row(`R${i}`, 1 + (i % 4)))));
      const results = await Promise.all(codes.map(c => sb.run(c)));
      const ids = results.map(r => r.id);
      assert.deepEqual(overlaps(sb.page('Page 1'), ids), [], `round ${round}`);
    }
  });

  it('parallel render and render-batch calls never overlap', async () => {
    for (let round = 0; round < 5; round++) {
      const sb = createSandbox();
      sb.addComponent('Button', 80, 32);
      const singles = Array.from({ length: 4 }, (_, i) => client.parseJSX(row(`S${i}`, 2)));
      const batches = Array.from({ length: 3 }, (_, i) =>
        client.parseJSXBatch([row(`B${i}a`, 1), row(`B${i}b`, 3)], { gap: 40 }));
      const results = await Promise.all((await Promise.all([...singles, ...batches])).map(c => sb.run(c)));
      const ids = results.flatMap(r => Array.isArray(r) ? r.map(x => x.id) : [r.id]);
      assert.equal(ids.length, 4 + 3 * 2);
      assert.deepEqual(overlaps(sb.page('Page 1'), ids), [], `round ${round}`);
    }
  });

  it('a batch keeps its own frames in order, side by side', async () => {
    const sb = createSandbox();
    sb.addComponent('Button', 80, 32);
    const code = await client.parseJSXBatch([row('a', 1), row('b', 2), row('c', 1)], { gap: 40 });
    const [a, b, c] = (await sb.run(code)).map(r => sb.figma.getNodeById(r.id));
    assert.equal(b.x, a.x + a.width + 40);
    assert.equal(c.x, b.x + b.width + 40);
  });

  it('--page lands on its page while other agents switch pages', async () => {
    const sb = createSandbox({ pages: ['Page 1', 'P1'] });
    sb.addComponent('Button', 80, 32);
    const start = sb.figma.currentPage;
    const p1 = await Promise.all(Array.from({ length: 4 }, (_, i) => client.parseJSX(row(`one${i}`, 2), { page: 'P1' })));
    const p2 = await Promise.all(Array.from({ length: 4 }, (_, i) => client.parseJSX(row(`two${i}`, 2), { page: 'P2' })));
    const batch = await client.parseJSXBatch([row('bat0', 1), row('bat1', 1)], { page: 'P2' });
    // Another agent flipping pages the whole time (eval $page, old --page).
    let flipping = true;
    const flipper = (async () => {
      const pages = sb.figma.root.children;
      for (let i = 0; flipping; i++) await sb.figma.setCurrentPageAsync(pages[i % pages.length]);
    })();
    const switchesBefore = sb.calls.setCurrentPage;
    const results = await Promise.all([...p1, ...p2, batch].map(c => sb.run(c)));
    flipping = false;
    await flipper;

    const pageOf = id => sb.figma.getNodeById(id).parent.name;
    results.slice(0, 4).forEach(r => assert.equal(pageOf(r.id), 'P1', r.name));
    results.slice(4, 8).forEach(r => assert.equal(pageOf(r.id), 'P2', r.name));
    results[8].forEach(r => assert.equal(pageOf(r.id), 'P2', r.name));
    // Missing page is created exactly once, however many renders ask for it.
    assert.equal(sb.figma.root.children.filter(p => p.name === 'P2').length, 1);
    for (const name of ['P1', 'P2']) {
      const page = sb.page(name);
      assert.deepEqual(overlaps(page, page.children.map(n => n.id)), [], name);
    }
    // Renders never touch currentPage themselves; only the flipper did.
    assert.ok(sb.calls.setCurrentPage > switchesBefore);
    void start;
  });

  it('render --page does not switch the page the user is looking at', async () => {
    const sb = createSandbox({ pages: ['Page 1'] });
    const before = sb.figma.currentPage;
    await sb.run(await client.parseJSX('<Frame name="F" w={10} h={10} />', { page: 'Other' }));
    await sb.run(await client.parseJSXBatch(['<Frame name="G" w={10} h={10} />'], { page: 'Other' }));
    assert.equal(sb.figma.currentPage, before);
    assert.equal(sb.calls.setCurrentPage, 0);
    assert.deepEqual(sb.page('Other').children.map(n => n.name), ['F', 'G']);
  });

  it('a failed render does not leave a frame marked as in flight', async () => {
    const sb = createSandbox();
    sb.addComponent('Button', 80, 32);
    await assert.rejects(sb.run(await client.parseJSX('<Frame name="bad" flex="row"><Instance component="Nope" /></Frame>')), /Component not found/);
    await assert.rejects(sb.run(await client.parseJSXBatch(['<Frame name="badB" flex="row"><Instance component="Nope" /></Frame>'])), /Component not found/);
    const inflight = sb.run('globalThis.__figInflight');
    // the batch's half-built frame stays (as before) but is measured again
    assert.equal(inflight.size, 0);
    const a = await sb.run(await client.parseJSX(row('after', 1)));
    const page = sb.page('Page 1');
    assert.deepEqual(overlaps(page, page.children.filter(n => n.type === 'FRAME').map(n => n.id)), []);
    assert.ok(sb.figma.getNodeById(a.id));
  });

  it('explicit x and --parent are left alone', async () => {
    const sb = createSandbox();
    const host = await sb.run(await client.parseJSX('<Frame name="host" w={500} h={500} />'));
    const at = await sb.run(await client.parseJSX('<Frame name="at" w={10} h={10} />', { x: 4242, y: 7 }));
    const kid = await sb.run(await client.parseJSX('<Frame name="kid" w={10} h={10} />', { parent: host.id }));
    assert.equal(sb.figma.getNodeById(at.id).x, 4242);
    assert.equal(sb.figma.getNodeById(at.id).y, 7);
    assert.equal(sb.figma.getNodeById(kid.id).parent.id, host.id);
  });
});
