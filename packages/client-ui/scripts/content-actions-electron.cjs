const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence, slice] = process.argv.slice(2)
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
      while (!await read(fn)) { assert.ok(Date.now() < end, 'Expected content state: ' + fn); await new Promise(done => setTimeout(done, 20)) }
    }
    const press = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await settle()
    }
    const frame = async file => { await settle(); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file }) }
    await win.loadURL(url); win.webContents.focus(); await read(() => document.fonts.ready)
    await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 2)
    assert.equal(await read(() => document.querySelectorAll('#disabled .composer-image__remove, #history .composer-image__remove').length), 0)
    for (const width of [1024, 390]) {
      win.setContentSize(width, 900); await settle()
      for (const mode of ['dark', 'light']) {
        if (await read(() => document.documentElement.dataset.appearance) !== mode) await read(() => document.querySelector('nav button').click())
        await read(() => document.querySelector('#draft .composer-image__remove').focus({ preventScroll: true }))
        const keysBefore = await read(() => window.contentActionsFixture.keyEvents.length)
        await press('Enter')
        assert.equal(await read(() => window.contentActionsFixture.keyEvents.length), keysBefore)
        assert.equal(await read(() => document.querySelectorAll('#draft .composer-image__remove').length), 1)
        assert.equal(await read(() => document.querySelector('#draft output').textContent === `Compare  with @${window.contentActionsFixture.path} before sending.`), true)
        assert.equal(await read(() => document.activeElement === document.querySelector('#draft .tiptap')), true)
        await press('z', process.platform === 'darwin' ? ['meta'] : ['control'])
        await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 2)
        assert.equal(await read(() => document.querySelector('#draft output').textContent === window.contentActionsFixture.initial), true)
        await press('z', process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift'])
        await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 1)
        await press('z', process.platform === 'darwin' ? ['meta'] : ['control'])
        await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 2)
        await read(() => document.querySelector('#draft .composer-image__remove').focus({ preventScroll: true }))
        assert.equal(await read(() => document.documentElement.scrollWidth === innerWidth), true)
        await frame(`${slice}-${mode}-${width}.png`)
        result.operations.push({ width, mode, exactDuplicateRemoval: true, draftPreserved: true, undoRedo: true, editorFocusRestored: true })
      }
    }
    await read(() => document.querySelector('#failed .composer-image__remove').focus({ preventScroll: true })); await press('Enter')
    assert.equal(await read(() => document.querySelector('#failed output').textContent), 'Keep the surrounding text  and continue.')
    result.operations.push({ failedReferenceRemovable: true })
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
