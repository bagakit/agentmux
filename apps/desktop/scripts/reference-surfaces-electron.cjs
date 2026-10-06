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
    if (slice === 'goal-decision-details') {
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
    } else if (slice === 'component-gallery-inspection') {
      await until(() => document.querySelector('.wf-gallery__examples .observation-gallery'))
      const setWidth = value => win.webContents.executeJavaScript(`(() => { const select=document.querySelector('[aria-label="Preview width"]');select.value='${value}';select.dispatchEvent(new Event('change',{bubbles:true})) })()`)
      await read(() => { const button=document.querySelector('.wf-card button[aria-expanded]');window.referenceCardButton=button;button.focus() });await press('Enter')
      await read(() => { window.referenceExpanded=window.referenceCardButton.getAttribute('aria-expanded') })
      for (const width of [1024,390]) {
        win.setContentSize(width,900);await settle();await setWidth(width === 1024 ? '640' : '320');await settle()
        for (const mode of ['dark','light']) {
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.wf-gallery__theme button')).find(button => button.textContent === '${mode === 'dark' ? '深色' : '浅色'}').click()`);await settle()
          assert.equal(await read(() => document.documentElement.dataset.appearance),mode)
          assert.equal(await read(() => document.documentElement.scrollWidth === innerWidth),true)
          assert.equal(await read(() => { const r=document.querySelector('.wf-gallery__examples').getBoundingClientRect();return r.width<=innerWidth&&r.left>=0&&r.right<=innerWidth }),true)
          assert.equal(await read(() => document.querySelector('.wf-gallery__examples').contains(document.querySelector('.observation-gallery'))),true)
          assert.equal(await read(() => document.contains(window.referenceCardButton) && window.referenceCardButton.getAttribute('aria-expanded') === window.referenceExpanded),true)
          await read(() => { document.querySelector('.wf-gallery').scrollTop=0;document.querySelector('[aria-label="Preview width"]').focus({preventScroll:true}) })
          await frame(`${slice}-${mode}-${width}.png`)
          result.operations.push({width,mode,originalDeveloperEntry:true,originalExamples:true,availableWidth:true,expandedNodePreserved:true})
        }
      }
      await read(() => document.querySelector('.wf-gallery__inspect input').focus());await press('Space')
      assert.equal(await read(() => document.querySelector('.wf-gallery__examples').dataset.inspectBounds), 'true')
      await frame(`${slice}-boundaries-390.png`)
      await read(() => { document.querySelector('.wf-gallery__inspect button').focus();window.referenceExample=document.querySelector('.wf-gallery__examples') });await press('Enter')
      assert.equal(await read(() => document.querySelector('[aria-label="Preview width"]').value),'fit')
      assert.equal(await read(() => document.querySelector('.wf-gallery__examples').dataset.inspectBounds),'false')
      assert.equal(await read(() => window.referenceExample === document.querySelector('.wf-gallery__examples')),true)
      await read(() => document.querySelector('.observation-gallery').scrollIntoView({block:'start'}));await frame(`${slice}-observation-390.png`)
      result.operations.push({nativeBoundaryKeyboard:true,nativeResetKeyboard:true,resetKeepsOriginalExamples:true})
    } else throw new Error('Unknown original surface scene')
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
