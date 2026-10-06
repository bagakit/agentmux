const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], operations: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1024, height: 900, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
    const read = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`)
    const settle = () => read(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const until = async fn => {
      const end = Date.now() + 10_000
      while (!await read(fn)) { assert.ok(Date.now() < end, 'Expected code state: ' + fn); await new Promise(done => setTimeout(done, 20)) }
    }
    const press = async keyCode => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await settle()
    }
    const focusCopy = () => read(() => document.querySelector('#message .md-code-toolbar__copy').focus({ preventScroll: true }))
    const focusRetained = () => read(() => document.activeElement === document.querySelector('#message .md-code-toolbar__copy'))
    const status = () => read(() => document.querySelector('#message .md-code-toolbar__copy [role=status]').textContent)
    const frame = async file => { await settle(); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file }) }
    await win.loadURL(url); win.webContents.focus()
    await until(() => document.querySelectorAll('.md-code-toolbar__copy').length === 3)
    await until(() => !!document.querySelector('#message .hljs-keyword'))
    await read(() => document.fonts.ready)
    assert.equal(await read(() => document.querySelector('#message pre code').textContent === window.codeCopyFixture.source), true)
    assert.equal(await read(() => document.querySelectorAll('#inert .md-code-toolbar__copy').length), 0)
    assert.equal(await read(() => getComputedStyle(document.querySelector('#document pre'), '::before').display), 'none')
    for (const width of [1024, 390]) {
      win.setContentSize(width, 900); await settle()
      for (const mode of ['dark', 'light']) {
        if (await read(() => document.documentElement.dataset.appearance) !== mode) await read(() => document.querySelector('nav button').click())
        await focusCopy()
        const before = await read(() => window.codeCopyFixture.attempts.length)
        await press('Enter'); await until(() => document.querySelector('#message [role=status]').textContent === 'Copying…')
        await press('Enter')
        assert.equal(await read(() => window.codeCopyFixture.attempts.length), before + 1)
        assert.equal(await focusRetained(), true)
        assert.equal(await read(() => window.codeCopyFixture.attempts.at(-1).text === window.codeCopyFixture.source), true)
        await read(() => window.codeCopyFixture.attempts.at(-1).resolve(true))
        await until(() => document.querySelector('#message [role=status]').textContent === 'Copied')
        assert.equal(await focusRetained(), true)
        assert.equal(await read(() => document.documentElement.scrollWidth === innerWidth), true)
        assert.equal(await read(() => { const pre = document.querySelector('#message pre'); return pre.scrollWidth > pre.clientWidth }), true)
        assert.equal(await read(() => {
          const toolbar = document.querySelector('#message .md-code-toolbar'), pre = document.querySelector('#message pre'), left = toolbar.getBoundingClientRect().left
          pre.scrollLeft = pre.scrollWidth; const unchanged = toolbar.getBoundingClientRect().left === left; pre.scrollLeft = 0; return unchanged
        }), true)
        await frame(`code-copy-${mode}-${width}.png`)
        result.operations.push({ width, mode, keyboardActivation: true, exactSource: true, duplicatePendingRejected: true, focusRetained: true, localCodeScroll: true })
      }
    }
    await focusCopy(); await press('Enter')
    assert.equal(await status(), 'Copying…'); assert.equal(await focusRetained(), true)
    await frame('code-copy-pending-390.png')
    await read(() => { const attempt = window.codeCopyFixture.attempts.at(-1); attempt.error(new Error('Controlled clipboard failure')); attempt.resolve(true) })
    await until(() => document.querySelector('#message [role=status]').textContent === 'Retry copy')
    assert.equal(await focusRetained(), true)
    await frame('code-copy-failure-390.png')
    await press('Enter'); assert.equal(await status(), 'Copying…')
    await read(() => window.codeCopyFixture.attempts.at(-1).resolve(true))
    await until(() => document.querySelector('#message [role=status]').textContent === 'Copied')
    assert.equal(await focusRetained(), true)
    result.operations.push({ consumer: 'failure, retry and keyboard continuation', retainedFocus: true, reportedErrorWinsOverTrue: true })
    assert.deepEqual(result.errors, [])
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
