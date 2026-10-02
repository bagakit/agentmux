const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, privateRoot, phase, preload, evidence, inputPath, coreSpatialPath] = process.argv.slice(2)
assert.ok(html && privateRoot && ['seed', 'restore'].includes(phase) && preload && evidence && inputPath && coreSpatialPath)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const json = value => JSON.parse(JSON.stringify(value))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'agentmux.cross-device-project-groups.native-phase.v1', passed: false, phase,
  electronPid: process.pid, calls: [], spatialEvents: [], images: [], operations: [], userAppTouched: false,
  runtimeCalls: [], controlledGitSuggestions: true }
let win, spatial, observer, unsubscribe
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const stage = async step => {
  process.stderr.write(`project-groups:${phase}:${step}\n`)
  await write(path.join(evidence, `${phase}-progress.json`), { phase, step, pid: process.pid, at: Date.now() })
}
const topology = graph => Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'projectGroups'))

app.whenReady().then(async () => {
  try {
    const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
    const { config, retainedGroupId, unknownProjectId } = input
    const local = config.workspaces[0], remote = config.workspaces[1]
    await stage('public-core-spatial-open')
    const { AgentMuxSpatialStateStore } = await import(pathToFileURL(coreSpatialPath).href)
    const spatialPath = path.join(privateRoot, 'core-spatial-state.json')
    spatial = new AgentMuxSpatialStateStore(spatialPath)
    // A second public store observes the file written by the commit owner. This exercises the
    // native directory watcher, rather than an in-memory preview emitter or an invented ACK.
    observer = new AgentMuxSpatialStateStore(spatialPath)
    unsubscribe = observer.subscribe(state => {
      result.spatialEvents.push(json(state))
      if (win && !win.isDestroyed()) win.webContents.send('project-groups:spatial-change', state)
    })
    ipcMain.handle('project-groups:request', async (_event, operation, ...args) => {
      const call = { operation, args: json(args) }; result.calls.push(call)
      switch (operation) {
        case 'setup': return { phase, config, retainedGroupId, unknownProjectId }
        case 'seed-spatial': {
          assert.equal(phase, 'seed'); assert.equal(await spatial.read(), null)
          const saved = await spatial.commit({ expectedRevision: 0, graph: args[0] })
          result.seeded = json(saved); call.result = json(saved); return saved
        }
        case 'spatial-read': return spatial.read()
        case 'spatial-commit': {
          const saved = await spatial.commit(args[0]); call.result = json(saved); return saved
        }
        case 'flush': await win.webContents.session.flushStorageData(); return
        case 'observe-durable': await win.webContents.session.flushStorageData(); return spatial.read()
        case 'git-project-identity': {
          const workspace = config.workspaces.find(one => one.id === args[0]); assert.ok(workspace)
          return { kind: 'known', hostId: workspace.hostId, repoPath: workspace.path,
            identities: workspace.id === config.workspaces[2].id ? ['controlled-preview:archive'] : ['controlled-preview:shared-project'] }
        }
        case 'file-read': {
          const workspace = config.workspaces.find(one => one.id === args[0]); assert.ok(workspace)
          assert.equal(args[1], `${workspace.path}/overview.txt`)
          return { status: 'read', document: { path: args[1], revision: `controlled-preview:${workspace.id}:1`,
            content: `${workspace.name}\n\nExecution device: ${workspace.hostId}\nOriginal directory: ${workspace.path}\n\nProject groups organize navigation.\nThis file stays in its original Workspace and Region.\n` } }
        }
        case 'file-directory': {
          const workspace = config.workspaces.find(one => one.id === args[0]); assert.ok(workspace)
          return [{ name: 'overview.txt', path: `${workspace.path}/overview.txt`, isDirectory: false, isSymlink: false }]
        }
        default: result.runtimeCalls.push({ operation, args: json(args) }); throw new Error(`Unowned operation in spatial-only proof: ${operation}`)
      }
    })
    win = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: true,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, _level, message) => process.stderr.write(`project-groups:console:${message}\n`))
    win.webContents.on('render-process-gone', (_event, details) => process.stderr.write(`project-groups:renderer-gone:${JSON.stringify(details)}\n`))
    const read = expression => win.webContents.executeJavaScript(expression)
    const exists = selector => read(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    const state = () => read('window.projectGroupsState()')
    const until = async (expression, budget = 15_000) => {
      const deadline = Date.now() + budget
      do { const value = typeof expression === 'string' ? await read(expression) : await expression(); if (value) return value; await delay(35) } while (Date.now() < deadline)
      throw new Error(`Project groups did not settle: ${expression}`)
    }
    const flush = () => read('window.projectGroupsFlush()')
    const capture = async (name, scene) => {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await read('Promise.allSettled(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation=>animation.finished))')
      const bytes = (await win.webContents.capturePage()).toPNG(), file = `${phase}-${name}.png`
      await fs.writeFile(path.join(evidence, file), bytes, { mode: 0o600 })
      result.images.push({ file, absolutePath: path.join(evidence, file), scene, phase, electronPid: process.pid,
        sha256: hash(bytes), bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), state: await state() })
    }
    const resize = async width => { win.setContentSize(width, width < 1000 ? 760 : 860); await until(`innerWidth===${width}`) }
    await stage('load-real-app-initialize')
    await win.loadFile(html)
    await until('window.projectGroupsReady && window.projectGroupsState().loading === false')
    win.webContents.debugger.attach('1.3')
    const dispatch = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await dispatch('Emulation.setFocusEmulationEnabled', { enabled: true })
    const clickNode = async expression => {
      const point = await read(`(() => { const node=(${expression}); if(!node)throw new Error('Missing UI target'); node.scrollIntoView({block:'nearest'}); const r=node.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Empty UI target');return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
      await dispatch('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
      assert.equal(await read(`(() => { const node=(${expression}); return node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && node.contains(document.elementFromPoint(${point.x},${point.y})) })()`), true, 'Native target is actually painted and hit-testable after pointer hover')
      for (const type of ['mousePressed', 'mouseReleased']) await dispatch('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
      result.operations.push({ input: 'native-pointer', expression, point })
    }
    const click = selector => clickNode(`document.querySelector(${JSON.stringify(selector)})`)
    const typeName = async text => {
      await click('.project-group-dialog__name input')
      await dispatch('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await dispatch('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
      const selection = await read('(() => { const input=document.querySelector(".project-group-dialog__name input"); return {start:input.selectionStart,end:input.selectionEnd,length:input.value.length} })()')
      assert.deepEqual(selection, { start: 0, end: selection.length, length: selection.length }, 'Native Cmd+A actually selects the complete current name before typing')
      result.operations.push({ input: 'native-keyboard', command: 'selectAll', selection })
      await dispatch('Input.insertText', { text }); result.operations.push({ input: 'native-text', field: 'Group name', text })
      assert.equal(await read('document.querySelector(".project-group-dialog__name input").value'), text)
    }
    const memberExpression = id => `[...document.querySelectorAll('[data-project-group-member]')].find(one=>one.dataset.projectGroupMember===${JSON.stringify(id)})`
    const projectId = workspace => JSON.stringify([workspace.hostId, workspace.repoPath ?? workspace.path])
    const localId = projectId(local), remoteId = projectId(remote)
    if (await exists('[aria-label="Show projects sidebar"]')) await click('[aria-label="Show projects sidebar"]')
    if (await exists('[aria-label="Hide Space tools"]')) await click('[aria-label="Hide Space tools"]')
    if (phase === 'seed') await click(`[data-space-folder] [data-workspace-id="${local.id}"]`)
    await until('window.projectGroupsState().mainSurface === "workbench" && window.projectGroupsState().visibleRegions.length > 0')
    result.initialState = await state(); result.originalDurable = await flush()
    assert.equal(result.initialState.projectGroups.some(one => one.groupId === retainedGroupId && one.projectIds.includes(unknownProjectId)), true)
    const originalTopology = topology(result.originalDurable.graph)
    const checkPreserved = async label => {
      const durable = await flush(), current = await state()
      assert.deepEqual(topology(durable.graph), originalTopology, `${label}: grouping preserves every original Core entity, layout, resource, execution Host and cwd`)
      assert.deepEqual(current.workbench, result.initialState.workbench, `${label}: grouping does not migrate or replace the original Workbench`)
      assert.deepEqual(current.execution, result.initialState.execution)
      return { durable, current }
    }
    await stage('original-durable-workface-confirmed')
    await capture('unknown-retained', 'Full workface with the original unavailable member retained; no Runtime or registration is invented')
    if (phase === 'seed') {
      await click('[aria-label="Create project group"]'); await until('!!document.querySelector(".project-group-dialog")')
      await typeName(input.createdName)
      for (const workspace of [local, remote]) await clickNode(`[...document.querySelectorAll('.project-group-dialog__member')].find(one=>one.title.endsWith(${JSON.stringify(workspace.path)})).querySelector('input')`)
      assert.equal(await read('document.querySelectorAll(".project-group-dialog__member input:checked").length'), 2)
      await capture('options-wide', 'Actual name and device-specific member choices, with controlled Git suggestions explicitly bounded')
      await resize(900); await capture('options-narrow', 'Narrow complete dialog with long project names, devices and paths'); await resize(1280)
      await click('.project-group-dialog button[type="submit"]')
      await until(`!document.querySelector('.project-group-dialog') && window.projectGroupsState().projectGroups.some(one=>one.name===${JSON.stringify(input.createdName)})`)
      result.created = (await state()).projectGroups.find(one => one.name === input.createdName)
      assert.deepEqual(result.created.projectIds, [localId, remoteId])
      assert.notEqual(result.created.groupId, retainedGroupId)
      result.createdAck = await checkPreserved('actual UI create + Core ACK')
      await until(() => result.spatialEvents.some(event => event.graph.projectGroups?.some(one => one.groupId === result.created.groupId)))
      await capture('grouped-wide', 'One actual cross-device group; directory aliases keep both original Projects reachable')
      await resize(900); await capture('grouped-narrow', 'Narrow full workface with the same original split and both device labels'); await resize(1280)
      await click(`[aria-label=${JSON.stringify(`Edit ${input.createdName}`)}]`)
      await typeName(input.renamedName); await capture('rename', 'Editing the same stable group identity; rename does not replace members or layouts')
      await click('.project-group-dialog button[type="submit"]'); await until('!document.querySelector(".project-group-dialog")')
      result.renamedAck = await checkPreserved('actual UI rename + Core ACK')
      assert.deepEqual(result.renamedAck.current.projectGroups.find(one => one.groupId === result.created.groupId), { ...result.created, name: input.renamedName })
      await click(`[data-space-folder] [data-workspace-id="${local.id}"][data-project-group-reference]`)
      await until(`window.projectGroupsState().activeWorkspaceId===${JSON.stringify(local.id)} && window.projectGroupsState().focusedMember===${JSON.stringify(localId)}`)
      result.aliasFocus = await state()
      assert.deepEqual(result.aliasFocus.selectedMembers, [localId])
      await capture('alias-focus', 'Native directory alias click selects and focuses its exact original group member')
      await dispatch('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
      await dispatch('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
      await until(`window.projectGroupsState().focusedMember===${JSON.stringify(remoteId)}`)
      assert.equal((await state()).activeWorkspaceId, local.id, 'Keyboard focus movement does not activate another Project')
      await dispatch('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await dispatch('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await until(`window.projectGroupsState().activeWorkspaceId===${JSON.stringify(remote.id)}`)
      result.remoteSelection = await checkPreserved('remote member keyboard activation + Core ACK')
      assert.deepEqual(result.remoteSelection.current.selectedMembers, [remoteId])
      await capture('remote-member', 'Exact remote member selected; original remote directory and file Region remain in place')
      await click('[aria-label="Edit Retained release project · registration unavailable"]')
      await until('!!document.querySelector(".project-group-dialog")')
      assert.ok(await read('document.querySelector(".project-group-dialog").innerText.includes("Registration unavailable · original member retained")'))
      assert.equal(await read('document.querySelectorAll(".project-group-dialog__member input:checked").length'), 2)
      await capture('unknown-member-editor', 'Unknown original member stays selected and visible when editing its retained group')
      await click('[aria-label="Close project group editor"]'); await until('!document.querySelector(".project-group-dialog")')
      result.saved = await checkPreserved('final seed persistence')
      await write(path.join(privateRoot, 'seed-expectation.json'), { created: { ...result.created, name: input.renamedName }, ...result.saved })
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'seed-expectation.json'), 'utf8'))
      assert.deepEqual(result.originalDurable, expected.durable, 'Second ordinary Electron reads the same actual Core revision and graph')
      assert.deepEqual(result.initialState.workbench, expected.current.workbench)
      assert.deepEqual(result.initialState.projectGroups, expected.current.projectGroups)
      assert.equal(result.initialState.activeWorkspaceId, remote.id, 'The original remote selection survives ordinary process exit')
      result.restored = { expected, current: result.initialState, durable: result.originalDurable }
      await capture('restored-wide', 'Second ordinary Electron hydrates the original group, remote selection and complete Core workface')
      await resize(900); await capture('restored-narrow', 'Restored narrow workface retains group identity, member labels and file Region'); await resize(1280)
      await clickNode(memberExpression(unknownProjectId))
      assert.equal((await state()).activeWorkspaceId, remote.id, 'Unavailable original member does not redirect to another registered device')
      await click(`[aria-label=${JSON.stringify(`Dissolve ${input.renamedName}`)}]`)
      await until(() => exists('[data-confirm-label="Dissolve group"]'))
      await capture('dissolve-confirmation', 'Original neutral confirmation explains that Projects, directories and Sessions keep their devices')
      await click('[data-confirm-label="Dissolve group"]')
      await until(`!document.querySelector('[data-confirm-label="Dissolve group"]') && !window.projectGroupsState().projectGroups.some(one=>one.groupId===${JSON.stringify(expected.created.groupId)})`)
      result.dissolved = await checkPreserved('actual dissolve + explicit Core removal ACK')
      assert.deepEqual(result.dissolved.current.projectGroups, result.initialState.projectGroups.filter(one => one.groupId !== expected.created.groupId))
      assert.ok(result.calls.some(call => call.operation === 'spatial-commit' && call.args[0].removedProjectGroupIds?.includes(expected.created.groupId)), 'Only the original Core group ID is explicitly authorized for removal')
      assert.equal(await read(`document.querySelector('[data-space-folder] [data-workspace-id="${remote.id}"]').hasAttribute('data-project-group-reference')`), false)
      await capture('dissolved', 'Only navigation grouping is removed; original selected remote workface and unavailable-member group remain')
    }
    result.finalState = await state(); result.finalDurable = await flush()
    assert.equal(result.runtimeCalls.length, 0, 'No Agent, Run, file edit or remote owner lifecycle belongs to this proof')
    assert.ok(result.calls.some(call => call.operation === 'spatial-read') && result.calls.some(call => call.operation === 'spatial-commit'))
    await until(() => result.spatialEvents.some(event => event.revision === result.finalDurable.revision))
    assert.ok(result.spatialEvents.length > 0, 'Real Core file watcher delivers the final durable revision to the actual Renderer')
    result.passed = true
    await stage('native-complete')
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    process.stderr.write(`project-groups:failed:${error.stack}\n`)
  } finally {
    try { unsubscribe?.(); if (win && !win.isDestroyed()) { await win.webContents.session.flushStorageData(); win.destroy() } }
    catch (error) { result.cleanupError = error.message; result.passed = false }
    await write(path.join(evidence, `${phase}.json`), result)
    app.exit(result.passed ? 0 : 1)
  }
})
