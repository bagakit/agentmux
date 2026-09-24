const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, phase, frames: [], userRunTouched: false,
  boundary: 'Complete production App and ordinary persistence/initialize in isolated Chromium profile. Session snapshots, attachment and recovery are controlled public API facts; no actual Core/ctxmux Run survival claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    await win.loadFile(html, { query: { phase } })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const deadline = Date.now() + 10000
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < deadline)
      throw new Error(`Mote proof did not settle: ${expression}`)
    }
    const facts = () => read('window.moteProof.facts()')
    await until('window.moteProof?.ready && !!document.querySelector("[data-pmo-teams-topic-launcher] button")')
    win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const entry = 'document.querySelector("[data-pmo-teams-topic-launcher] button")'
    const panel = 'document.getElementById("pmo-teams-topic-floating-panel")'
    const pointFor = expression => read(`(()=>{const e=${expression};if(!e)throw new Error('Missing observed control');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    const click = async expression => {
      const point = await pointFor(expression)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    const painted = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const capture = async name => {
      await until('!document.querySelector(".pmo-teams-topic-floating--opening")')
      await painted()
      const file = `${phase}-${name}.png`
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push({ name, file })
    }
    const sameTarget = current => {
      assert.equal(current.floating.targetTabId, 'mote-primary-tab', 'All opens retain the original explicitly chosen current Tab')
      assert.equal(current.ui.entryTarget, 'mote-primary-tab', 'Footer target agrees with the actual panel target')
      assert.equal(current.ui.panelTarget, current.ui.entryTarget)
      assert.equal(current.ui.expanded, 'true')
      assert.equal(current.ui.panelVisible, true)
      assert.equal(current.ui.globalChrome, 0, 'Projection cannot inherit Goals/Focus global chrome')
      assert.match(current.ui.title, /Keep the (same|original) workspace/)
      assert.match(current.ui.entryTitle, /Keep the (same|original) workspace/)
      assert.equal(current.ui.footerHeight, 32)
      assert.equal(current.ui.actions.length, 2)
      for (const action of current.ui.actions) {
        assert.ok(action.width >= 20 && action.height >= 20, 'Original actions retain real hit areas')
        assert.ok(action.right <= win.getContentBounds().width && action.bottom <= win.getContentBounds().height, 'Actions remain visible')
      }
      assert.deepEqual([...current.ui.regions].sort(), ['mote-neighbor-region', 'mote-primary-region', 'original-reader-region', 'original-worker-region'], 'The complete nonempty original workface remains rendered')
      assert.equal(new Set(current.ui.regions).size, current.ui.regions.length, 'Each original Region has one View owner')
      assert.deepEqual(current.calls.filter(call => !['attach', 'recover'].includes(call.operation)), [], 'Shortcut must not submit, launch or stop a Run')
    }
    result.initial = await facts()
    assert.deepEqual(Object.keys(result.initial.tabs).sort(), ['mote-neighbor-tab', 'mote-primary-tab', 'original-project-tab'])
    assert.equal(result.initial.drafts['project-worker'], 'Original project draft stays unsent')
    assert.equal(result.initial.drafts['mote-primary'], 'Keep my original Mote draft')
    if (phase === 'seed') {
      assert.equal(result.initial.mainSurface, 'board')
      assert.equal(result.initial.ui.expanded, 'false')
      await capture('wide-closed')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await pointFor(entry) })
      await until('!!document.querySelector(".mote-shortcut-preview")')
      const preview = await read('document.querySelector(".mote-shortcut-preview").textContent')
      assert.match(preview, /Keep the same workspace/)
      assert.match(preview, /Working/)
      assert.doesNotMatch(preview, /Needs reply/)
      await capture('wide-hover')
      await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 200 })
      await until('!document.querySelector(".mote-shortcut-preview")')
      await click(entry)
      await until(`${panel}?.getAttribute('aria-hidden')==='false' && ${panel}.dataset.moteTargetTab==='mote-primary-tab'`)
      let current = await facts(); sameTarget(current)
      assert.match(current.ui.entryTitle, /Working/)
      assert.doesNotMatch(current.ui.entryTitle, /Needs (you|reply)/)
      assert.equal(current.activeWorkspaceId, result.initial.activeWorkspaceId)
      assert.equal(current.mainSurface, result.initial.mainSurface)
      assert.deepEqual(current.focus.execution, result.initial.focus.execution)
      await capture('wide-working')
      // Real close/open controls must ignore a background PMO-focus change.
      await click(entry); await until(`${entry}.getAttribute('aria-expanded')==='false'`)
      assert.equal((await facts()).floating.targetTabId, 'mote-primary-tab')
      await read('window.moteProof.background()')
      await click(entry); await until(`${entry}.getAttribute('aria-expanded')==='true'`)
      sameTarget(await facts())
      const beforeChoice = await facts()
      await click(`${panel}.querySelector('button[data-workbench-tab-id="mote-neighbor-tab"]')`)
      await until(`${entry}.dataset.moteTargetTab==='mote-neighbor-tab' && ${panel}.dataset.moteTargetSession==='mote-neighbor'`)
      let selected = await facts()
      assert.equal(selected.floating.targetTabId, 'mote-neighbor-tab')
      assert.match(selected.ui.entryTitle, /Another goal waiting for permission.*Needs reply/)
      assert.match(selected.ui.title, /Another goal waiting for permission.*Needs reply/)
      assert.deepEqual(selected.focus.execution, beforeChoice.focus.execution)
      assert.equal(selected.mainSurface, beforeChoice.mainSurface)
      assert.equal(selected.activeWorkspaceId, beforeChoice.activeWorkspaceId)
      assert.deepEqual(selected.drafts, beforeChoice.drafts)
      await capture('wide-selected-neighbor')
      await click(entry); await until(`${entry}.getAttribute('aria-expanded')==='false'`)
      await click(entry); await until(`${entry}.getAttribute('aria-expanded')==='true'`)
      assert.equal((await facts()).ui.panelTarget, 'mote-neighbor-tab')
      await click(`${panel}.querySelector('button[data-workbench-tab-id="mote-primary-tab"]')`)
      await until(`${entry}.dataset.moteTargetTab==='mote-primary-tab'`)
      sameTarget(await facts())
      // A long Goal title and late Session facts are controlled inputs, not a second UI.
      await read('window.moteProof.longName()')
      win.setContentSize(640, 680)
      await until('innerWidth===640 && document.getElementById("pmo-teams-topic-floating-panel").getBoundingClientRect().right<=640')
      sameTarget(await facts()); await capture('narrow-long-goal')
      await read('window.moteProof.status("disconnected")')
      await until(`${entry}.title && !/Working/.test(${entry}.title)`)
      current = await facts(); sameTarget(current)
      assert.doesNotMatch(current.ui.entryTitle, /Working/)
      await capture('narrow-disconnected')
      await read('window.moteProof.pending()')
      await until(`!${panel}.dataset.moteTargetSession || /restor|unknown|unavailable|waiting/i.test(${panel}.dataset.moteStatus)`)
      current = await facts(); sameTarget(current)
      assert.doesNotMatch(current.ui.entryTitle, /Working|Needs (you|reply)/)
      assert.equal(current.drafts['mote-primary'], 'Keep my original Mote draft')
      await capture('narrow-restoring')
      await read('window.moteProof.restoreFacts()')
      await until(`${panel}.dataset.moteTargetSession==='mote-primary'`)
      await capture('narrow-restored')
      const beforeFull = await facts()
      await click(`${panel}.querySelector('button[aria-label="Open Mote Space"]')`)
      await until(`${entry}.getAttribute('aria-expanded')==='false' && window.moteProof.facts().mainSurface==='workbench'`)
      current = await facts()
      assert.equal(current.activeWorkspaceId, '__scratch__')
      assert.equal(current.layouts.__scratch__.groups.find(group=>group.id===current.layouts.__scratch__.activeGroupId).activeTabId, 'mote-primary-tab')
      assert.deepEqual(current.focus.execution, beforeFull.focus.execution)
      assert.deepEqual(current.layouts['private-project'], beforeFull.layouts['private-project'])
      assert.deepEqual(current.tabs, beforeFull.tabs)
      assert.deepEqual(current.runs, beforeFull.runs)
      assert.deepEqual(current.drafts, beforeFull.drafts)
      assert.ok(await read('!!document.querySelector(".top-row-leading-chrome")'), 'The window owner retains normal global chrome')
      win.setContentSize(1100, 760)
      await until('innerWidth===1100')
      await capture('wide-full-space')
      await click(`document.querySelector('button[aria-label^="Goals:"]')`)
      await click(entry); await until(`${entry}.getAttribute('aria-expanded')==='true'`)
      sameTarget(await facts()); await capture('wide-long-goal')
    } else {
      await until(`${panel}?.getAttribute('aria-hidden')==='false' && ${panel}.dataset.moteTargetTab==='mote-primary-tab'`)
      const prior = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).final
      const restored = await facts(); sameTarget(restored)
      for (const key of ['tabs', 'layouts', 'activeWorkspaceId', 'mainSurface', 'drafts']) assert.deepEqual(restored[key], prior[key], `Ordinary process restart preserves ${key}`)
      assert.deepEqual(restored.focus.execution, prior.focus.execution)
      for (const key of ['targetTabId', 'position', 'size']) assert.deepEqual(restored.floating[key], prior.floating[key], `Floating ${key} survives actual process restart`)
      await until('window.moteProof.facts().calls.some(call=>call.operation==="recover" && call.sessionId==="mote-primary" && call.runId==="original-run-mote-primary")')
      assert.deepEqual((await facts()).calls.filter(call=>call.operation==='recover'), [{ operation: 'recover', sessionId: 'mote-primary', runId: 'original-run-mote-primary' }])
      assert.deepEqual(restored.runs, prior.runs, 'The same public Run identities remain; no new Session is fabricated')
      await capture('wide-restarted')
    }
    result.final = await facts(); sameTarget(result.final)
    assert.equal(result.final.tabs['original-project-tab'].layout.root.ratio, 0.63)
    assert.equal(result.final.tabs['original-project-tab'].layout.activeRegionId, result.initial.tabs['original-project-tab'].layout.activeRegionId)
    await until(`(()=>{const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1'))?.state;
      const current=window.moteProof.facts();return !!state?.restoredWorkbench?.tabs['mote-primary-tab'] &&
      state.restoredWorkbench.tabs['mote-primary-tab'].name===current.tabs['mote-primary-tab'].name &&
      JSON.stringify(state.restoredWorkbench.layouts)===JSON.stringify(current.layouts) &&
      JSON.stringify(state.agentComposerDrafts)===JSON.stringify(current.drafts) &&
      state.activeWorkspaceId===current.activeWorkspaceId && state.mainSurface===current.mainSurface &&
      JSON.stringify(state.agentFocus.execution)===JSON.stringify(current.focus.execution)})()`)
    await win.webContents.session.flushStorageData()
    result.durable = await read('JSON.parse(localStorage.getItem("agentmux-workbench-v1"))')
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.observation = await win.webContents.executeJavaScript('({setup: window.moteSetup, body: document.body.innerText, proofPresent: !!window.moteProof})').catch(failed => ({ error: failed.message }))
  }
  finally {
    await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
