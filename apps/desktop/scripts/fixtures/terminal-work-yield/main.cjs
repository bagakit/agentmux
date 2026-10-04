const { app, WebContentsView } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', config.userData)
const result = { electron: process.versions.electron, cases: [], passed: false, userRunTouched: false }
let view
const deadline = setTimeout(() => { result.error = { name: 'Timeout', message: 'native deadline' }; finish(1) }, 25000)
function finish(code) {
  clearTimeout(deadline)
  if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
  fs.writeFileSync(config.output, JSON.stringify(result, null, 2))
  app.exit(code)
}
app.whenReady().then(async () => {
  try {
    for (const item of config.cases) {
      view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: true } })
      const contents = view.webContents
      await contents.loadURL('data:text/html,<title>Private terminal continuation proof</title>')
      view.setVisible(false)
      assert.equal(view.getVisible(), false)
      assert.equal(contents.getBackgroundThrottling(), true)
      await contents.executeJavaScript(item.bundle)
      await contents.executeJavaScript(fs.readFileSync(config.xtermEntry, 'utf8'))
      const row = { label: item.label }
      result.cases.push(row)
      row.data = await contents.executeJavaScript(`(async () => {
        const visibility = document.visibilityState, waits = [];
        for (let i = 0; i < 10; i++) {
          const start = performance.now(); await Replay.yieldTerminalWork(); waits.push(performance.now() - start);
        }
        const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 100 });
        const writes = [], opportunities = [], pulse = new MessageChannel();
        pulse.port1.onmessage = () => opportunities.push(writes.length);
        const bytes = new TextEncoder().encode(('x'.repeat(78)+'\\r\\n').repeat(14000)+'\\x1b[31m中文🙂\\x1b[0m');
        const replayStart = performance.now();
        try {
          const cursor = await Replay.hydrateTerminalReplay([{ dataBytes: bytes, endByte: bytes.length }], data => {
            writes.push(data.length);
            if (writes.length === 1) pulse.port2.postMessage(null);
            return new Promise(resolve => terminal.write(data, resolve));
          });
          const text = terminal.buffer.active.getLine(terminal.buffer.active.baseY+terminal.buffer.active.cursorY).translateToString(true);
          return { visibility, afterVisibility: document.visibilityState, waits, writes, opportunities, cursor,
            bytes: bytes.length, replayMs: performance.now()-replayStart, text };
        } finally { pulse.port1.close(); pulse.port2.close(); terminal.dispose(); }
      })()`)
      const data = row.data
      assert.equal(data.visibility, 'hidden')
      assert.equal(data.afterVisibility, 'hidden')
      assert.equal(data.cursor, data.bytes)
      assert.equal(data.writes.reduce((sum, n) => sum + n, 0), data.bytes)
      assert.ok(data.writes.length > 2)
      assert.ok(data.writes.every(n => n > 0 && n <= 128 * 1024))
      assert.equal(data.text, '中文🙂')
      assert.ok(data.opportunities.some(n => n > 0 && n < data.writes.length), 'another renderer task runs during replay')
      if (item.expectFast) {
        assert.ok(Math.max(...data.waits.slice(6)) < 500, 'outer continuation avoids hidden timer clamp')
        assert.ok(data.replayMs < 2000, 'default replay continuation avoids per-batch timer waits')
      } else {
        assert.ok(Math.max(...data.waits.slice(6)) >= 500, 'baseline reproduces hidden timer clamp')
        // Patched xterm posts parser tasks, which can reset timer nesting. The helper-only
        // delay does not prove that this replay, or a user's slow Terminal, had the same delay.
      }
      contents.close({ waitForBeforeUnload: false })
    }
    result.passed = true
    finish(0)
  } catch (error) { result.error = { name: error.name, message: error.message, stack: error.stack }; finish(1) }
})
