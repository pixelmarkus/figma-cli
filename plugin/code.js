/**
 * Figma CLI Bridge Plugin
 *
 * Safe Mode: Connects to CLI daemon via WebSocket
 * No debug port needed, no patching required.
 */

// Menu: Connect (no window), Connect with status window, Disconnect. The
// right-panel "Reconnect figma-cli" button runs `reconnect`.
const COMMAND = figma.command || 'connect';
const STOPPING = COMMAND === 'disconnect';

if (STOPPING) {
  figma.closePlugin('figma-cli disconnected');
} else {
  // The WebSocket to the CLI lives in the UI iframe. Hidden, it keeps running
  // and messaging (figma.ui.hide docs), so nothing has to sit on the canvas.
  // Status comes as toasts; "Connect with status window" shows it.
  figma.showUI(__html__, {
    width: 160,
    height: 72,
    title: 'figma-cli',
    visible: COMMAND === 'status',
  });
  // One-click reconnect in the right panel (properties panel, nothing
  // selected). Relaunch data is stored in the file, so it shows on every
  // page. Design files only: FigJam has no document-level relaunch buttons.
  if (figma.editorType === 'figma') {
    try { figma.root.setRelaunchData({ reconnect: 'Restarts the figma-cli bridge (runs without a window)' }); } catch (e) {}
  }
}

// Execute code with auto-return and timeout protection
async function executeCode(code, timeoutMs = 25000) {
  let trimmed = code.trim();

  // Don't add return if code already starts with return
  if (!trimmed.startsWith('return ')) {
    const isSimpleExpr = !trimmed.includes(';');
    const isIIFE = trimmed.startsWith('(function') || trimmed.startsWith('(async function');
    const isArrowIIFE = trimmed.startsWith('(() =>') || trimmed.startsWith('(async () =>');

    if (isSimpleExpr || isIIFE || isArrowIIFE) {
      trimmed = `return ${trimmed}`;
    } else {
      const lastSemicolon = trimmed.lastIndexOf(';');
      if (lastSemicolon !== -1) {
        const beforeLast = trimmed.substring(0, lastSemicolon + 1);
        const lastStmt = trimmed.substring(lastSemicolon + 1).trim();
        if (lastStmt && !lastStmt.startsWith('return ')) {
          trimmed = beforeLast + ' return ' + lastStmt;
        }
      }
    }
  }

  // Figma's QuickJS sandbox blocks `new Function` / `new AsyncFunction`.
  // eval() runs in the plugin's main scope where `figma` is already global.
  const execPromise = eval(`(async () => { ${trimmed} })()`);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Execution timeout (${timeoutMs/1000}s)`)), timeoutMs)
  );

  return Promise.race([execPromise, timeoutPromise]);
}

// Toasts: a drop that reconnects within a few seconds (a heavy export
// starves the plugin) stays quiet; only a lasting drop is reported.
let everConnected = false;
let dropTimer = null;
const DROP_GRACE_MS = 4000;

// Handle messages from UI (WebSocket bridge)
if (!STOPPING) figma.ui.onmessage = async (msg) => {
  // Single eval
  if (msg.type === 'eval') {
    try {
      const result = await executeCode(msg.code);
      figma.ui.postMessage({ type: 'result', id: msg.id, result: result });
    } catch (error) {
      figma.ui.postMessage({ type: 'result', id: msg.id, error: error.message });
    }
  }

  // Batch eval (execute multiple codes in sequence, return all results)
  if (msg.type === 'eval-batch') {
    const results = [];
    for (const code of msg.codes) {
      try {
        const result = await executeCode(code);
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    figma.ui.postMessage({ type: 'batch-result', id: msg.id, results: results });
  }

  if (msg.type === 'connected') {
    const wasDropped = dropTimer === null && everConnected;
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
    if (!everConnected || wasDropped) figma.notify('✓ figma-cli connected', { timeout: 2000 });
    everConnected = true;
  }

  if (msg.type === 'disconnected') {
    if (!dropTimer && everConnected) {
      dropTimer = setTimeout(() => {
        // null again, so the next 'connected' says so
        dropTimer = null;
        figma.notify('figma-cli disconnected, reconnecting…', { timeout: 3000 });
      }, DROP_GRACE_MS);
    }
  }

  if (msg.type === 'error') {
    figma.notify('Figma DS CLI: ' + msg.message, { error: true });
  }
};

// Keep plugin alive
figma.on('close', () => {
  // Plugin closed
});

console.log('Figma DS CLI plugin started');
