// Commands: node-ops (extracted from index.js)
import chalk from 'chalk';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval
} from '../lib/cli-core.js';
import { HELPERS_SOURCE } from '../lib/figma-helpers.js';

// ============ READ ============
//
// The text an agent builds context from: copy in reading order, components
// with their variants, ids to act on (see __figHelpers.outline). Cheaper than
// a screenshot in tokens for what it says, and it needs no export, which in a
// heavy file can take Figma tens of seconds.

program
  .command('read [nodeId]')
  .description('Read a frame, page or selection as text: copy in reading order, components with variants, ids (no screenshot needed)')
  .option('-p, --page <name>', 'Read a page (its frames; --depth to go deeper)')
  .option('-s, --selection', 'Read the current selection')
  .option('-d, --depth <n>', 'How deep to go (default 12, a page 1)')
  .option('-l, --max-lines <n>', 'Stop after this many lines', '300')
  .option('-t, --texts', 'Only the copy, one text per line, in reading order')
  .option('-n, --names', 'Show each text layer\'s name before its copy (e.g. translation keys)')
  .option('--detail', 'Also sizes, layout, padding, fills and fonts (the format render prints)')
  .action(async (nodeId, options) => {
    await checkConnection();
    const opts = {
      detail: !!options.detail,
      textsOnly: !!options.texts,
      names: !!options.names,
      maxLines: Math.max(1, parseInt(options.maxLines) || 300),
    };
    const depth = options.depth !== undefined ? parseInt(options.depth) : null;
    const code = `(async () => {
      ${HELPERS_SOURCE}
      let roots;
      if (${JSON.stringify(nodeId || null)}) {
        const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId || '')});
        if (!n) return { error: 'Node not found: ' + ${JSON.stringify(nodeId || '')} };
        roots = [n];
      } else if (${JSON.stringify(options.page || null)}) {
        await figma.loadAllPagesAsync();
        const want = ${JSON.stringify(String(options.page || '').toLowerCase())};
        const p = figma.root.children.find(p => p.name.toLowerCase() === want)
          || figma.root.children.find(p => p.name.toLowerCase().includes(want));
        if (!p) return { error: 'No page matching "' + ${JSON.stringify(options.page || '')} + '". Pages: ' + figma.root.children.map(p => p.name).join(', ') };
        roots = [p];
      } else if (${!!options.selection} || figma.currentPage.selection.length) {
        roots = figma.currentPage.selection.slice();
        if (!roots.length) return { error: 'Nothing selected' };
      } else {
        roots = [figma.currentPage];
      }
      const out = [];
      for (const r of roots) {
        const depth = ${depth === null ? 'null' : depth};
        out.push(await globalThis.__figHelpers.outline(r, Object.assign(${JSON.stringify(opts)},
          depth !== null ? { depth } : (r.type === 'PAGE' ? { depth: 1 } : {}))));
      }
      return { text: out.join('\\n\\n') };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (r && r.error) { console.log(chalk.red('✗ ' + r.error)); process.exitCode = 1; return; }
      console.log(r && r.text !== undefined ? r.text : String(r));
    } catch (e) {
      console.log(chalk.red('✗ Read failed: ' + e.message));
      process.exitCode = 1;
    }
  });

// ============ NODE OPERATIONS ============
//
// Every subcommand here runs one `fastEval` against the daemon, in BOTH
// connection modes. They used to branch: Safe Mode ran a native implementation
// while Yolo Mode — the mode with the faster CDP connection — spawned
// `npx figma-use`, preceded by a `curl` subprocess just to detect which mode
// was active. Two implementations of each command, and the fast path took the
// slow one.

const node = program
  .command('node')
  .description('Node operations (tree, bindings, to-component)');

node
  .command('tree [nodeId]')
  .description('Show node tree structure')
  .option('-d, --depth <n>', 'Max depth', '3')
  .option('-l, --limit <n>', 'Max lines to print before truncating (0 = no cap)', '400')
  .action(async (nodeId, options) => {
    await checkConnection();

    const maxDepth = parseInt(options.depth) || 3;
    // A tree of a real design file runs to thousands of lines, and this output
    // usually lands in an AI's context. Cap it, and SAY how much was dropped —
    // a silently truncated tree reads as "that's the whole file".
    const limit = Math.max(0, parseInt(options.limit) || 0);

    const code = `(async () => {
      const maxDepth = ${maxDepth};
      const limit = ${limit};
      const targetId = ${nodeId ? JSON.stringify(nodeId) : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found: ' + targetId };

      const lines = [];
      let total = 0;
      function printNode(node, indent = 0, depth = 0) {
        if (depth > maxDepth) return;
        total++;
        if (!limit || lines.length < limit) {
          const size = node.width && node.height
            ? ' (' + Math.round(node.width) + 'x' + Math.round(node.height) + ')' : '';
          lines.push('  '.repeat(indent) + node.type + ': ' + node.name + size + ' [' + node.id + ']');
        }
        if ('children' in node && depth < maxDepth) {
          for (const c of node.children) printNode(c, indent + 1, depth + 1);
        }
      }
      printNode(root);
      return { text: lines.join('\\n'), shown: lines.length, total };
    })()`;

    try {
      const result = await fastEval(code);
      if (result?.error) {
        console.log(chalk.red('✗ ' + result.error));
        process.exitCode = 1;
        return;
      }
      console.log(result.text);
      if (result.total > result.shown) {
        console.log(chalk.yellow(
          `\n○ ${result.total - result.shown} more node(s) not shown (limit ${limit}). ` +
          `Use --limit 0 for all, or --depth to go shallower.`
        ));
      }
    } catch (e) {
      console.log(chalk.red('✗ Tree failed: ' + e.message));
      process.exitCode = 1;
    }
  });

node
  .command('bindings [nodeId]')
  .description('Show variable bindings for node')
  .action(async (nodeId) => {
    await checkConnection();

    // Native in both modes (see to-component below).
    const code = `(async () => {
      const targetId = ${nodeId ? JSON.stringify(nodeId) : 'null'};
      const nodes = targetId
        ? [await figma.getNodeByIdAsync(targetId)]
        : [...figma.currentPage.selection];

      if (!nodes.length || !nodes[0]) {
        return { error: targetId ? 'Node not found: ' + targetId : 'Nothing selected in Figma' };
      }

      // Resolve each variable id ONCE — a component's fills/strokes usually
      // point at the same handful of tokens.
      const nameCache = new Map();
      const nameOf = async (id) => {
        if (!nameCache.has(id)) {
          let name = id;
          try {
            const v = await figma.variables.getVariableByIdAsync(id);
            if (v) name = v.name;
          } catch (e) {}
          nameCache.set(id, name);
        }
        return nameCache.get(id);
      };

      const results = [];
      for (const node of nodes) {
        if (!node) continue;
        const bindings = {};
        for (const [prop, binding] of Object.entries(node.boundVariables || {})) {
          // Figma gives a single alias for scalar props and an ARRAY for
          // fills/strokes — reading only [0] hid every binding after the first.
          const list = Array.isArray(binding) ? binding : [binding];
          const names = [];
          for (const b of list) {
            if (b && b.id) names.push(await nameOf(b.id));
          }
          if (names.length) bindings[prop] = names;
        }
        results.push({ id: node.id, name: node.name, bindings });
      }
      return { results };
    })()`;

    try {
      const out = await fastEval(code);
      if (out?.error) {
        console.log(chalk.yellow('○ ' + out.error));
        return;
      }
      for (const r of out.results) {
        console.log(chalk.cyan(`\n${r.name} (${r.id}):`));
        const entries = Object.entries(r.bindings);
        if (!entries.length) {
          console.log(chalk.gray('  No variable bindings'));
          continue;
        }
        for (const [prop, names] of entries) {
          console.log(`  ${prop}: ${chalk.green(names.join(', '))}`);
        }
      }
    } catch (e) {
      console.log(chalk.red('✗ Bindings failed: ' + e.message));
      process.exitCode = 1;
    }
  });

node
  .command('to-component <nodeIds...>')
  .description('Convert frames to components')
  .action(async (nodeIds) => {
    await checkConnection();

    // One implementation, both modes. This used to spawn `npx figma-use` in
    // Yolo Mode (plus a `curl` subprocess just to detect the mode) while an
    // equivalent native version sat right here for Safe Mode — so the FASTER
    // connection took the SLOWER path. Since every component creation ends in
    // a to-component call, that spawn was on the hot path.
    const code = `(async () => {
      const ids = ${JSON.stringify(nodeIds)};
      const converted = [], skipped = [];
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node) { skipped.push({ id, why: 'no node with that id' }); continue; }
        if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
          skipped.push({ id, why: 'already a ' + node.type.toLowerCase(), name: node.name });
          continue;
        }
        try {
          const comp = figma.createComponentFromNode(node);
          converted.push({ id: comp.id, name: comp.name });
        } catch (e) {
          skipped.push({ id, why: e.message, name: node.name });
        }
      }
      return { converted, skipped };
    })()`;

    try {
      const result = await fastEval(code);
      for (const r of result?.converted || []) {
        console.log(chalk.green(`✓ Converted to component: ${r.id} (${r.name})`));
      }
      // Name what didn't convert and why, instead of exiting silently green.
      for (const s of result?.skipped || []) {
        console.log(chalk.yellow(`○ Skipped ${s.name ? `"${s.name}" ` : ''}${s.id}: ${s.why}`));
      }
      if (!result?.converted?.length && result?.skipped?.length) process.exitCode = 1;
    } catch (e) {
      console.log(chalk.red('✗ Convert failed: ' + e.message));
      process.exitCode = 1;
    }
  });

node
  .command('delete <nodeIds...>')
  .description('Delete nodes by ID')
  .action(async (nodeIds) => {
    await checkConnection();

    // Native in both modes (see to-component above).
    const code = `(async () => {
      const ids = ${JSON.stringify(nodeIds)};
      const deleted = [], missing = [];
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node) { missing.push(id); continue; }
        const name = node.name;
        node.remove();
        deleted.push({ id, name });
      }
      return { deleted, missing };
    })()`;

    try {
      const result = await fastEval(code);
      for (const d of result?.deleted || []) {
        console.log(chalk.green(`✓ Deleted ${d.id} ("${d.name}")`));
      }
      // Deleting is destructive: say exactly what went, and don't report a
      // silent success for ids that were never there.
      for (const id of result?.missing || []) {
        console.log(chalk.yellow(`○ Not found: ${id}`));
      }
      if (result?.missing?.length) process.exitCode = 1;
    } catch (e) {
      console.log(chalk.red('✗ Delete failed: ' + e.message));
      process.exitCode = 1;
    }
  });

