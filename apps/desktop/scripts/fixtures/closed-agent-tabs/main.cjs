const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url'), { promisify } = require('node:util'), { execFile } = require('node:child_process')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, privateRoot, evidence, phase, corePath, nodeExecutable, cliPath] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.closed-agent-tabs.process.v1', passed: false, pid: process.pid, phase, calls: [], cli: [] }
const delay = ms => new Promise(done => setTimeout(done, ms))
let win, server, unsubscribe, runtime
const runtimeFile = path.join(privateRoot, 'typed-runtime.json'), spatialFile = path.join(privateRoot, 'spatial-state.json')
const read = expression => win.webContents.executeJavaScript(expression)
const facts = () => read('window.closedAgentTabsProof.facts()')
async function until(label, predicate) {
  const end = Date.now() + 10000
  do { const value = await predicate(); if (value) return value; await delay(25) } while (Date.now() < end)
  throw new Error('Private closure fixture did not settle: ' + label)
}
async function clickNavigation(target) {
  const selector = `[data-closed-agent-tabs-nav="${target}"]`
  const point = await read(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing private navigation button');const rect=node.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2,hit:node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))}})()`)
  assert.equal(point.hit, true, 'Private navigation must have an actual native hit target')
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
}
function retained(value) {
  assert.ok(value.tabs['mixed-tab'].regions['healthy-region']); assert.ok(value.tabs['mixed-tab'].regions['file-region'])
  assert.ok(value.tabs['unknown-tab'].regions['unknown-tab-region'])
  assert.equal(value.drafts.healthy, 'Original unsent healthy draft'); assert.equal(value.drafts.unknown, 'Unknown state keeps this draft')
  assert.equal(value.drafts.retained, 'Retained conversation draft')
  assert.ok(Object.values(value.documents).some(one => one.content === 'Original unsaved note')); assert.ok(Object.values(value.dirty).some(Boolean))
  assert.equal(value.sessions.find(one => one.id === 'healthy').control.run.runId, 'closed-agent-tabs-run-healthy')
  assert.equal(value.sessions.find(one => one.id === 'unknown').processState, 'interrupted')
  assert.equal(value.layouts['closed-agent-tabs-workspace'].root.ratio, .58)
}
function closed(value) {
  assert.deepEqual(Object.keys(value.tabs).sort(), ['mixed-tab', 'unknown-tab'])
  assert.deepEqual(Object.keys(value.tabs['mixed-tab'].regions).sort(), ['file-region', 'healthy-region'])
  assert.equal(value.tabs['mixed-tab'].layout.root.ratio, .61)
  assert.equal(value.tabs['mixed-tab'].layout.activeRegionId, 'healthy-region')
  assert.ok(value.sessions.some(one => one.id === 'retained'), 'View close preserves original Session')
  for (const id of ['retire', 'race', 'mixed-retire']) assert.equal(value.sessions.some(one => one.id === id), false)
  assert.ok(value.zoneProjection?.composition, 'Original Zone must resolve through the production composition function')
  assert.deepEqual(value.zoneProjection.composition.root, value.layouts['closed-agent-tabs-workspace'].root, 'Closed members must not introduce an extra Zone split')
  assert.deepEqual(value.zoneProjection.composition.groups.map(one => one.id).sort(), ['original-group', 'other-group'])
  assert.deepEqual(value.zoneProjection.composition.groups.flatMap(one => one.tabOrder).sort(), ['mixed-tab', 'unknown-tab'])
  assert.equal(value.zoneProjection.composition.groups.some(one => one.id.startsWith('zone-unplaced:')), false, 'No ghost unplaced group after confirmed close')
  retained(value)
}
async function cli(args) {
  const env = { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path, AGENTMUX_AGENT_SESSION_STORE: path.join(privateRoot, 'unused-agent-sessions.json'),
    AGENTMUX_SPATIAL_STATE_STORE: spatialFile, AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state'), AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime') }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'AGENTMUX_ENV', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_RUN_ID', 'AGENTMUX_WORKSPACE_ID', 'AGENTMUX_REGION_ID', 'AGENTMUX_TAB_ID', 'AGENTMUX_VIEW_ID']) delete env[name]
  const { stdout, stderr } = await promisify(execFile)(nodeExecutable, [cliPath, ...args], { env, timeout: 12000, maxBuffer: 2 * 1024 * 1024 })
  const value = JSON.parse(stdout); result.cli.push({ args, value, stderr }); assert.equal(value.ok, true)
  return value.result
}
app.whenReady().then(async () => {
  try {
    const { AgentMuxSpatialStateStore, AgentMuxControlServer } = await import(pathToFileURL(corePath).href)
    const spatial = new AgentMuxSpatialStateStore(spatialFile)
    if (phase === 'second') {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      result.graphBeforeRenderer = await spatial.readForLayout()
      assert.deepEqual(result.graphBeforeRenderer, expected.graph, 'Second Main reads first process durable graph without seeding')
    }
    ipcMain.handle('closed-agent-tabs:request', async (_event, operation, ...args) => {
      result.calls.push({ operation, args })
      switch (operation) {
        case 'setup': return { phase, workspacePath: path.join(privateRoot, 'workspace'), otherWorkspacePath: path.join(privateRoot, 'other-workspace') }
        case 'initialize-runtime':
          try { runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) }
          catch (error) { if (error.code !== 'ENOENT' || phase !== 'first') throw error; runtime = { sessions: args[0] }; await fs.writeFile(runtimeFile, JSON.stringify(runtime)) }
          return runtime
        case 'snapshot': return { ...runtime, timelines: {}, recoveryCandidates: [] }
        case 'refresh': return runtime.sessions.find(one => one.id === args[0].agentSessionId)
        case 'spatial-read': return spatial.readForLayout()
        case 'spatial-commit': return spatial.commit(args[0])
        case 'spatial-retain-labels': return spatial.retainDisplayLabels(args[0])
        case 'flush': await win.webContents.session.flushStorageData(); return
        case 'stop': {
          const control = args[0], session = runtime.sessions.find(one => one.id === control.agentSessionId)
          assert.ok(session); assert.deepEqual(control, session.control)
          assert.ok(['retire', 'race', 'mixed-retire'].includes(session.id), 'Only explicit closure fixture Sessions may retire')
          runtime = { sessions: runtime.sessions.filter(one => one.id !== session.id) }; await fs.writeFile(runtimeFile, JSON.stringify(runtime))
          win.webContents.send('closed-agent-tabs:event', { type: 'core', hostId: 'local', event: { type: 'run-removed', agentSessionId: session.id, run: control.run, evidence: { source: 'run-process', observedAt: Date.now() } } })
          await until('run-removed projected before stop response', async () => !(await facts()).sessions.some(one => one.id === session.id))
          result.calls.push({ operation: 'stop-return-after-run-removed', id: session.id })
          return
        }
        default: throw new Error('Unsupported private boundary: ' + operation)
      }
    })
    win = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    result.rendererPid = win.webContents.getOSProcessId()
    unsubscribe = spatial.subscribe(state => { if (!win.isDestroyed()) win.webContents.send('closed-agent-tabs:event', { kind: 'spatial', state }) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('production initialize', () => read('window.closedAgentTabsProof?.ready'))
    result.rendererPid = win.webContents.getOSProcessId(); assert.ok(result.rendererPid > 0); assert.notEqual(result.rendererPid, result.pid)
    await until('original workface painted', async () => (await facts()).visibleRegions.includes('healthy-region'))
    result.initial = await facts(); assert.equal(result.initial.seedCount, phase === 'first' ? 1 : 0); assert.equal(result.initial.originalInitialize, true); retained(result.initial)
    server = new AgentMuxControlServer({ spatialState: spatial, socketPath: path.join(privateRoot, 'control.sock') }); await server.start()
    if (phase === 'first') {
      // An old Run fact is unrelated to the original healthy Session; it cannot retire its surface.
      const before = await facts()
      win.webContents.send('closed-agent-tabs:event', { type: 'core', hostId: 'local', event: { type: 'run-removed', agentSessionId: 'healthy', run: { runId: 'unrelated-old-run' }, evidence: { source: 'run-process', observedAt: Date.now() } } })
      await delay(150); assert.deepEqual((await facts()).tabs, before.tabs)
      await read('window.closedAgentTabsProof.stop("retire")')
      await read('window.closedAgentTabsProof.stop("mixed-retire")')
      assert.equal(await read('window.closedAgentTabsProof.close("race-tab")'), true)
      assert.equal(await read('window.closedAgentTabsProof.close("retained-tab", true)'), true)
      await read('window.closedAgentTabsProof.flush()')
      result.saved = await facts(); closed(result.saved)
      const beforeNavigation = result.saved
      result.navigation = []
      for (const step of [
        { target: 'other-project', workspace: 'closed-agent-tabs-other-workspace', surface: 'workbench', originalVisible: false },
        { target: 'original-project', workspace: 'closed-agent-tabs-workspace', surface: 'workbench', originalVisible: true },
        { target: 'agents-view', workspace: 'closed-agent-tabs-workspace', surface: 'agents', originalVisible: false },
        { target: 'workbench-view', workspace: 'closed-agent-tabs-workspace', surface: 'workbench', originalVisible: true }
      ]) {
        await clickNavigation(step.target)
        await until('production navigation ' + step.target, async () => {
          const value = await facts()
          return value.activeWorkspaceId === step.workspace && value.mainSurface === step.surface && value.visibleRegions.includes('healthy-region') === step.originalVisible
        })
        await read('window.closedAgentTabsProof.flush()')
        const value = await facts(); closed(value)
        for (const key of ['tabs', 'drafts', 'documents', 'dirty', 'focus', 'sessions']) assert.deepEqual(value[key], beforeNavigation[key], 'Project/view switch preserves original ' + key)
        assert.deepEqual(value.layouts['closed-agent-tabs-workspace'], beforeNavigation.layouts['closed-agent-tabs-workspace'])
        for (const id of ['retire-tab', 'race-tab', 'retained-tab']) assert.equal(value.renderedTabs.includes(id), false, 'Closed Tab cannot reappear in mounted DOM')
        for (const id of ['retire-tab-region', 'race-tab-region', 'retained-tab-region', 'mixed-tab-region']) assert.equal(value.renderedRegions.includes(id), false, 'Closed Region cannot reappear in mounted DOM')
        const graph = await spatial.readForLayout()
        assert.deepEqual(graph.graph.tabs.map(one => one.tabId).sort(), ['mixed-tab', 'unknown-tab'])
        assert.deepEqual(graph.graph.regions.map(one => one.regionId).sort(), ['file-region', 'healthy-region', 'unknown-tab-region'])
        const catalog = (await cli(['space', 'ls'])).catalog
        assert.deepEqual(catalog.tabs.map(one => one.tabId).sort(), ['mixed-tab', 'unknown-tab'])
        assert.deepEqual(catalog.regions.map(one => one.regionId).sort(), ['file-region', 'healthy-region', 'unknown-tab-region'])
        result.navigation.push({ ...step, state: value, graphRevision: graph.revision, publicTabIds: catalog.tabs.map(one => one.tabId) })
      }
      result.saved = await facts(); closed(result.saved)
      result.graph = await spatial.readForLayout()
      assert.deepEqual(result.graph.graph.tabs.map(one => one.tabId).sort(), ['mixed-tab', 'unknown-tab'])
      assert.deepEqual(result.graph.graph.regions.map(one => one.regionId).sort(), ['file-region', 'healthy-region', 'unknown-tab-region'])
      await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify({ state: result.saved, graph: result.graph }))
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      closed(result.initial)
      for (const key of ['tabs', 'layouts', 'drafts', 'documents', 'dirty', 'focus', 'activeWorkspaceId', 'sessions']) assert.deepEqual(result.initial[key], expected.state[key], 'Original ' + key + ' preserved across new Main and Renderer')
    }
    const listed = await cli(['space', 'ls'])
    assert.deepEqual(listed.catalog.tabs.map(one => one.tabId).sort(), ['mixed-tab', 'unknown-tab'])
    const inspected = await cli(['space', 'inspect', '--tab', 'mixed-tab'])
    assert.deepEqual(inspected.catalog.regions.map(one => one.regionId).sort(), ['file-region', 'healthy-region'])
    if (phase === 'second') {
      await read('window.closedAgentTabsProof.reopen("retained")')
      await read('window.closedAgentTabsProof.flush()')
      const reopened = await facts(); result.reopened = reopened
      const surfaces = Object.values(reopened.tabs).flatMap(tab => Object.values(tab.regions)).filter(one => one.sessionId === 'retained')
      assert.equal(surfaces.length, 1); assert.equal(reopened.sessions.find(one => one.id === 'retained').control.run.runId, 'closed-agent-tabs-run-retained')
      assert.equal(reopened.drafts.retained, 'Retained conversation draft'); retained(reopened)
      assert.ok((await cli(['space', 'ls'])).catalog.regions.some(one => one.agentSessionId === 'retained'))
    }
    await read('window.closedAgentTabsProof.flush()'); result.passed = true
  } catch (error) {
    result.failure = { message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) { result.atFailure = await facts().catch(() => null); result.domAtFailure = await read('document.body.innerText').catch(() => null) }
  } finally {
    unsubscribe?.(); if (server) await server.stop()
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
