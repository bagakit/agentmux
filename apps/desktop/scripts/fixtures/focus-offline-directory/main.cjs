const assert = require('node:assert/strict')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase] = process.argv.slice(2)
assert.ok(['seed', 'restore'].includes(phase))
app.setPath('userData', join(privateRoot, 'profile'))
app.setPath('sessionData', join(privateRoot, 'session'))
const result = { passed: false, phase, pid: process.pid, scenes: [], images: [], operations: [], restartPreserved: false, boundary: 'Actual Global/Store/Row/Workbench and CSS in two ordinary private GUI processes. Typed preview Session/Run references only; no real Core/PTY continuity, user App, package, install, or shared Runtime controls.' }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const durable = facts => Object.fromEntries(['tabs', 'layouts', 'drafts', 'focus', 'activeWorkspaceId', 'mainSurface', 'timelineHeight', 'identities'].map(key => [key, facts[key]]))
function assertFullDirectory(geometry) {
  assert.ok(geometry.canvas?.height > 100 && geometry.directory?.height > 0, 'Nonempty actual directory geometry')
  assert.ok(geometry.directory.height >= geometry.canvas.height - 2, `Only-offline directory occupies the main canvas: directory=${geometry.directory.height}, canvas=${geometry.canvas.height}`)
}
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    result.consoleMessages = []
    win.webContents.on('console-message', (_event, ...details) => result.consoleMessages.push(details))
    await win.loadFile(html, { query: { phase } })
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const evaluate = code => win.webContents.executeJavaScript(code)
    const until = async code => { for (let n = 0; n < 200; n++) { if (await evaluate(code)) return; await delay(25) } throw new Error('Actual directory condition did not settle: ' + code) }
    const paint = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const facts = () => evaluate('offlineDirectoryProbe.facts()')
    const geometry = () => evaluate('offlineDirectoryProbe.geometry()')
    const hit = async selector => {
      const actual = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Exact target missing');const r=node.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {selector:${JSON.stringify(selector)},rect:r.toJSON(),x,y,matched:node.contains(document.elementFromPoint(x,y)),disabled:node.disabled??false}})()`)
      assert.ok(actual.rect.width > 0 && actual.rect.height > 0, 'Actual target has painted dimensions')
      assert.equal(actual.matched, true, 'Target is hit at its painted center')
      assert.equal(actual.disabled, false, 'Target remains enabled')
      return actual
    }
    const click = async selector => {
      const actual = await hit(selector)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: actual.x, y: actual.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
      await paint(); return actual
    }
    const key = async (key, code = key, keyCode = 0) => {
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) })
      await paint()
    }
    const search = async value => {
      await click('[aria-label="Search contexts"]')
      await evaluate('document.querySelector("[aria-label=\\"Search contexts\\"]").select()')
      if (value) await win.webContents.debugger.sendCommand('Input.insertText', { text: value })
      else await key('Backspace', 'Backspace', 8)
      await paint()
      await until(`document.querySelector('[aria-label="Search contexts"]').value===${JSON.stringify(value)}`)
    }
    const shot = async image => {
      await paint(); await delay(120); await paint()
      const g = await geometry()
      await writeFile(join(privateRoot, image), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
      result.images.push(image); return { image, geometry: g }
    }
    await until('window.offlineDirectoryProbe?.ready && document.querySelector(".focus-disconnected-projects")')
    result.seedCount = await evaluate('offlineDirectoryProbe.seedCount')
    result.start = await facts()
    assert.equal(result.start.identities.length, 67)
    assert.ok(result.start.tabs['retained-directory-tab'])
    assert.equal(Object.keys(result.start.tabs['retained-directory-tab'].regions).length, 2)
    if (phase === 'restore') {
      assert.equal(result.seedCount, 0, 'Second ordinary process has no seed')
      const expected = JSON.parse(await readFile(join(privateRoot, 'expected.json'), 'utf8'))
      assert.deepEqual(durable(result.start), expected, 'Original Store.initialize restores exact persisted workface, Focus and typed Run identities')
      await until('!!document.querySelector(".focused-tab-workspace")')
      result.restoredWorkface = await evaluate('({rect:document.querySelector(".focused-tab-workspace").getBoundingClientRect().toJSON(),regions:[...document.querySelectorAll(".focused-tab-workspace [data-workbench-region-id]")].map(node=>node.dataset.workbenchRegionId),errors:window.sceneErrors})')
      assert.ok(result.restoredWorkface.rect.width > 0 && result.restoredWorkface.rect.height > 0)
      result.restartPreserved = true
    } else {
      assert.equal(result.seedCount, 1)
      for (const width of [1600, 640, 320]) {
        win.setContentSize(width, 900); await until(`innerWidth===${width}`); await paint()
        await evaluate('document.querySelector(".focus-disconnected-projects .focus-project-lanes__rows").scrollTop=0')
        const initial = await geometry()
        assertFullDirectory(initial)
        assert.equal(initial.count, 67); assert.equal(initial.projectCount, 21); assert.equal(initial.laneCount, 22)
        assert.equal(initial.horizontalOverflow, false)
        assert.equal(initial.knownRecap && initial.unknownRecap && initial.knownTime && initial.unknownTime, true)
        assert.ok(initial.cardWidths.every(value => value >= Math.min(250, width - 60)), 'Readable columns keep useful width')
        assert.ok(initial.cardHeights.every(value => value >= 120), 'Directory exposes excerpt and metadata instead of 28px tiles')
        assert.equal(await evaluate('!!document.querySelector(".focus-disconnected-projects__return")'), false)
        if (width === 1600) {
          const cssBefore = await evaluate(`(()=>{for(const sheet of document.styleSheets)for(const rule of sheet.cssRules)if(rule.selectorText==='.focus-disconnected-projects'){window.oldDirectoryRule=rule;window.oldDirectoryCss=rule.style.cssText;rule.style.setProperty('max-height','45%');rule.style.setProperty('overflow','auto');return window.oldDirectoryCss}throw new Error('Actual compiled directory CSSOM rule not found')})()`)
          await paint()
          const mutant = await geometry()
          let failure
          try { assertFullDirectory(mutant) } catch (error) { failure = { name: error.name, code: error.code, message: error.message } }
          assert.equal(failure?.name, 'AssertionError', 'Old 45% cap must fail the actual same compiled geometry assertion')
          const cssAfter = await evaluate('oldDirectoryRule.style.cssText=oldDirectoryCss;oldDirectoryRule.style.cssText')
          assert.equal(cssAfter, cssBefore, 'Exact CSSOM declaration bytes restored')
          await paint(); const restored = await geometry(); assertFullDirectory(restored)
          result.cssMutation = { assertionRed: true, restoredGreen: true, mutation: 'Actual compiled .focus-disconnected-projects CSSOM max-height:45%; overflow:auto', before: cssBefore, after: cssAfter, failure, mutant, restored }
        }
        const rows = await evaluate('(()=>{const node=document.querySelector(".focus-disconnected-projects .focus-project-lanes__rows");const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.bottom-12,delta:node.scrollHeight+900}})()')
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rows.x, y: rows.y, deltaX: 0, deltaY: rows.delta })
        await until('(()=>{const node=document.querySelector(".focus-disconnected-projects .focus-project-lanes__rows");return node.scrollTop>=node.scrollHeight-node.clientHeight-2})()')
        const lastId = await evaluate('offlineDirectoryProbe.lastId')
        const lastHit = await hit(`.focus-disconnected-projects [data-session-id="${lastId}"]`)
        const end = await geometry(); assert.equal(end.horizontalOverflow, false)
        await evaluate('document.querySelector(".focus-disconnected-projects .focus-project-lanes__rows").scrollTop=0'); await paint()
        const scene = { label: `only-offline-${width}`, width, ...initial, lastHit, bottom: end, horizontalOverflow: false }
        if (width === 640) {
          const beforeReads = (await facts()).reads
          await search('连续阅读'); await until('offlineDirectoryProbe.geometry().count>0 && offlineDirectoryProbe.geometry().count<67')
          scene.search = { query: '连续阅读', geometry: await geometry(), capture: await shot('only-offline-640-search-results.png') }
          await search('no-such-context-739'); await until('offlineDirectoryProbe.geometry().count===0')
          assert.ok(await evaluate('document.querySelector(".focus-disconnected-projects__empty button")?.textContent==="Clear filters"'))
          scene.zeroMatch = { query: 'no-such-context-739', capture: await shot('only-offline-640-search-empty.png') }
          await click('.focus-disconnected-projects__empty button'); await until('offlineDirectoryProbe.geometry().count===67')
          assert.deepEqual((await facts()).reads, beforeReads, 'Search and clear do not add transcript/history reads')
        } else scene.capture = await shot(`only-offline-${width}.png`)
        result.scenes.push(scene)
      }
      win.setContentSize(1600, 900); await until('innerWidth===1600')
      await evaluate('offlineDirectoryProbe.mixed()'); await paint()
      assert.equal((await geometry()).expanded, 'true', 'New live context does not throw away the directory being read')
      await click('.focus-disconnected-projects__return'); await until('offlineDirectoryProbe.geometry().expanded==="false"')
      const entry = '.focus-project-board__live [data-bucket="disconnected"] .focus-disconnected-entry'
      const compactHit = await hit(entry)
      assert.equal(compactHit.rect.width, 32, 'Mixed mode keeps the exact 32px lane entry')
      await evaluate('window.originalLiveNode=document.querySelector("[data-session-id=typed-live]");window.originalEntry=document.querySelector(".focus-project-board__live [data-bucket=disconnected] .focus-disconnected-entry");window.originalLane=originalEntry.closest("[data-lane-id]").dataset.laneId')
      result.scenes.push({ label: 'mixed-compact-1600', width: 1600, ...await geometry(), entry: compactHit, capture: await shot('mixed-compact-1600.png') })
      await click(entry); await until('offlineDirectoryProbe.geometry().expanded==="true"')
      assert.equal(await evaluate('document.activeElement.closest("[data-lane-id]")?.dataset.laneId===originalLane'), true, 'Reveal focuses the exact original lane')
      assert.equal(await evaluate('originalLiveNode===document.querySelector("[data-session-id=typed-live]")&&document.querySelector(".focus-project-board__live").hidden&&document.querySelector(".focus-project-board__live").inert'), true, 'Hidden/inert live board retains its original node')
      const expanded = await geometry(); assert.equal(expanded.horizontalOverflow, false)
      result.scenes.push({ label: 'mixed-expanded-1600', width: 1600, ...expanded, exactLane: await evaluate('originalLane'), capture: await shot('mixed-expanded-1600.png') })
      await key('Escape', 'Escape', 27); await until('offlineDirectoryProbe.geometry().expanded==="false"')
      assert.equal(await evaluate('document.activeElement===originalEntry'), true, 'Keyboard Escape returns to the clicked exact entry')
      assert.equal(await evaluate('originalLiveNode===document.querySelector("[data-session-id=typed-live]")'), true)
      const returnHit = await hit(entry)
      result.scenes.push({ label: 'mixed-return-1600', width: 1600, ...await geometry(), returnHit, exactReturnFocus: true, capture: await shot('mixed-return-1600.png') })
      await click(entry); await until('offlineDirectoryProbe.geometry().expanded==="true"')
      await click('[aria-label="Search contexts"]')
      await evaluate('document.querySelector(".focus-disconnected-projects__return").click()'); await paint()
      assert.equal(await evaluate('document.activeElement===document.querySelector("[aria-label=\\"Search contexts\\"]")'), true, 'Later deliberate search focus wins over directory return')
      result.operations.push({ label: 'later-focus-preserved', passed: true })
      await evaluate('offlineDirectoryProbe.onlyOffline()'); await until('offlineDirectoryProbe.geometry().count===67')
      const beforeNavigation = durable(await facts())
      await evaluate('document.querySelector(".focus-disconnected-projects [data-session-id=session-codex]").focus()')
      await key('Enter', 'Enter', 13)
      await until('offlineDirectoryProbe.facts().focus.execution.sessionId==="session-codex"')
      const navigated = durable(await facts())
      for (const key of ['tabs', 'layouts', 'drafts', 'identities', 'timelineHeight']) assert.deepEqual(navigated[key], beforeNavigation[key], 'Original Open in Focus navigation preserves ' + key)
      await evaluate('offlineDirectoryProbe.selectOriginal()'); await until('!!document.querySelector(".focused-tab-workspace")')
      result.final = await facts()
      for (const key of ['tabs', 'layouts', 'drafts', 'identities', 'timelineHeight']) assert.deepEqual(result.final[key], result.start[key], 'Directory controls preserve original ' + key)
      assert.deepEqual(result.final.focus.execution.reference, await evaluate('offlineDirectoryProbe.reference'))
      await evaluate('offlineDirectoryProbe.flush()'); await delay(150); await win.webContents.session.flushStorageData()
      await writeFile(join(privateRoot, 'expected.json'), JSON.stringify(durable(result.final)))
    }
    result.end = await facts()
    assert.deepEqual(result.end.control, { launchAgent: 0, stop: 0, resume: 0, recover: 0, write: 0 }, 'Directory never invokes lifecycle or input controls')
    result.passed = true
  } catch (error) {
    result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }
    if (win) { result.observationAtFailure = await win.webContents.executeJavaScript('({facts:window.offlineDirectoryProbe?.facts(),geometry:window.offlineDirectoryProbe?.geometry(),errors:window.sceneErrors,html:document.body.innerHTML.slice(0,12000)})').catch(() => null) }
  } finally {
    await writeFile(join(privateRoot, phase + '-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
