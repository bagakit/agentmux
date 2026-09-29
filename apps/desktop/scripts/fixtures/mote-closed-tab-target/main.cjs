const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, phase, frames: [], userRunTouched: false,
  boundary: 'Complete production App and real ordinary durable initialization; controlled public Session/API facts only. No Native Browser, Core/ctxmux or actual CLI survival claim.' }
app.on('window-all-closed', () => { result.unexpectedWindowClosure = { step: result.step }; result.passed = false })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
const bounded = async (work, label, budget = 12000) => {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Private close proof timeout: ' + label)), budget) })]) }
  finally { clearTimeout(timer) }
}
app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write('Renderer: ' + message + '\n') })
    result.step = 'load-complete-production-App'
    await bounded(win.loadFile(html, { query: { phase } }), result.step)
    const read = expression => bounded(win.webContents.executeJavaScript(expression), 'Renderer observation')
    const until = async expression => {
      const deadline = Date.now() + 10000
      do { if (await read(expression)) return; await pause(25) } while (Date.now() < deadline)
      throw new Error('Private close proof did not settle: ' + expression)
    }
    const facts = () => read('window.closedTabProof.facts()')
    await until('window.closedTabProof?.ready && !!document.querySelector("[data-pmo-teams-topic-launcher] button")')
    win.showInactive(); win.webContents.debugger.attach('1.3')
    const input = (method, params) => bounded(win.webContents.debugger.sendCommand(method, params), 'Original Renderer input')
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const panel = 'document.getElementById("pmo-teams-topic-floating-panel")'
    const entry = 'document.querySelector("[data-pmo-teams-topic-launcher] button")'
    const click = async expression => {
      const point = await read('(()=>{const e=' + expression + ';if(!e)throw new Error(' + JSON.stringify('Missing real control: ' + expression) + ');const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)throw new Error("Empty real control");return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    const capture = async name => {
      if (process.env.MOTE_CLOSED_TAB_AFFECTED_EMPTY_ONLY === '1' && !name.includes('empty')) return
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const file = phase + '-' + name + '.png'
      await fs.writeFile(path.join(evidence, file), (await bounded(win.webContents.capturePage(), 'Renderer capture')).toPNG())
      result.frames.push({ name, file, source: 'original-renderer-no-native-browser-claim' })
    }
    const visible = async (topic, tab) => {
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.moteTargetTopic===' + JSON.stringify(topic) + ' && (' + panel + '.dataset.moteTargetTab??null)===' + JSON.stringify(tab))
      const current = await facts()
      assert.equal(current.floating.targetTopicId, topic); assert.equal(current.floating.targetTabId, tab)
      assert.ok(current.ui.visible)
      return current
    }
    const choose = async (topic, tab) => {
      await click(panel + '.querySelector(' + JSON.stringify('[data-mote-topic-id="' + topic + '"]') + ')')
      return visible(topic, tab)
    }
    const keepClose = async id => {
      assert.ok((await facts()).tabs[id], 'Real nonempty original Tab exists before closing')
      await click(panel + '.querySelector(' + JSON.stringify('button[data-workbench-tab-id="' + id + '"] .workbench-tab__close') + ')')
      await until('[...document.querySelectorAll("[role=dialog] button")].some(e=>e.textContent==="Keep Session & Close")')
      await click('[...document.querySelectorAll("[role=dialog] button")].find(e=>e.textContent==="Keep Session & Close")')
      await until('!window.closedTabProof.facts().tabs[' + JSON.stringify(id) + ']')
      if (!await read(panel + '?.matches(":popover-open")')) {
        // The existing window-level confirmation portal light-dismisses the native auto popover.
        // Reopen through the real original footer; never seed or change its repaired target.
        ;(result.reopenedAfterConfirmation ??= []).push({ closedTabId: id, repairedBeforeReopen: (await facts()).floating })
        await click(entry)
      }
    }
    const forbidden = current => current.calls.filter(call => ['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt'].includes(call.operation))
    result.initial = await facts()
    assert.equal(result.initial.initialization.initializeCalls, 1)
    if (phase === 'seed') {
      assert.equal(result.initial.initialization.seedApplied, true)
      assert.deepEqual(Object.keys(result.initial.tabs).sort(), ['custom-mote-tab', 'mote-neighbor-tab', 'mote-primary-tab', 'original-project-tab'])
      await visible('launcher:leader', 'mote-primary-tab')
      result.step = 'actual-selected-keep-close-continues-original-neighbor'
      await keepClose('mote-primary-tab')
      result.remaining = await visible('launcher:leader', 'mote-neighbor-tab')
      assert.deepEqual(result.remaining.tabs['mote-neighbor-tab'], result.initial.tabs['mote-neighbor-tab'])
      assert.ok(!result.remaining.ui.text.includes('Original Tab retained'))
      assert.deepEqual(forbidden(result.remaining), [])
      await capture('wide-original-remaining-tab')
      result.step = 'actual-last-keep-close-persists-actionable-empty-topic'
      await choose('launcher:reviewer', 'custom-mote-tab')
      await keepClose('custom-mote-tab')
      result.empty = await visible('launcher:reviewer', null)
      assert.ok(result.empty.ui.newTab, 'Empty Topic exposes a real New Tab action')
      assert.ok(!result.empty.ui.text.includes('Original Tab retained'))
      await capture('wide-empty-topic')
      await choose('launcher:leader', 'mote-neighbor-tab')
      await choose('launcher:reviewer', null)
      win.setContentSize(640, 680)
      await until('innerWidth===640'); await capture('narrow-empty-topic')
      await click(panel + '.querySelector("button[aria-label=\'Open Mote Space\']")')
      await until('!' + panel + '?.matches(":popover-open") && window.closedTabProof.facts().mainSurface==="workbench"')
      const inSpace = await facts()
      assert.equal(inSpace.selection.topicId, 'launcher:reviewer'); assert.equal(inSpace.selection.tabId, null)
      assert.deepEqual(inSpace.tabs, result.empty.tabs, 'Open Space retains the empty Topic without creating a launcher')
      result.emptySpaceDom = await read(`(()=>{const e=document.querySelector('[data-mote-empty-space="launcher:reviewer"]');const b=e?.querySelector('[aria-label="New Tab"]');const r=b?.getBoundingClientRect();const hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;return{title:e?.textContent,status:e?.querySelector('[role="status"]')?.textContent,buttonText:b?.textContent,width:r?.width,height:r?.height,centerHitsButton:!!b&&!!hit&&(hit===b||b.contains(hit))}})()`)
      assert.ok(result.emptySpaceDom.title?.includes('Review the next step'), 'Real Space displays the selected Topic identity')
      assert.equal(result.emptySpaceDom.status, 'No Tab in this context')
      assert.ok(result.emptySpaceDom.buttonText?.includes('New Tab'))
      assert.ok(result.emptySpaceDom.width > 0 && result.emptySpaceDom.height > 0 && result.emptySpaceDom.centerHitsButton, 'Original New Tab button is visibly reachable')
      await capture('narrow-empty-full-space')
      // Reopen the original owner after navigation, then leave an explicit durable empty target.
      await click(entry); await visible('launcher:reviewer', null)
      win.setContentSize(1100, 760); await until('innerWidth===1100')
      result.final = await visible('launcher:reviewer', null)
    } else {
      result.step = 'second-real-process-ordinary-durable-restore'
      const prior = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).final
      const initial = await visible('launcher:reviewer', null)
      assert.equal(initial.initialization.seedApplied, false, 'Restore does not seed after hydration')
      assert.ok(initial.initialization.initialDurable?.state.restoredWorkbench, 'Second process really reads durable workbench')
      assert.equal(initial.initialization.initialFloating.targetTabId, null)
      assert.deepEqual(initial.initialization.afterOrdinaryInitialize.tabIds.sort(), Object.keys(prior.tabs).sort())
      for (const key of ['tabs', 'layouts', 'drafts', 'outbox', 'viewModes', 'activeWorkspaceId', 'mainSurface']) assert.deepEqual(initial[key], prior[key], 'Ordinary restart retains ' + key)
      assert.deepEqual(initial.focus.execution, prior.focus.execution)
      assert.deepEqual(initial.runs, prior.runs)
      assert.deepEqual(initial.calls.filter(call => call.operation === 'recover').sort((a,b)=>a.sessionId.localeCompare(b.sessionId)), [
        { operation: 'recover', sessionId: 'mote-neighbor', runId: 'original-run-mote-neighbor' },
        { operation: 'recover', sessionId: 'project-worker', runId: 'original-run-project-worker' }
      ])
      await capture('wide-restarted-empty-topic')
      const neighbor = await choose('launcher:leader', 'mote-neighbor-tab')
      assert.deepEqual(neighbor.tabs['mote-neighbor-tab'], prior.tabs['mote-neighbor-tab'])
      await until('window.closedTabProof.facts().calls.some(c=>c.operation==="attach"&&c.sessionId==="mote-neighbor"&&c.runId==="original-run-mote-neighbor")')
      await capture('wide-restarted-original-remaining-tab')
      result.step = 'exact-never-closed-missing-reference-recovery-control'
      const beforeUnknown = await facts()
      await read('window.closedTabProof.showUnknown()')
      result.unknown = await visible('launcher:leader', 'saved-unavailable-tab')
      assert.ok(result.unknown.ui.text.includes('Original Tab retained'))
      assert.deepEqual(result.unknown.tabs, beforeUnknown.tabs)
      assert.deepEqual(result.unknown.drafts, beforeUnknown.drafts)
      assert.deepEqual(result.unknown.focus.execution, beforeUnknown.focus.execution)
      await capture('wide-unknown-exact-reference')
      result.final = await choose('launcher:reviewer', null)
    }
    assert.deepEqual(result.final.tabs['original-project-tab'], result.initial.tabs['original-project-tab'])
    assert.equal(result.final.tabs['original-project-tab'].layout.root.ratio, 0.63)
    assert.deepEqual(result.final.focus.execution, result.initial.focus.execution)
    assert.deepEqual(result.final.drafts, result.initial.drafts)
    assert.deepEqual(result.final.outbox, result.initial.outbox)
    assert.deepEqual(result.final.runs, result.initial.runs)
    assert.deepEqual(forbidden(result.final), [])
    assert.equal(result.final.tabs['mote-primary-tab'], undefined); assert.equal(result.final.tabs['custom-mote-tab'], undefined)
    result.step = 'wait-real-durable-writer-before-exit'
    await until('(()=>{const s=JSON.parse(localStorage.getItem("agentmux-workbench-v1"))?.state,c=window.closedTabProof.facts();return !!s?.restoredWorkbench?.tabs["original-project-tab"] && !s.restoredWorkbench.tabs["mote-primary-tab"] && !s.restoredWorkbench.tabs["custom-mote-tab"] && JSON.stringify(s.restoredWorkbench.layouts)===JSON.stringify(c.layouts) && JSON.stringify(s.agentComposerDrafts)===JSON.stringify(c.drafts) && JSON.stringify(s.agentFocus.execution)===JSON.stringify(c.focus.execution) && s.activeWorkspaceId===c.activeWorkspaceId && s.mainSurface===c.mainSurface && JSON.stringify(s.viewModes)===JSON.stringify(c.viewModes) && JSON.parse(localStorage.getItem("agentmux.leader-topic-floating.v1")).targetTabId===null})()')
    await win.webContents.session.flushStorageData()
    result.durable = await read('JSON.parse(localStorage.getItem("agentmux-workbench-v1"))')
    assert.equal(result.unexpectedWindowClosure, undefined)
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.observation = await bounded(win.webContents.executeJavaScript('({setup:window.closedTabSetup,body:document.body.innerText,facts:window.closedTabProof?.facts()})'), 'failure facts', 2000).catch(error=>({error:error.message}))
  } finally {
    if (win && !win.isDestroyed()) try { await bounded(win.webContents.executeJavaScript('window.closedTabProof?.dispose()'), 'Renderer cleanup', 5000) }
    catch (error) { result.passed=false; result.cleanupFailure={message:error.message} }
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
