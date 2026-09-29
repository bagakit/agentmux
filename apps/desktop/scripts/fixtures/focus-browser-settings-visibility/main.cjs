const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, webContents } = require('electron')
const [html, privateRoot, evidence, nativeBundle, preload, page] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { passed: false, pid: process.pid, frames: [], phases: [], userAppRunRuntimeControlled: false,
  boundary: 'Compiled actual App/SurfaceSwitch/Workspace/Stable/BrowserPane; controlled Session references, isolated Focus destination/PTY paint/Settings content. Production native Browser manager and existing private native bridge; no full App package, actual healthy Run, restart, physical mouse or OS-composited screenshot claim.' }
const pause = ms => new Promise(done => setTimeout(done, ms))
let window, native
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ width: 960, height: 720, useContentSize: true, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    const { installMoteNative } = await import(pathToFileURL(nativeBundle).href)
    native = await installMoteNative({ window, privateRoot, evidence, phase: 'settings', fixturePage: page })
    const read = value => window.webContents.executeJavaScript(value)
    const until = async (label, predicate) => {
      const end = Date.now() + 12000
      do { if (await predicate()) return; await pause(30) } while (Date.now() < end)
      throw new Error('Private Browser Settings did not settle: ' + label)
    }
    const owners = () => native.owners().browsers
    const background = () => owners().find(item => item.browserId === 'background-browser')
    const mote = () => owners().find(item => item.browserId === 'foreground-mote-browser')
    const contents = owner => webContents.fromId(owner.webContentsId)
    const state = owner => contents(owner).executeJavaScript(`(()=>{const e=document.getElementById('native-proof-editor');return {draft:e.value,start:e.selectionStart,end:e.selectionEnd,scrollX,scrollY,url:location.href}})()`)
    await window.loadFile(html)
    window.showInactive()
    window.webContents.debugger.attach('1.3')
    await until('original real Browser drawn', () => background()?.drawn && background().bounds.width > 0)
    await read('window.browserSettingsProof.captureOriginal()')
    const original = background()
    await contents(original).executeJavaScript(`(()=>{const e=document.getElementById('native-proof-editor');e.value='Original page draft and selection';e.setSelectionRange(4,16);document.body.style.minHeight='1800px';scrollTo(0,120)})()`)
    const beforeCalls = native.receipt.bindings.length
    for (const width of [960, 640]) {
      window.setContentSize(width, 720)
      await pause(150)
      // Resizing legitimately reflows the real page and may move its scroll anchor.
      // Compare Settings against the immediately preceding same-viewport state.
      const pageBefore = await state(original)
      const control = await read(`(()=>{const e=document.querySelector('button[aria-label="Settings"]'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,nonempty:r.width>0&&r.height>0,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===e}})()`)
      assert.ok(control.nonempty && control.hit, 'Actual Settings center hits the original SurfaceSwitch control')
      const click = async () => { for (const type of ['mousePressed','mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: control.x, y: control.y, button: 'left', clickCount: 1 }) }
      await click()
      await until('background actual native View hidden', async () => (await read('window.browserSettingsProof.facts().settings')) && background()?.drawn === false)
      await pause(150)
      const settings = await read(`(()=>{const e=document.querySelector('[data-fixture-settings]'),r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {nonempty:r.width>0&&r.height>0,x,y,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},hit:e.contains(document.elementFromPoint(x,y)),originalOverlayClasses:e.classList.contains('settings-page')&&Boolean(e.querySelector('.settings-content'))}})()`)
      assert.ok(settings.nonempty && settings.hit && settings.originalOverlayClasses, 'Actual Settings overlay center is visible and hit, not an off-screen isolated content stub')
      assert.equal(background().drawn, false, 'Late geometry cannot resurrect covered View')
      assert.equal(background().webContentsId, original.webContentsId)
      assert.deepEqual(await state(background()), pageBefore, 'Native draft, selection, scroll and URL remain unchanged')
      await read('window.browserSettingsProof.openMote()')
      await until('other Tab foreground Mote drawn', async () => (await read('window.browserSettingsProof.facts().moteOpen')) && mote()?.drawn)
      await until('existing native Mote chrome/input ready', () => {
        const chrome = native.owners().chrome
        return chrome.length > 0 && chrome.every(owner => owner.interactive)
      })
      const moteBefore = mote()
      const foregroundInput = await native.verifyPageInput('foreground-mote-browser', 'foreground-mote-' + width)
      assert.equal(foregroundInput.passed, true, 'Other-Tab Mote receives trusted actual native input above Settings')
      assert.equal(background().drawn, false)
      const file = 'settings-' + width + '.png'
      await fs.writeFile(path.join(evidence, file), (await window.webContents.capturePage()).toPNG())
      receipt.frames.push({ file, width, source: 'renderer-webcontents-excludes-native-views' })
      const foregroundFile = 'foreground-' + width + '.png'
      await fs.writeFile(path.join(evidence, foregroundFile), (await contents(mote()).capturePage()).toPNG())
      receipt.frames.push({ file: foregroundFile, width: mote().bounds.width, source: 'original-native-page-separate-not-composite' })
      const beforeReturn = { native: native.owners(), facts: await read('window.browserSettingsProof.facts()') }
      await click()
      await until('return original background native View', () => background()?.drawn)
      assert.equal(background().webContentsId, original.webContentsId)
      assert.equal(mote().webContentsId, moteBefore.webContentsId)
      // The trusted click is outside the actual automatic popover and may
      // explicitly dismiss Mote. That later user intent is not Settings hiding it.
      assert.deepEqual(await state(background()), pageBefore)
      const facts = await read('window.browserSettingsProof.facts()')
      for (const field of ['sameStage','sameHost','sameParent','sameTabs','sameLayouts','sameSessions','sameDrafts']) assert.equal(facts[field], true, field)
      const restoredFile = 'returned-' + width + '.png'
      await fs.writeFile(path.join(evidence, restoredFile), (await window.webContents.capturePage()).toPNG())
      receipt.frames.push({ file: restoredFile, width, source: 'renderer-webcontents-excludes-native-views' })
      receipt.phases.push({ width, control, settings, original, beforeReturn, explicitOutsideReturnMayDismissMote: true, hiddenAndReturnedSameId: background().webContentsId,
        mote: mote(), pageBefore, pageAfter: await state(background()), facts, foregroundInput })
    }
    assert.equal(native.receipt.bindings.length, beforeCalls, 'Settings does not recreate or restore a native Browser')
    receipt.bounds = native.receipt.bounds
    assert.ok(receipt.bounds.some(item => item.browserId === 'background-browser' && item.bounds === null), 'Real BrowserPane delivers null through existing native bridge')
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    if (window && !window.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await window.webContents.capturePage()).toPNG())
  } finally {
    if (native) await native.dispose()
    await fs.writeFile(path.join(evidence, 'native-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(receipt.passed ? 0 : 1)
  }
})
