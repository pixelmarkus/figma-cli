// Helpers that run INSIDE Figma, shared by `render` (<Instance>, effectStyle,
// textStyle) and by `eval` (as $page, $var, $bind, $instance, $fontSafe,
// $style). One implementation, so the missing-font handling below behaves the
// same whichever command an agent reaches for.
//
// Why they exist: a component whose text uses a font that is not installed
// cannot be relabelled, and Figma even refuses to appendChild the instance into
// a frame ("unloaded font"). Without help an agent rediscovers that by trial
// and error on every task. Here it is handled once.
//
// Kept as a source string because it is evaluated in the Figma sandbox, not in
// Node. It installs itself on globalThis and is idempotent per version.

export const HELPERS_VERSION = 11;

export const HELPERS_SOURCE = `
if (!globalThis.__figHelpers || globalThis.__figHelpers.v !== ${HELPERS_VERSION}) {
  const H = { v: ${HELPERS_VERSION} };
  // Notes for the caller (deduplicated). eval and render reset and print them.
  H.note = (msg) => { (globalThis.__figNotes || (globalThis.__figNotes = new Set())).add(msg); };
  let pagesLoaded = false;
  const loadPages = async () => { if (!pagesLoaded) { await figma.loadAllPagesAsync(); pagesLoaded = true; } };
  let fontList = null;
  const available = async (f) => {
    if (!fontList) fontList = new Set((await figma.listAvailableFontsAsync()).map(x => x.fontName.family + '|' + x.fontName.style));
    return fontList.has(f.family + '|' + f.style);
  };
  const FALLBACK = 'Inter';
  const fallbackStyle = (style) => {
    const s = String(style || '').toLowerCase();
    if (s.includes('black') || s.includes('heavy')) return 'Black';
    if (s.includes('extra') && s.includes('bold')) return 'Extra Bold';
    if (s.includes('semi') || s.includes('demi')) return 'Semi Bold';
    if (s.includes('bold')) return 'Bold';
    if (s.includes('medium')) return 'Medium';
    if (s.includes('light')) return 'Light';
    return 'Regular';
  };

  // Make every text under node editable: load installed fonts, swap missing
  // ones to Inter (same weight). Returns the list of swapped fonts.
  H.fontSafe = async (node) => {
    const texts = node.type === 'TEXT' ? [node] : (node.findAllWithCriteria ? node.findAllWithCriteria({ types: ['TEXT'] }) : []);
    const swapped = new Set();
    for (const t of texts) {
      const fonts = t.fontName === figma.mixed ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
      let missing = false;
      for (const f of fonts) {
        if (await available(f)) await figma.loadFontAsync(f); else missing = true;
      }
      if (missing) {
        const style = fallbackStyle((fonts[0] || {}).style);
        const f = { family: FALLBACK, style };
        try { await figma.loadFontAsync(f); } catch (e) { f.style = 'Regular'; await figma.loadFontAsync(f); }
        for (const old of fonts) swapped.add(old.family + ' ' + old.style);
        t.fontName = f;
      }
    }
    return [...swapped];
  };

  // Page by name, created when missing, WITHOUT switching to it. currentPage
  // is one value shared by every agent on the file, so render --page appends
  // to the page directly instead. Find and create run with no await between
  // them, so two concurrent callers cannot both create the page.
  H.pageNode = async (name) => {
    await loadPages();
    let p = figma.root.children.find(p => p.name === name);
    if (!p) { p = figma.createPage(); p.name = name; }
    return p;
  };

  // Page by name: switch to it, create it when missing.
  H.page = async (name) => {
    const p = await H.pageNode(name);
    await figma.setCurrentPageAsync(p);
    return p;
  };

  // Smart positioning for concurrent renders. Figma interleaves evals at every
  // await, so a render that measured the page when it STARTED lands on top of
  // one that finished meanwhile. Instead a render registers its top-level
  // frames as in flight, builds them, and places them when DONE: measure and
  // move in one synchronous step, skipping frames other renders still build
  // (their size is not final). The render that finishes later sees the earlier
  // one at its final size and goes to its right.
  H.inflight = globalThis.__figInflight || (globalThis.__figInflight = new Set());
  H.nextX = (page, skip) => {
    let maxRight = 0, any = false;
    for (const n of page.children) {
      if ((skip && skip.has(n.id)) || H.inflight.has(n.id)) continue;
      any = true;
      const right = n.x + (n.width || 0);
      if (right > maxRight) maxRight = right;
    }
    return any ? Math.round(maxRight + 100) : 0;
  };
  // nodes: the finished top-level nodes, in order. Row: side by side from the
  // free x. Col: stacked at the free x from y. single: keep the node's own y.
  H.place = (page, nodes, { gap = 40, vertical = false, y = null } = {}) => {
    const skip = new Set(nodes.map(n => n.id));
    let x = H.nextX(page, skip), yy = y;
    for (const n of nodes) {
      n.x = x;
      if (yy !== null) n.y = yy;
      if (vertical) yy = (yy === null ? n.y : yy) + n.height + gap;
      else x += n.width + gap;
    }
  };

  let varIndex = null;
  H.variable = async (name) => {
    if (!varIndex || !varIndex.has(name)) {
      varIndex = new Map();
      for (const v of await figma.variables.getLocalVariablesAsync()) if (!varIndex.has(v.name)) varIndex.set(v.name, v);
    }
    const v = varIndex.get(name);
    if (!v) throw new Error('Variable not found: ' + name);
    return v;
  };

  // Bind a variable to fills (default), strokes, or any bindable field.
  H.bind = async (node, name, field = 'fills') => {
    const v = await H.variable(name);
    if (field === 'fills' || field === 'strokes') {
      const base = (Array.isArray(node[field]) && node[field][0] && node[field][0].type === 'SOLID') ? node[field][0] : { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } };
      node[field] = [figma.variables.setBoundVariableForPaint(base, 'color', v)];
    } else {
      node.setBoundVariable(field, v);
    }
    return node;
  };

  H.style = async (name) => {
    const all = [
      ...(await figma.getLocalTextStylesAsync()), ...(await figma.getLocalEffectStylesAsync()),
      ...(await figma.getLocalPaintStylesAsync()), ...(await figma.getLocalGridStylesAsync()),
    ];
    const s = all.find(s => s.name === name);
    if (!s) throw new Error('Style not found: ' + name);
    return s;
  };

  const compCache = new Map();
  // The helpers live on globalThis for the whole Figma session, so anything
  // cached here can point at a node or variable the user has since deleted.
  // Every render / eval starts with a reset (see RESET_NOTES).
  H.resetCaches = () => { compCache.clear(); varIndex = null; pagesLoaded = false; fontList = null; };
  // A component or component set by name (whole document) or by node id.
  H.component = async (ref) => {
    if (/^I?\\d+:\\d+/.test(ref)) {
      const n = await figma.getNodeByIdAsync(ref);
      if (n && (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')) return n;
    }
    if (compCache.has(ref)) return compCache.get(ref);
    await loadPages();
    const all = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] });
    const hit = all.find(n => n.type === 'COMPONENT_SET' && n.name === ref)
      || all.find(n => n.type === 'COMPONENT' && n.name === ref && (!n.parent || n.parent.type !== 'COMPONENT_SET'))
      || all.find(n => n.type === 'COMPONENT_SET' && n.name.toLowerCase() === String(ref).toLowerCase());
    if (!hit) throw new Error('Component not found: ' + ref);
    compCache.set(ref, hit);
    return hit;
  };

  // Variant of a set. "variant=danger, size=large" or {variant:'danger'}; the
  // given pairs must match, unspecified axes fall back to the default variant.
  H.variant = (set, spec) => {
    if (set.type !== 'COMPONENT_SET') return set;
    const want = {};
    if (typeof spec === 'string') {
      for (const part of spec.split(',')) { const i = part.indexOf('='); if (i > 0) want[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    } else if (spec) Object.assign(want, spec);
    const keys = Object.keys(want);
    if (!keys.length) return set.defaultVariant || set.children[0];
    const matches = set.children.filter(c => keys.every(k => String((c.variantProperties || {})[k]).toLowerCase() === String(want[k]).toLowerCase()));
    if (!matches.length) {
      const axes = Object.entries(set.variantGroupProperties || {}).map(([k, v]) => k + '=' + v.values.join('|')).join('; ');
      throw new Error('No variant of "' + set.name + '" matches ' + JSON.stringify(want) + '. Axes: ' + axes);
    }
    const def = set.defaultVariant ? set.defaultVariant.variantProperties || {} : {};
    // prefer the match closest to the default variant on the unspecified axes
    matches.sort((a, b) => {
      const score = c => Object.entries(def).filter(([k, v]) => !(k in want) && (c.variantProperties || {})[k] === v).length;
      return score(b) - score(a);
    });
    return matches[0];
  };

  // Instance of a component (set name, component name or id), font-safe.
  // opts: { variant, text, texts: {layerName: chars}, parent }
  H.instance = async (ref, variantSpec, opts = {}) => {
    const c = await H.component(ref);
    const comp = H.variant(c, variantSpec);
    const inst = comp.createInstance();
    const swapped = await H.fontSafe(inst);
    const texts = inst.findAllWithCriteria({ types: ['TEXT'] }).filter(t => t.visible);
    if (opts.text !== undefined && texts[0]) texts[0].characters = String(opts.text);
    if (opts.texts) for (const [layer, chars] of Object.entries(opts.texts)) {
      const t = inst.findOne(n => n.type === 'TEXT' && n.name === layer);
      if (t) t.characters = String(chars);
    }
    if (opts.parent) opts.parent.appendChild(inst);
    for (const f of swapped) H.note('font "' + f + '" is not installed, used Inter instead');
    return inst;
  };

  // One line per node, compact enough to replace a verification eval:
  //   Card FRAME 360x212 col gap=12 pad=24 fill=var:bgColor/muted effect=shadow/small
  //     Title TEXT 20 Inter Bold w=FILL fill=var:fgColor/default "Release notes"
  //     Button INSTANCE Button[variant=danger, size=large] "Delete"
  // Capped by depth and line count so a big tree never floods the output.
  // Outline of a subtree as text: one line per meaningful node, the copy in
  // reading order, instances as <Component variant=…> with their texts, ids
  // to act on. An agent builds context from this instead of a screenshot: it
  // is exact (real copy, real names), cheap (about as many tokens as an
  // image) and fast (no export, which can take Figma tens of seconds).
  //
  // Two levels, one grammar:
  //   compact (read):   wrapper frames folded, shapes and hidden layers left out
  //   detail (render summary, $describe): every node plus sizes, layout, paint
  //
  //   Card col [12:3]                         container: name, layout, id
  //     "Title"                               text
  //     <Button variant=primary> "Save" [12:9] instance: component, variant, texts
  H.outline = async (root, opts = {}) => {
    const detail = !!opts.detail;
    const maxDepth = opts.depth === undefined ? (detail ? 3 : 12) : opts.depth;
    const maxLines = opts.maxLines === undefined ? (detail ? 40 : 300) : opts.maxLines;
    const textMax = opts.textMax || (detail ? 40 : 300);
    const textsOnly = !!opts.textsOnly;
    // names: show each text layer's name before its copy where they differ
    // (translation keys live in layer names: \`sheet_title: "Book service"\`)
    const names = !!opts.names;
    const flat = (x) => String(x).replace(/\\s+/g, ' ').trim();
    // autoRename: Figma names the layer after its text, so the name says nothing
    const label = (t) => names && t.name && !t.autoRename && flat(t.name) !== flat(t.characters) ? t.name + ': ' : '';
    const lines = [];
    let more = false;
    const push = (l) => { if (lines.length >= maxLines) { more = true; return false; } lines.push(l); return true; };
    const q = (t) => {
      t = String(t).replace(/\\s+/g, ' ').trim();
      return JSON.stringify(t.length > textMax ? t.slice(0, textMax) + '…' : t);
    };
    const visible = (n) => n.visible !== false;
    const SHAPES = ['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'ELLIPSE', 'RECTANGLE', 'STAR', 'POLYGON', 'SLICE'];
    const WRAPPER = /^(Frame|Group|Auto layout|Container|Wrapper|Content)( \\d+)?$/;
    const varName = async (paint) => {
      const id = paint && paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id;
      if (!id) return null;
      const v = await figma.variables.getVariableByIdAsync(id);
      return v ? 'var:' + v.name : null;
    };
    const paintDesc = async (paints) => {
      if (!Array.isArray(paints) || !paints.length) return null;
      const p = paints[0];
      const v = await varName(p);
      if (v) return v;
      if (p.type === 'SOLID') return '#' + [p.color.r, p.color.g, p.color.b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('') + (p.opacity !== undefined && p.opacity < 1 ? '@' + Math.round(p.opacity * 100) + '%' : '');
      return p.type.toLowerCase();
    };
    const styleName = async (id) => (typeof id === 'string' && id) ? ((await figma.getStyleByIdAsync(id)) || {}).name : null;
    // Texts inside a subtree, in reading order, skipping hidden branches.
    const textsIn = (n, out = []) => {
      for (const c of ordered(n)) {
        if (c.type === 'TEXT') { if (c.characters.trim()) out.push(c); }
        else if ('children' in c) textsIn(c, out);
      }
      return out;
    };
    // Auto-layout keeps its child order; free layout reads top-left first.
    const ordered = (n) => {
      const kids = ('children' in n ? n.children : []).filter(visible);
      if (n.layoutMode && n.layoutMode !== 'NONE') return kids;
      return kids.slice().sort((a, b) => ('y' in a && 'y' in b) ? ((a.y - b.y) || (a.x - b.x)) : 0);
    };
    const component = async (inst) => {
      let mc = null;
      try { mc = await inst.getMainComponentAsync(); } catch (e) {}
      const owner = mc && mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent : mc;
      const name = owner ? owner.name : inst.name;
      // Variant values always; other properties only where they differ from
      // the component's default, so a plain instance stays one short line.
      const bits = [];
      try {
        const defs = owner ? owner.componentPropertyDefinitions : {};
        for (const [k, v] of Object.entries(inst.componentProperties || {})) {
          const key = k.split('#')[0];
          if (v.type === 'VARIANT') bits.push(key + '=' + v.value);
          else if (v.type === 'BOOLEAN' && defs[k] && defs[k].defaultValue !== v.value) bits.push(key + '=' + v.value);
          else if (v.type === 'INSTANCE_SWAP' && defs[k] && defs[k].defaultValue !== v.value) {
            const sw = await figma.getNodeByIdAsync(v.value);
            bits.push(key + '=' + (sw ? sw.name : 'swapped'));
          }
        }
      } catch (e) {}
      return '<' + name + (bits.length ? ' ' + bits.join(', ') : '') + '>';
    };
    // Sizes, layout, paint: the detail level, as before in describe().
    const attrs = async (n) => {
      const bits = [];
      if ('width' in n) bits.push(Math.round(n.width) + 'x' + Math.round(n.height));
      if (n.layoutMode && n.layoutMode !== 'NONE') {
        if (n.itemSpacing) bits.push('gap=' + n.itemSpacing);
        const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
        if (pad.some(Boolean)) bits.push('pad=' + (pad.every(v => v === pad[0]) ? pad[0] : pad.join('/')));
        if (n.layoutWrap === 'WRAP') bits.push('wrap');
      }
      const inAuto = n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE';
      if ((n.layoutMode && n.layoutMode !== 'NONE') || inAuto) {
        try {
          if (n.layoutSizingHorizontal && n.layoutSizingHorizontal !== 'FIXED') bits.push('w=' + n.layoutSizingHorizontal);
          if (n.layoutSizingVertical && n.layoutSizingVertical !== 'FIXED') bits.push('h=' + n.layoutSizingVertical);
        } catch (e) {}
      }
      if (n.type === 'TEXT' && n.textAutoResize === 'HEIGHT') bits.push('wraps');
      if (n.cornerRadius && n.cornerRadius !== figma.mixed) bits.push('r=' + n.cornerRadius);
      if (n.opacity !== undefined && n.opacity < 1) bits.push('opacity=' + Math.round(n.opacity * 100) / 100);
      if (n.type === 'TEXT') {
        const f = n.fontName !== figma.mixed ? n.fontName : null;
        bits.push((n.fontSize !== figma.mixed ? n.fontSize : 'mixed') + (f ? ' ' + f.family + ' ' + f.style : ''));
        const ts = await styleName(n.textStyleId); if (ts) bits.push('style=' + ts);
      }
      if ('fills' in n && n.type !== 'INSTANCE') { const f = await paintDesc(n.fills); if (f) bits.push('fill=' + f); }
      if ('strokes' in n && n.strokes && n.strokes.length) { const s = await paintDesc(n.strokes); if (s) bits.push('stroke=' + s); }
      if ('effectStyleId' in n) { const es = await styleName(n.effectStyleId); if (es) bits.push('effect=' + es); }
      if (n.type === 'COMPONENT_SET') bits.push(n.children.length + ' variants');
      // Figma throws when a VARIANT is asked for its property definitions;
      // only sets and standalone components have them.
      const ownsProps = n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && !(n.parent && n.parent.type === 'COMPONENT_SET'));
      if (ownsProps) {
        try {
          const defs = Object.entries(n.componentPropertyDefinitions).filter(([, d]) => d.type !== 'VARIANT').map(([k, d]) => k.split('#')[0] + ':' + d.type);
          if (defs.length) bits.push('props={' + defs.join(', ') + '}');
        } catch (e) {}
      }
      if (n.componentPropertyReferences && Object.keys(n.componentPropertyReferences).length) {
        bits.push('bound=' + Object.entries(n.componentPropertyReferences).map(([k, v]) => k + '→' + String(v).split('#')[0]).join(','));
      }
      if (n.reactions && n.reactions.length) bits.push(n.reactions.length + ' interaction(s)');
      if (!visible(n)) bits.push('hidden');
      return bits.length ? ' ' + bits.join(' ') : '';
    };
    const id = (n) => ' [' + n.id + ']';
    const layout = (n) => n.layoutMode && n.layoutMode !== 'NONE' ? (n.layoutMode === 'HORIZONTAL' ? ' row' : ' col') : '';
    const kind = (n) => ['FRAME', 'TEXT', 'INSTANCE', 'GROUP'].includes(n.type) ? '' : ' ' + n.type;

    const visit = async (n, depth, indent) => {
      if (more) return;
      const pad = '  '.repeat(indent);
      try {
        if (textsOnly) {
          if (n.type === 'TEXT') { if (n.characters.trim()) push(label(n) + q(n.characters)); return; }
          if (n.type === 'INSTANCE') { for (const t of textsIn(n)) if (!push(label(t) + q(t.characters))) return; return; }
          for (const c of ordered(n)) await visit(c, depth + 1, indent);
          return;
        }
        if (n.type === 'TEXT') {
          push(pad + label(n) + q(n.characters) + (detail ? await attrs(n) : ''));
          return;
        }
        if (n.type === 'INSTANCE') {
          const t = textsIn(n).map(x => label(x) + q(x.characters));
          push(pad + await component(n) + (t.length ? ' ' + t.join(' ') : '') + (detail ? await attrs(n) : '') + id(n));
          return; // the inside of an instance is the component's business
        }
        if (SHAPES.includes(n.type)) {
          if (detail) push(pad + n.name + ' ' + n.type + await attrs(n));
          return;
        }
        // compact: a wrapper with a generic name adds a level, not meaning
        if (!detail && depth > 0 && WRAPPER.test(n.name) && 'children' in n) {
          for (const c of ordered(n)) await visit(c, depth, indent);
          return;
        }
        const size = !detail && (depth === 0 || n.parent && n.parent.type === 'PAGE') && 'width' in n ? ' (' + Math.round(n.width) + 'x' + Math.round(n.height) + ')' : '';
        if (!push(pad + n.name + kind(n) + layout(n) + size + (detail ? await attrs(n) : '') + id(n))) return;
        if (!('children' in n)) return;
        const kids = detail ? n.children : ordered(n);
        if (depth >= maxDepth) {
          if (kids.length) push(pad + '  … ' + kids.length + ' more inside' + (detail ? '' : ': read ' + n.id));
          return;
        }
        for (const c of kids) { if (more) return; await visit(c, depth + 1, indent + 1); }
      } catch (e) {
        push(pad + n.name + ' ' + n.type);
      }
    };
    await visit(root, 0, 0);
    if (more) lines.push('… (cut at ' + maxLines + ' lines' + (detail ? '' : ': read a child id, or raise --max-lines') + ')');
    return lines.join('\\n');
  };

  // Detail outline, the summary render prints. Kept under its old name.
  H.describe = (root, maxDepth = 3, maxLines = 40) => H.outline(root, { detail: true, depth: maxDepth, maxLines });

  globalThis.__figHelpers = H;
  globalThis.$page = H.page; globalThis.$var = H.variable; globalThis.$bind = H.bind;
  globalThis.$style = H.style; globalThis.$component = H.component;
  globalThis.$instance = H.instance; globalThis.$fontSafe = H.fontSafe; globalThis.$describe = H.describe;
  globalThis.$outline = H.outline;
}
`;

// True when user eval code calls one of the helpers.
export const RESET_NOTES = 'globalThis.__figNotes = new Set(); if (globalThis.__figHelpers && globalThis.__figHelpers.resetCaches) globalThis.__figHelpers.resetCaches();';
export const READ_NOTES = 'return globalThis.__figNotes ? [...globalThis.__figNotes] : [];';

export function usesHelpers(code) {
  return /\$(page|var|bind|style|component|instance|fontSafe|describe)\s*\(/.test(code || '');
}
