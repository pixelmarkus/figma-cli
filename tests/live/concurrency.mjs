// Live check for several agents at once: N CLI processes render in parallel on
// two scratch pages, then the frames are checked for overlaps and for being on
// the page they asked for. Both pages are removed afterwards.
//   FIGMA_FILE="Scratch" node tests/live/concurrency.mjs [agents=8]
// Use a scratch file: it creates and deletes pages.
import { execFile, execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/index.js');
const AGENTS = parseInt(process.argv[2], 10) || 8;
const PAGES = ['figma-cli concurrency A', 'figma-cli concurrency B'];
const run = args => new Promise((resolve, reject) =>
  execFile('node', [CLI, ...args], { encoding: 'utf8' }, (err, out, errOut) => err ? reject(new Error(errOut || err.message)) : resolve(out)));
const evalJson = code => {
  const last = execFileSync('node', [CLI, 'eval', code], { encoding: 'utf8' }).trim().split('\n').filter(l => !l.startsWith('note:')).pop();
  try { return JSON.parse(last); } catch { return last; }
};
const ids = out => [...out.matchAll(/Rendered: (\d+:\d+)/g)].map(m => m[1]);

const startPage = evalJson('figma.currentPage.id');
const jobs = [];
for (let i = 0; i < AGENTS; i++) {
  const page = PAGES[i % 2];
  const kids = '<Frame w={60} h={24} bg="#3b82f6" />'.repeat(1 + (i % 4));
  const jsx = `<Frame name="agent ${i}" flex="row" gap={8} p={8} bg="#e5e7eb">${kids}<Icon name="lucide:star" size={16} /></Frame>`;
  const args = i % 3 === 2
    ? ['render-batch', JSON.stringify([jsx, jsx]), '--page', page]
    : ['render', jsx, '--page', page];
  jobs.push(run(args).then(out => ({ page, ids: ids(out) })));
}
const t0 = Date.now();
const done = await Promise.allSettled(jobs);
const ms = Date.now() - t0;

const failed = done.filter(d => d.status === 'rejected');
const made = done.filter(d => d.status === 'fulfilled').map(d => d.value);
const report = evalJson(`(async () => {
  await figma.loadAllPagesAsync();
  const want = ${JSON.stringify(made)};
  const out = { wrongPage: [], overlaps: [], missing: [] };
  for (const { page, ids } of want) for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n) { out.missing.push(id); continue; }
    if (n.parent.name !== page) out.wrongPage.push(n.name + ' on ' + n.parent.name);
  }
  for (const name of ${JSON.stringify(PAGES)}) {
    const p = figma.root.children.find(p => p.name === name);
    if (!p) continue;
    const ns = p.children;
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width) out.overlaps.push(a.name + ' / ' + b.name);
    }
  }
  out.currentPageUnchanged = figma.currentPage.id === ${JSON.stringify(startPage)};
  return out;
})()`);

// Clean up separately, so a cleanup problem never hides the result. Figma does
// not remove the page you are on, so step off a test page first.
const cleanup = evalJson(`(async () => {
  const test = ${JSON.stringify(PAGES)};
  if (test.includes(figma.currentPage.name)) await figma.setCurrentPageAsync(figma.root.children.find(p => !test.includes(p.name)));
  let removed = 0;
  for (const p of figma.root.children.filter(p => test.includes(p.name))) { p.remove(); removed++; }
  return { removed };
})()`);
if (!cleanup || typeof cleanup !== 'object') console.log('  ⚠ cleanup failed, remove the pages "' + PAGES.join('", "') + '" by hand: ' + String(cleanup).slice(0, 200));

if (!report || typeof report !== 'object') { console.log('✗ could not read the result back: ' + String(report).slice(0, 300)); process.exit(1); }
const ok = failed.length === 0 && !report.wrongPage.length && !report.overlaps.length && !report.missing.length && report.currentPageUnchanged;
console.log(`${AGENTS} parallel agents, ${made.reduce((n, m) => n + m.ids.length, 0)} frames in ${ms} ms`);
for (const f of failed) console.log('  ✗ command failed: ' + String(f.reason.message).split('\n')[0]);
for (const w of report.wrongPage) console.log('  ✗ wrong page: ' + w);
for (const o of report.overlaps) console.log('  ✗ overlap: ' + o);
for (const m of report.missing) console.log('  ✗ missing: ' + m);
if (!report.currentPageUnchanged) console.log('  ✗ a render switched the current page');
console.log(ok ? '✓ no overlaps, every frame on its page' : '✗ concurrency check failed');
process.exit(ok ? 0 : 1);
