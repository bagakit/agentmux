const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, mode] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.disableHardwareAcceleration()
let win
const receipt = { passed: false, frames: [], console: [], boundary: 'Actual compiled App, WorkspaceWorkbench, shared loading surface and styles. Explicit preview spatial facts; no user profile, installed app or real Session/Run is controlled.' }
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, _level, message) => receipt.console.push(message.slice(0, 1200)))
    const read = code => win.webContents.executeJavaScript(code)
    await win.loadFile(html)
    const wait = async expression => {
      const end = Date.now() + 10000
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < end)
      throw new Error('Empty-workbench scene did not settle: ' + expression)
    }
    const settle = () => read('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await wait('window.emptyWorkbenchProof && document.querySelector(".workspace-workbench")')
    await settle()
    const facts = await read('window.emptyWorkbenchProof.facts()')
    assert.equal(facts.states.length, 1, 'One coherent state replaces the banner plus empty canvas')
    assert.equal(facts.states[0].title, 'Original work surface retained')
    assert.equal(facts.states[0].busy, 'false', 'Unconfirmed placement is not active loading')
    assert.match(facts.states[0].text, /no confirmed display occurrence/)
    assert.equal(facts.states[0].surface, true, 'Unconfirmed workface fills the available surface')
    assert.equal(facts.states[0].waiting, false, 'Unknown placement is not active loading')
    assert.equal(facts.tabsKept, true); assert.equal(facts.layoutsKept, true); assert.equal(facts.draftsKept, true)
    assert.deepEqual(facts.calls, [])
    if (mode === 'mutation') { receipt.passed = true; return }
    const capture = async file => {
      await settle()
      const image = await win.webContents.capturePage(); assert.equal(image.isEmpty(), false)
      await fs.writeFile(path.join(evidence, file), image.toPNG()); receipt.frames.push(file)
    }
    await capture('unknown-workspace-dark.png')
    const darkBackground = await read('getComputedStyle(document.querySelector(".service-window--surface .surface-state")).backgroundColor')
    await read('window.emptyWorkbenchProof.scenario("unknown-app", "light")'); await settle()
    assert.equal(await read('document.documentElement.dataset.appearance'), 'light', 'App uses the actual light preference')
    assert.notEqual(await read('getComputedStyle(document.querySelector(".service-window--surface .surface-state")).backgroundColor'), darkBackground, 'The work surface itself consumes light tokens')
    await capture('unknown-workspace-light.png')
    for (const [kind, width, height] of [['unknown', 360, 520], ['tab', 720, 520], ['region', 360, 520], ['empty', 900, 650], ['discussion', 360, 280]]) {
      win.setContentSize(width, height)
      await read(`window.emptyWorkbenchProof.scenario(${JSON.stringify(kind)})`); await settle()
      const state = await read('window.emptyWorkbenchProof.facts()')
      assert.equal(state.states.length, 1)
      assert.equal(state.states[0].busy, 'false')
      if (kind === 'tab' || kind === 'region') assert.equal(state.states[0].title, kind === 'tab' ? 'Original Tab retained' : 'Original Region retained')
      if (kind === 'empty' || kind === 'discussion') {
        const label = kind === 'empty' ? 'New Tab' : 'New discussion'
        const rect = await read(`(() => { const n=document.querySelector('[aria-label="${label}"]');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect })
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect })
        await settle()
        assert.deepEqual((await read('window.emptyWorkbenchProof.facts()')).calls.at(-1), { kind: 'create', groupId: 'original-group' })
      }
      const geometry = await read(`(() => {const n=document.querySelector('.workspace-workbench .surface-state--surface'), s=n.querySelector('.surface-state__content');return {overflow:n.scrollWidth-n.clientWidth,stageOverflow:s.scrollWidth-s.clientWidth}})()`)
      assert.ok(geometry.overflow <= 1 && geometry.stageOverflow <= 1, 'No horizontal overflow in narrow/short state')
      await capture(kind + '-' + width + '.png')
    }
    win.setContentSize(420, 280)
    await read('window.emptyWorkbenchProof.scenario("unknown")'); await settle()
    const short = await read(`(() => {const n=document.querySelector('.surface-state--surface');n.scrollTop=n.scrollHeight;return {overflow:n.scrollWidth-n.clientWidth,text:n.innerText}})()`)
    assert.ok(short.overflow <= 1)
    assert.match(short.text, /reopen the original work surface/)
    await capture('unknown-short.png')
    win.setContentSize(1280, 800)
    await read('window.emptyWorkbenchProof.scenario("with-body")'); await settle()
    await wait('document.querySelector(".launch-surface")')
    await read('window.emptyWorkbenchProof.unknownWithBody()'); await settle()
    const retained = await read('window.emptyWorkbenchProof.facts()')
    assert.ok(retained.states.length > 0)
    assert.ok(retained.states.every(state => state.className.includes('service-window--inline')), 'Existing body keeps its compact service notice')
    assert.equal(retained.launcher, true)
    assert.equal(retained.tabsKept, true); assert.equal(retained.layoutsKept, true); assert.equal(retained.draftsKept, true)
    await capture('retained-body-compact-notice.png')
    receipt.passed = true
  } catch (error) {
    receipt.failure = { message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'ui-receipt.json'), JSON.stringify(receipt, null, 2))
    app.exit(receipt.passed ? 0 : 1)
  }
})
