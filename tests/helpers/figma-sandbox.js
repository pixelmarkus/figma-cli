// A small stand-in for Figma's plugin sandbox, for tests that run the code the
// render generator emits. Not a layout engine: it stores what the code sets and
// keeps the document tree (pages, parents, children, x/y/width/height) honest.
//
// Every async API resolves after a random delay, so several renders started
// together really interleave at their awaits, as they do in Figma when several
// agents send commands at once.

import vm from 'node:vm';

let nextId = 1;

function makeNode(type, sandbox) {
  const node = {
    id: `${nextId++}:1`,
    type,
    name: type,
    x: 0, y: 0, width: 100, height: 100,
    children: [],
    parent: null,
    fills: [], strokes: [], effects: [],
    resize(w, h) { this.width = w; this.height = h; },
    resizeWithoutConstraints(w, h) { this.width = w; this.height = h; },
    appendChild(child) { sandbox.attach(this, child, this.children.length); },
    insertChild(index, child) { sandbox.attach(this, child, index); },
    remove() { sandbox.detach(this); this.removed = true; },
    findAll(fn) { const out = []; const walk = n => { for (const c of n.children || []) { if (!fn || fn(c)) out.push(c); walk(c); } }; walk(this); return out; },
    findOne(fn) { return this.findAll(fn)[0] || null; },
    findAllWithCriteria({ types } = {}) { return this.findAll(n => !types || types.includes(n.type)); },
    setBoundVariable() {},
    setPluginData() {}, getPluginData() { return ''; },
    setSharedPluginData() {}, getSharedPluginData() { return ''; },
    setRangeFontName() {}, setRangeFontSize() {}, setRangeFills() {},
    getRangeFontName() { return this.fontName; },
    getMainComponentAsync() { return Promise.resolve(this.mainComponent || null); },
    createInstance() {
      const i = makeNode('INSTANCE', sandbox); i.width = this.width; i.height = this.height; i.mainComponent = this;
      for (const c of this.children) { const k = makeNode(c.type, sandbox); Object.assign(k, { name: c.name, characters: c.characters, fontName: c.fontName, visible: true }); sandbox.attach(i, k); }
      sandbox.attach(sandbox.figma.currentPage, i);
      return i;
    },
  };
  if (type === 'TEXT') { node.characters = ''; node.fontName = { family: 'Inter', style: 'Regular' }; node.fontSize = 12; }
  if (type === 'FRAME') {
    // Switching a row to hug resizes it to its content right away, as Figma
    // does: an empty hugging frame is only as wide as its padding.
    let sizing = 'FIXED';
    Object.defineProperty(node, 'primaryAxisSizingMode', {
      get: () => sizing,
      set: (v) => { sizing = v; sandbox.hug(node); },
      enumerable: true,
    });
  }
  sandbox.nodes.set(node.id, node);
  return node;
}

export function createSandbox({ maxDelayMs = 8, pages = ['Page 1'] } = {}) {
  const sb = { nodes: new Map(), calls: { setCurrentPage: 0 } };
  const delay = () => new Promise(r => setTimeout(r, Math.random() * maxDelayMs));
  const later = async (v) => { await delay(); return v; };

  sb.detach = (child) => {
    if (!child.parent) return;
    const sib = child.parent.children;
    const i = sib.indexOf(child);
    if (i >= 0) sib.splice(i, 1);
    child.parent = null;
  };
  sb.attach = (parent, child, index = parent.children.length) => {
    sb.detach(child);
    parent.children.splice(Math.min(index, parent.children.length), 0, child);
    child.parent = parent;
    hug(parent);
  };
  // Just enough auto-layout: a hugging row grows as children arrive, so a
  // frame that is still being built is narrower than it will end up.
  const hug = sb.hug = (f) => {
    if (f.layoutMode !== 'HORIZONTAL' || f.primaryAxisSizingMode !== 'AUTO') return;
    const kids = f.children;
    f.width = (f.paddingLeft || 0) + (f.paddingRight || 0)
      + kids.reduce((w, k) => w + k.width, 0) + (f.itemSpacing || 0) * Math.max(0, kids.length - 1);
  };

  const root = makeNode('DOCUMENT', sb);
  root.name = 'Test file';
  for (const name of pages) { const p = makeNode('PAGE', sb); p.name = name; sb.attach(root, p); }

  const variables = {
    getLocalVariablesAsync: () => later([]),
    getLocalVariableCollectionsAsync: () => later([]),
    getVariableByIdAsync: () => later(null),
    setBoundVariableForPaint: (paint) => paint,
  };

  const figma = {
    root,
    mixed: Symbol('mixed'),
    currentPage: root.children[0],
    variables,
    createFrame() { const n = makeNode('FRAME', sb); sb.attach(figma.currentPage, n); return n; },
    createText() { const n = makeNode('TEXT', sb); sb.attach(figma.currentPage, n); return n; },
    createRectangle() { const n = makeNode('RECTANGLE', sb); sb.attach(figma.currentPage, n); return n; },
    createEllipse() { const n = makeNode('ELLIPSE', sb); sb.attach(figma.currentPage, n); return n; },
    createComponent() { const n = makeNode('COMPONENT', sb); sb.attach(figma.currentPage, n); return n; },
    createPage() { const p = makeNode('PAGE', sb); sb.attach(root, p); return p; },
    async setCurrentPageAsync(p) { await delay(); figma.currentPage = p; sb.calls.setCurrentPage++; },
    loadAllPagesAsync: () => later(undefined),
    loadFontAsync: () => later(undefined),
    listAvailableFontsAsync: () => later([{ fontName: { family: 'Inter', style: 'Regular' } }, { fontName: { family: 'Inter', style: 'Medium' } }, { fontName: { family: 'Inter', style: 'Bold' } }]),
    getNodeByIdAsync: (id) => later(sb.nodes.get(id) && !sb.nodes.get(id).removed ? sb.nodes.get(id) : null),
    getNodeById: (id) => sb.nodes.get(id) || null,
    getStyleByIdAsync: () => later(null),
    getLocalTextStylesAsync: () => later([]),
    getLocalEffectStylesAsync: () => later([]),
    getLocalPaintStylesAsync: () => later([]),
    getLocalGridStylesAsync: () => later([]),
    importComponentByKeyAsync: () => later(null),
    notify() {},
  };
  sb.figma = figma;
  sb.root = root;

  const context = vm.createContext({ figma, console, setTimeout, clearTimeout, Promise, Math, JSON, Date, Set, Map, Symbol, Error, Array, Object, Number, String });
  context.globalThis = context;
  // The generated render code is one async IIFE expression.
  sb.run = (code) => vm.runInContext(code, context);
  sb.page = (name) => root.children.find(p => p.name === name);
  sb.addComponent = (name, w, h, pageName = pages[0]) => {
    const c = makeNode('COMPONENT', sb); c.name = name; c.width = w; c.height = h;
    sb.attach(sb.page(pageName), c);
    c.x = -10000; // keep test components out of the way of placed frames
    // A label, so every instance loads its font while the frame is built,
    // like a real button does.
    const label = makeNode('TEXT', sb); label.name = 'Label'; label.characters = name;
    sb.attach(c, label);
    return c;
  };
  return sb;
}

/** Pairs of top-level nodes on a page whose horizontal extents overlap. */
export function overlaps(page, ids) {
  const nodes = page.children.filter(n => ids.includes(n.id));
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width) out.push([a.name, b.name]);
    }
  }
  return out;
}
