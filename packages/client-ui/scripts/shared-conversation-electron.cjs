const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.shared-conversation-electron-actual.v1', passed: false, frames: [], console: [], scope: 'Actual compiled Gallery and shared components; private Electron profile, no user Run or App lifecycle.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => {
      if (event.level === 'warning' || event.level === 'error') result.console.push({ level: event.level, message: event.message.slice(0, 2000) })
    })
    const read = source => win.webContents.executeJavaScript(source)
    const settle = () => read('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
    await win.loadURL(url)
    const end = Date.now() + 10_000
    while (!await read('!!document.querySelector("[data-agent-composer] .tiptap") && document.querySelectorAll(".log-turn").length >= 3')) {
      assert.ok(Date.now() < end, 'Real shared conversation and maintained editor must mount')
      await new Promise(done => setTimeout(done, 30))
    }
    await read('document.fonts.ready')
    for (const width of [1280, 390]) {
      win.setContentSize(width, 900)
      await settle()
      for (const [name, selector] of [['conversation', '.observation-sample--conversation'], ['composer', '#composer-details']]) {
        await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`)
        await settle()
        const actual = await read(`(() => {
          const host = document.querySelector(${JSON.stringify(selector)}), r = host.getBoundingClientRect();
          const editor = host.querySelector('.tiptap');
          return { viewport: innerWidth, section: { left:r.left, top:r.top, width:r.width, height:r.height },
            turns: [...host.querySelectorAll('.log-turn')].map(e => ({ role:e.dataset.speakerRole, direction:e.dataset.direction, text:e.querySelector('.log-turn__body')?.textContent, width:e.getBoundingClientRect().width })),
            editor: editor ? { text:editor.textContent, editable:editor.isContentEditable, width:editor.getBoundingClientRect().width } : null,
            buttons: [...host.querySelectorAll('button')].map(e => ({ name:e.getAttribute('aria-label') || e.title || e.textContent, disabled:e.disabled })) };
        })()`)
        assert.equal(actual.viewport, width)
        assert.ok(actual.section.width > 100 && actual.section.height > 50)
        if (name === 'conversation') { assert.equal(actual.turns.length, 3); assert.ok(actual.turns.every(turn => turn.text && turn.width > 100)) }
        else { assert.equal(actual.editor.editable, true); assert.ok(actual.editor.width > 100); assert.ok(actual.buttons.length > 0) }
        const file = `${name}-${width}.png`
        await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
        result.frames.push({ file, name, width, actual })
      }
    }
    assert.deepEqual(result.console.filter(entry => entry.level === 'error'), [], 'Actual Renderer emitted an error')
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
