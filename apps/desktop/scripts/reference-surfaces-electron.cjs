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
      while (!await read(fn)) { assert.ok(Date.now() < end, 'Expected reference state: ' + fn); await new Promise(done => setTimeout(done, 20)) }
    }
    const press = async keyCode => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await settle()
    }
    const frame = async file => { await settle(); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file }) }
    await win.loadURL(url); win.webContents.focus(); await read(() => document.fonts.ready)
    assert.equal(slice, 'goal-decision-details')
    await until(() => document.querySelector('[data-goal-detail-id="decision-goal"] .goals-activity'))
    for (const width of [1024, 390]) {
      win.setContentSize(width, 900); await settle()
      for (const mode of ['dark', 'light']) {
        await win.webContents.executeJavaScript(`window.referenceSurfaceFixture.theme('${mode}')`); await settle()
        if (!await read(() => document.querySelector('.goals-activity').open)) {
          await read(() => document.querySelector('.goals-activity > summary').focus()); await press('Enter')
        }
        for (const id of ['original-decision', 'unrecorded-reason']) {
          if (!await win.webContents.executeJavaScript(`document.querySelector('[data-decision-id="${id}"]').open`)) {
            await win.webContents.executeJavaScript(`document.querySelector('[data-decision-id="${id}"] > summary').focus()`); await press('Enter')
          }
        }
        await read(() => { document.querySelector('[data-decision-id="original-decision"] > summary').focus(); document.querySelector('.goals-activity').scrollIntoView({ block: 'end' }) })
        assert.equal(await read(() => document.querySelector('[data-decision-id="original-decision"]').textContent.includes('confirmed work and the unsent draft')), true)
        assert.equal(await read(() => document.querySelector('[data-decision-id="unrecorded-reason"]').textContent.includes('Unknown')), true)
        assert.equal(await read(() => document.documentElement.scrollWidth === innerWidth), true)
        assert.equal(await read(() => { const r=document.querySelector('[data-decision-id="original-decision"]').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight }), true)
        await frame(`${slice}-${mode}-${width}.png`)
        result.operations.push({ width, mode, actualAppGoalDetail: true, nativeKeyboardDisclosure: true, originalReason: true, unknownActor: true, withinViewport: true })
      }
    }
    await read(() => {
      const details=document.querySelector('[data-decision-id="original-decision"]'),r=document.createRange();r.selectNodeContents(details.querySelector('dd'))
      getSelection().removeAllRanges(); getSelection().addRange(r)
      window.referenceOriginalNode=details;window.referenceOriginalSelection=getSelection().toString();window.referenceSurfaceFixture.update()
    }); await settle()
    assert.equal(await read(() => document.querySelector('[data-decision-id="original-decision"]') === window.referenceOriginalNode), true)
    assert.equal(await read(() => getSelection().toString().length>0 && getSelection().toString() === window.referenceOriginalSelection), true)
    assert.equal(await read(() => document.querySelector('[data-decision-id="original-decision"]').open), true)
    await frame(`${slice}-reading-update-390.png`)
    await read(() => window.referenceSurfaceFixture.switchGoal()); await settle()
    assert.equal(await read(() => document.querySelector('[data-decision-id="original-decision"]').open), false)
    assert.equal(await read(() => document.querySelector('.goals-activity').open), false)
    result.operations.push({ originalNodeAndSelectionPreserved: true, changedGoalIsolated: true })
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
