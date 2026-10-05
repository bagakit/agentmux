const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, temporary, evidence, phase, variant] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data')); app.setPath('sessionData', path.join(temporary, 'session-data'))
const result = { passed: false, phase, variant, pid: process.pid, calls: [], events: [], frames: [], console: [] }
const A = 'topic-region-0', B = 'original-decisions-region'
const keys = ['tabs', 'layouts', 'selection', 'drafts', 'documents', 'dirtyDocuments', 'collapsed', 'activeWorkspaceId', 'mainSurface', 'focus', 'regions']
let win, unsubscribe, releaseAck, arm = false, acknowledgeStarted
const started = new Promise(resolve => { acknowledgeStarted = resolve })
const held = new Promise(resolve => { releaseAck = resolve })
app.whenReady().then(async () => {
  try {
    const { AgentMuxSpatialStateStore } = await import(pathToFileURL(path.resolve(__dirname, '../../../../../packages/core/dist/spatial-state.js')).href)
    const spatial = new AgentMuxSpatialStateStore(path.join(temporary, 'spatial-state.json'))
    ipcMain.handle('topics-restart:request', async (_event, operation, ...args) => {
      result.calls.push({ operation })
      if (operation === 'setup') return { phase }
      if (operation === 'spatial-read') return spatial.readForLayout()
      if (operation === 'spatial-commit') {
        const saved = await spatial.commit(args[0])
        // Commit and onChange retain the original Core ordering. Only the IPC
        // response for the first real B pointer intent is held until after A.
        if (arm && saved.graph.tabLayouts['topic-tab-0']?.activeRegionId === B) {
          arm = false
          result.delayed = { revision: saved.revision, active: B, expectedRevision: args[0].expectedRevision }
          acknowledgeStarted()
          await held
          result.delayed.released = true
        }
        return saved
      }
      if (operation === 'spatial-labels') return spatial.retainDisplayLabels(args[0])
      if (operation === 'flush') return win.webContents.session.flushStorageData()
      throw Error('Unsupported private continuity operation: ' + operation)
    })
    win = new BrowserWindow({ width: 1320, height: 820, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false,
        preload: path.resolve(__dirname, '../topics-navigation-quality/restart-preload.cjs') } })
    unsubscribe = spatial.subscribe(state => {
      result.events.push({ revision: state.revision, active: state.graph.tabLayouts['topic-tab-0']?.activeRegionId })
      if (!win.isDestroyed()) win.webContents.send('topics-restart:spatial-change', state)
    })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.console.push(String(message).slice(0, 1200)) })
    const read = code => win.webContents.executeJavaScript(code)
    const until = async (label, code) => {
      const end = Date.now() + 15000
      do { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw Error('Original App scene unavailable: ' + label)
    }
    const click = async selector => {
      const point = await read(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing native input target');const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    const frame = async name => {
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await fs.writeFile(path.join(evidence, name), (await win.webContents.capturePage()).toPNG())
      result.frames.push(name)
    }
    const checkFacts = facts => {
      assert.equal(facts.error, null); assert.equal(facts.workbenchSaveWarning, null)
      assert.deepEqual(facts.controls, []); assert.equal(facts.rows, 8)
      assert.ok(facts.drafts[A]); assert.ok(Object.keys(facts.dirtyDocuments).length > 0)
    }
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await until('restored original workface', 'window.topicsRestartReady && topicsRestartFacts().rows===8 && document.querySelectorAll(".editor-pane").length===2')
    await until('original unsaved body', `document.querySelector('[data-workbench-region-id="${A}"]')?.textContent.replaceAll('\u00a0',' ').includes('Original unsaved file annotation.')`)
    await until('original second file', `document.querySelector('[data-workbench-region-id="${B}"]')?.textContent.replaceAll('\u00a0',' ').includes('Original research workface')`)
    if (phase === 'seed') await click('[aria-label="Show file tree"]')
    await read('continuityFlush()')
    result.before = await read('continuityFacts()'); checkFacts(result.before)
    if (phase === 'seed') {
      assert.equal(result.before.tabs['topic-tab-0'].layout.activeRegionId, A)
      result.originalSpatial = await spatial.readForLayout()
      await frame('continuity-before-A.png')
      arm = true
      await read('continuityMark("pointer-B")')
      await click(`[data-workbench-region-id="${B}"] .editor-canvas`)
      await started
      result.atB = await read('continuityFacts()')
      assert.equal(result.atB.tabs['topic-tab-0'].layout.activeRegionId, B)
      await frame('continuity-held-B.png')
      await read('continuityMark("pointer-return-A")')
      await click(`[data-workbench-region-id="${A}"] .editor-canvas`)
      await until('latest native pointer A', `continuityFacts().tabs['topic-tab-0'].layout.activeRegionId===${JSON.stringify(A)}`)
      result.returnedBeforeAck = await read('continuityFacts()')
      result.returnTraceIndex = await read('continuityMark("after-return-A")')
      await frame('continuity-returned-A-before-ack.png')
      releaseAck()
      // A drain of the original persistence owner is a completion barrier, not a
      // delay between B and A or a repair of the selected Region.
      await read('continuityFlush()')
      result.after = await read('continuityFacts()'); checkFacts(result.after)
      result.trace = await read('continuityTrace()')
      result.durable = await spatial.readForLayout()
      await frame('continuity-after-ack.png')
      assert.equal(result.after.tabs['topic-tab-0'].layout.activeRegionId, A, 'The latest pointer choice A survives the older B acknowledgement')
      assert.equal(result.durable.graph.tabLayouts['topic-tab-0'].activeRegionId, A, 'The same original durable Region remains A')
      assert.ok(result.trace.slice(result.returnTraceIndex).every(item => item.active === A), 'No intermediate B is applied after the latest pointer A')
      for (const key of keys) assert.deepEqual(result.after[key], result.before[key], key + ' survives original pointer A-B-A')
      for (const key of ['tabs', 'regions', 'tabLayouts', 'layouts', 'bindings']) assert.deepEqual(result.durable.graph[key], result.originalSpatial.graph[key], 'Original Core ' + key + ' preserved')
      await fs.writeFile(path.join(temporary, 'expected.json'), JSON.stringify(result.after))
    } else {
      const original = JSON.parse(await fs.readFile(path.join(temporary, 'expected.json'), 'utf8'))
      assert.equal(result.before.seeded, false, 'Second process must not seed or reconstruct identities')
      for (const key of keys) assert.deepEqual(result.before[key], original[key], key + ' restored after the first actual process exited')
      result.durable = await spatial.readForLayout()
      assert.equal(result.durable.graph.tabLayouts['topic-tab-0'].activeRegionId, A)
      await frame('continuity-restored-A.png')
    }
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.observed = await win.webContents.executeJavaScript('window.continuityFacts?.()').catch(() => null)
      result.trace ??= await win.webContents.executeJavaScript('window.continuityTrace?.()').catch(() => null)
    }
  } finally {
    releaseAck(); unsubscribe?.()
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
