const { app, BrowserWindow, WebContentsView } = require('electron')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const path = require('node:path')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', config.userData)
const owned = []
const windows = []
const result = { electron: process.versions.electron, cases: [], passed: false }
const deadline = setTimeout(() => { result.error = 'native deadline'; finish(1) }, 25000)
function finish(code) {
  clearTimeout(deadline)
  for (const contents of owned) if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
  for (const window of windows) if (!window.isDestroyed()) window.destroy()
  fs.writeFileSync(config.output, JSON.stringify(result, null, 2))
  app.exit(code)
}
app.whenReady().then(async () => {
  try {
    for (const item of config.cases) {
      const webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: true }
      const view = item.visible ? new BrowserWindow({ show: false, width: 800, height: 500, webPreferences }) : new WebContentsView({ webPreferences })
      if (item.visible) windows.push(view)
      const contents = view.webContents
      owned.push(contents)
      const row = { label: item.label, entry: item.entry, id: contents.id }
      result.cases.push(row)
      row.errors = []
      contents.on('console-message', (_event, _level, message) => { if (row.errors.length < 8) row.errors.push(String(message).slice(0, 2000)) })
      await contents.loadURL('data:text/html,<meta charset=utf-8><title>Private parser scheduler proof</title>')
      if (!item.visible) { view.setVisible(false); assert.equal(view.getVisible(), false) }
      else assert.equal(view.isVisible(), false, 'private page-visible window never shown or focused')
      assert.equal(contents.getBackgroundThrottling(), true)
      const library = fs.readFileSync(path.join(item.directory, 'lib', item.entry), 'utf8')
      if (item.entry.endsWith('.mjs')) await contents.executeJavaScript(`(async()=>{window.Terminal=(await import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(library).toString('base64'))})).Terminal})()`)
      else await contents.executeJavaScript(library)
      row.data = await contents.executeJavaScript(`(async () => {
        const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 100 });
        const waits = [], visibility = document.visibilityState;
        let callbackCount = 0, asyncCount = 0;
        try {
          for (let i = 0; i < 10; i++) {
            const start = performance.now();
            await new Promise(resolve => terminal.write(new Uint8Array([120,13,10]), () => { callbackCount++; resolve() }));
            waits.push(performance.now() - start);
          }
          const handler = terminal.parser.registerOscHandler(777, () => { asyncCount++; return new Promise(resolve => {
            const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(false) }; channel.port2.postMessage(0);
          }) });
          const utf8 = new TextEncoder().encode('\\x1b]777;probe\\x07\\x1b[31m中文🙂\\x1b[0m');
          const split = utf8.indexOf(0xe4) + 1;
          await new Promise(resolve => terminal.write(utf8.subarray(0, split), resolve));
          await new Promise(resolve => terminal.write(utf8.subarray(split), resolve));
          handler.dispose();
          const text = terminal.buffer.active.getLine(10).translateToString(true);
          const callbacks = [], opportunities = [], frames = [];
          let pulses = 0, maxGapMs = 0, last = performance.now(), done = false, frame;
          const pulse = new MessageChannel();
          pulse.port1.onmessage = () => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now-last); last = now; pulses++; if (opportunities.length < 512) opportunities.push(callbacks.length); if (!done) pulse.port2.postMessage(0) };
          const onFrame = () => { if (frames.length < 128) frames.push(callbacks.length); if (!done) frame = requestAnimationFrame(onFrame) };
          const burstStart = performance.now();
          const data = ('x'.repeat(78)+'\\r\\n').repeat(400);
          const count = ${item.burst ? 128 : 0};
          if (count) { pulse.port2.postMessage(0); frame = requestAnimationFrame(onFrame) }
          try {
            await Promise.all(Array.from({ length: count }, (_, index) => new Promise(resolve => terminal.write(new TextEncoder().encode(data+'end:'+index+'\\r\\n'), () => { callbacks.push(index); resolve() }))));
          } finally { done = true; maxGapMs = Math.max(maxGapMs, performance.now()-last); cancelAnimationFrame(frame); pulse.port1.close(); pulse.port2.close() }
          return { visibility, afterVisibility: document.visibilityState, waits, callbackCount, asyncCount, text,
            burst: { bytes: data.length*count, elapsedMs: performance.now()-burstStart, pulses, maxGapMs, callbacks, opportunities, frames,
              tail: count ? terminal.buffer.active.getLine(terminal.buffer.active.baseY+terminal.buffer.active.cursorY-1).translateToString(true) : null },
            grid: { cols: terminal.cols, rows: terminal.rows }, lines: terminal.buffer.active.length };
        } finally { terminal.dispose() }
      })()`)
      assert.equal(row.data.visibility, item.visible ? 'visible' : 'hidden')
      assert.equal(row.data.afterVisibility, item.visible ? 'visible' : 'hidden')
      assert.equal(row.data.callbackCount, 10)
      assert.equal(row.data.asyncCount, 1)
      assert.equal(row.data.text, '中文🙂')
      if (item.expectFast) assert.ok(Math.max(...row.data.waits.slice(6)) < 500, 'hidden parser callback avoids timer clamp')
      if (item.burst) {
        assert.deepEqual(row.data.burst.callbacks, Array.from({ length: 128 }, (_, i) => i))
        assert.ok(row.data.burst.pulses > 0, 'large parser burst gives another same-renderer task an opportunity')
        assert.ok(row.data.burst.opportunities.length > 0)
        assert.ok(row.data.burst.opportunities.some(completed => completed > 0 && completed < 128), 'another task runs during parsing, not just before the burst')
        assert.ok(row.data.burst.maxGapMs < 250, 'bounded same-renderer task gap in private parser load')
        assert.equal(row.data.burst.tail, 'end:127', 'actual terminal buffer preserves final output')
        if (item.visible) { assert.ok(row.data.burst.frames.length > 0); assert.ok(row.data.burst.frames.some(completed => completed > 0 && completed < 128), 'page-visible parser burst leaves a local frame opportunity') }
      }
      contents.close({ waitForBeforeUnload: false })
    }
    result.passed = true
    finish(0)
  } catch (error) { result.error = { name: error.name, message: error.message, stack: error.stack }; finish(1) }
})
