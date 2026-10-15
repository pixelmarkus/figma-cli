// `read` and render summaries share one text outline (__figHelpers.outline).
// Run against the mock sandbox: the shape of each line is the contract an
// agent learns once.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HELPERS_SOURCE } from '../src/lib/figma-helpers.js';
import { createSandbox } from './helpers/figma-sandbox.js';

function screen() {
  const sb = createSandbox();
  const f = sb.figma;
  const node = (make, props, parent) => { const n = f[make](); Object.assign(n, props); if (parent) parent.appendChild(n); return n; };
  // a component set with a variant property and a boolean
  const set = node('createFrame', { type: 'COMPONENT_SET', name: 'Button', componentPropertyDefinitions: { variant: { type: 'VARIANT', defaultValue: 'primary' }, 'icon#1:0': { type: 'BOOLEAN', defaultValue: true } } });
  const comp = node('createComponent', { name: 'variant=secondary' }, set);
  const root = node('createFrame', { name: 'Checkout', layoutMode: 'VERTICAL', width: 400, height: 300 });
  node('createText', { characters: 'Your order' }, root);
  const wrap = node('createFrame', { name: 'Frame 1234', layoutMode: 'HORIZONTAL' }, root);
  node('createText', { characters: '  Total\n€ 12 ' }, wrap);
  node('createRectangle', { name: 'divider' }, wrap);
  node('createText', { characters: 'secret', visible: false }, wrap);
  const btn = node('createFrame', { type: 'INSTANCE', name: 'Button', mainComponent: comp, componentProperties: { variant: { type: 'VARIANT', value: 'secondary' }, 'icon#1:0': { type: 'BOOLEAN', value: false } } }, root);
  node('createText', { characters: 'Pay now' }, btn);
  return { sb, root };
}

const outline = async (sb, root, opts) => sb.run(`(async () => { ${HELPERS_SOURCE}
  return globalThis.__figHelpers.outline(await figma.getNodeByIdAsync(${JSON.stringify(root.id)}), ${JSON.stringify(opts || {})}); })()`);

describe('read outline', () => {
  it('compact: copy in order, instances by component and variant, ids, no noise', async () => {
    const { sb, root } = screen();
    const lines = (await outline(sb, root)).split('\n');
    assert.deepEqual(lines.map(l => l.replace(/\[\d+:\d+\]/g, '[id]')), [
      'Checkout col (400x300) [id]',
      '  "Your order"',
      '  "Total € 12"',              // generic wrapper folded, whitespace collapsed
      '  <Button variant=secondary, icon=false> "Pay now" [id]',
    ]);
    assert.ok(!lines.join('\n').includes('secret'), 'hidden layers are left out');
    assert.ok(!lines.join('\n').includes('divider'), 'shapes are left out');
  });

  it('--texts: only the copy', async () => {
    const { sb, root } = screen();
    assert.deepEqual((await outline(sb, root, { textsOnly: true })).split('\n'), ['"Your order"', '"Total € 12"', '"Pay now"']);
  });

  it('detail (the render summary): every node with size and layout, same grammar', async () => {
    const { sb, root } = screen();
    const text = await outline(sb, root, { detail: true });
    assert.match(text, /^Checkout col 400x300 \[\d+:\d+\]/);
    assert.match(text, /\n {2}Frame 1234 row /, 'wrappers are shown in detail');
    assert.match(text, /divider RECTANGLE/);
    assert.match(text, /<Button variant=secondary, icon=false> "Pay now" .*\[\d+:\d+\]/);
  });

  it('--names: layer names (translation keys) before the copy', async () => {
    const { sb, root } = screen();
    const kids = root.children;
    kids[0].name = 'checkout_title';                 // a key
    kids[2].children[0].name = 'Pay now';            // same as its copy: not repeated
    const text = await outline(sb, root, { textsOnly: true, names: true });
    assert.deepEqual(text.split('\n'), ['checkout_title: "Your order"', 'TEXT: "Total € 12"', '"Pay now"']);
  });

  it('says where it stopped', async () => {
    const { sb, root } = screen();
    const cut = (await outline(sb, root, { maxLines: 2 })).split('\n');
    assert.equal(cut.length, 3);
    assert.match(cut[2], /cut at 2 lines: read a child id/);
    const shallow = await outline(sb, root, { depth: 0 });
    assert.match(shallow, /… 3 more inside: read \d+:\d+/);
  });
});
