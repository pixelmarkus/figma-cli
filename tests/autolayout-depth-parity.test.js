import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient, resolveAlign, generateMinMaxCode, DEFAULT_FLEX } from '../src/figma-client.js';

/**
 * The recurring "auto-layout is behaving weirdly" reports all traced back to
 * ONE root cause: the same JSX was laid out by different code depending on
 * where it sat. The root path and the nested path disagreed on the default
 * direction and on the default alignment, and `render` could additionally hand
 * the whole job to the external `figma-use` binary, which agreed with neither.
 *
 * These tests pin the invariant that replaced all of it: DEPTH MUST NOT CHANGE
 * LAYOUT. A Frame's emitted layout properties depend on its own attributes, not
 * on how deeply it is nested.
 */
describe('auto-layout: depth must not change layout', () => {
  const client = new FigmaClient();

  // Pull the layout properties out of the generated code for one named frame.
  const layoutOf = (code, frameName) => {
    const at = code.indexOf(JSON.stringify(frameName));
    assert.ok(at > -1, `frame ${frameName} not found in generated code`);
    // Each frame's assignments are emitted contiguously; the next createFrame /
    // createText call ends the block.
    const rest = code.slice(at);
    const nextNode = rest.search(/figma\.create(Frame|Text|Ellipse|Rectangle)\(/);
    const block = nextNode > -1 ? rest.slice(0, nextNode) : rest;
    const grab = (re) => {
      const m = block.match(re);
      return m ? m[1] : null;
    };
    return {
      mode: grab(/layoutMode = '(\w+)'/),
      primary: grab(/primaryAxisAlignItems = '(\w+)'/),
      counter: grab(/counterAxisAlignItems = '(\w+)'/),
    };
  };

  const CASES = [
    { label: 'no flex', attrs: '' },
    { label: 'flex="col"', attrs: ' flex="col"' },
    { label: 'flex="row"', attrs: ' flex="row"' },
    { label: 'row + items=end', attrs: ' flex="row" items="end"' },
    { label: 'col + justify=between', attrs: ' flex="col" justify="between"' },
    { label: 'row + items=start', attrs: ' flex="row" items="start"' },
  ];

  for (const { label, attrs } of CASES) {
    it(`lays out the same at root and nested — ${label}`, async () => {
      const asRoot = await client.parseJSX(
        `<Frame name="T"${attrs}><Text>x</Text></Frame>`
      );
      const asNested = await client.parseJSX(
        `<Frame name="Outer" flex="col"><Frame name="T"${attrs}><Text>x</Text></Frame></Frame>`
      );

      const root = layoutOf(asRoot, 'T');
      const nested = layoutOf(asNested, 'T');

      assert.deepStrictEqual(
        nested,
        root,
        `${label}: nested ${JSON.stringify(nested)} != root ${JSON.stringify(root)}`
      );
    });
  }

  it('a Frame without flex is a column at BOTH depths (was: row when nested)', async () => {
    const asRoot = await client.parseJSX('<Frame name="T"><Text>x</Text></Frame>');
    const asNested = await client.parseJSX(
      '<Frame name="Outer" flex="col"><Frame name="T"><Text>x</Text></Frame></Frame>'
    );
    assert.strictEqual(layoutOf(asRoot, 'T').mode, 'VERTICAL');
    assert.strictEqual(layoutOf(asNested, 'T').mode, 'VERTICAL');
    assert.strictEqual(DEFAULT_FLEX, 'col');
  });

  it('a plain wrapper does not silently center its children', async () => {
    const code = await client.parseJSX(
      '<Frame name="Outer" flex="col"><Frame name="Wrap"><Text>Title</Text></Frame></Frame>'
    );
    assert.strictEqual(layoutOf(code, 'Wrap').counter, 'MIN');
  });
});

describe('resolveAlign', () => {
  it('rows center their cross axis, columns read top-left', () => {
    assert.deepStrictEqual(resolveAlign('row', {}), { alignVal: 'CENTER', justifyVal: 'MIN' });
    assert.deepStrictEqual(resolveAlign('col', {}), { alignVal: 'MIN', justifyVal: 'MIN' });
  });

  it('treats a missing/unknown flex as a column, matching layoutMode', () => {
    assert.strictEqual(resolveAlign(undefined, {}).alignVal, 'MIN');
    assert.strictEqual(resolveAlign('none', {}).alignVal, 'MIN');
  });

  it('accepts both items= and align=, and explicit values always win', () => {
    assert.strictEqual(resolveAlign('row', { items: 'start' }).alignVal, 'MIN');
    assert.strictEqual(resolveAlign('col', { align: 'center' }).alignVal, 'CENTER');
    assert.strictEqual(resolveAlign('col', { justify: 'between' }).justifyVal, 'SPACE_BETWEEN');
    assert.strictEqual(resolveAlign('row', { justify: 'end' }).justifyVal, 'MAX');
  });
});

describe('min/max constraints (were accepted but never applied)', () => {
  it('emits every constraint it is given', () => {
    const code = generateMinMaxCode('el', { minW: 10, maxW: 200, minH: 5, maxH: 60 });
    assert.match(code, /el\.minWidth = 10;/);
    assert.match(code, /el\.maxWidth = 200;/);
    assert.match(code, /el\.minHeight = 5;/);
    assert.match(code, /el\.maxHeight = 60;/);
  });

  it('accepts the long prop names and px strings', () => {
    const code = generateMinMaxCode('el', { minWidth: '24px', maxHeight: '80' });
    assert.match(code, /el\.minWidth = 24;/);
    assert.match(code, /el\.maxHeight = 80;/);
  });

  it('emits nothing when unset, and ignores junk instead of breaking the script', () => {
    assert.strictEqual(generateMinMaxCode('el', {}), '');
    assert.strictEqual(generateMinMaxCode('el', { minW: 'fill', maxW: -5 }), '');
  });

  it('guards each set so an unsupported node type cannot abort the render', () => {
    const code = generateMinMaxCode('el', { minW: 10 });
    assert.match(code, /try \{ el\.minWidth = 10; \} catch \(e\) \{\}/);
  });

  it('reaches nested frames through parseJSX', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="Outer" flex="col" w={300}><Frame name="Box" w="fill" maxW={200} minH={60} /></Frame>'
    );
    assert.match(code, /maxWidth = 200;/);
    assert.match(code, /minHeight = 60;/);
  });

  it('reaches the root frame too', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX('<Frame name="R" flex="col" maxW={480}><Text>x</Text></Frame>');
    assert.match(code, /frame\.maxWidth = 480;/);
  });
});

describe('parseJSX placement options (replacing the external renderer)', () => {
  const client = new FigmaClient();

  it('CLI -x/-y override smart positioning', async () => {
    const code = await client.parseJSX('<Frame name="P" w={10} h={10} />', { x: 42, y: 99 });
    assert.match(code, /const smartX = 42;/);
    assert.match(code, /frame\.y = 99;/);
    assert.doesNotMatch(code, /__figHelpers\.place\(/, 'explicit x must not also run smart positioning');
  });

  it('smart positioning still applies when no x is given', async () => {
    const code = await client.parseJSX('<Frame name="P" w={10} h={10} />');
    assert.match(code, /__figHelpers\.place\(__page, \[__root\]\)/);
  });

  it('--parent re-homes the frame after its children exist', async () => {
    const code = await client.parseJSX('<Frame name="P" w={10} h={10} />', { parent: '12:34' });
    assert.match(code, /getNodeByIdAsync\("12:34"\)/);
    assert.match(code, /__p\.appendChild\(frame\)/);
    assert.ok(
      code.indexOf('__p.appendChild(frame)') > code.indexOf('frame.clipsContent'),
      'reparenting must happen after the frame is fully built'
    );
  });
});
