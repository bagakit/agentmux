import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activate } from './desktop.mjs'
import { replaceText } from './resources.mjs'

const nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
const pane = '[data-settings-pane="workspaces"]:not([hidden])'
const composer = `${pane} .workspace-composer`
const fixtureName = 'globalThis.__settingsWorkspaceRegistrationProof'

/** Uses the real registered Main owner and trusted UI input. Configuration reads are observations. */
export function workspaceSettingsProof({ probe, desktopRoot, root, command, configPath, waitFor, section, surface, originalSurface, workspaceId, sessionId, phase }) {
  const facts = { cli: [], ui: [], invalid: [], nativeInput: [] }
  const selectedPreviews = new Map()
  let originalSession
  const read = async () => JSON.parse(await readFile(configPath, 'utf8'))
  const snapshot = async () => ({ surface: await surface(probe), selection: await probe.cdp.evaluate(`(() => {
      const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;
      return {activeWorkspaceId:state.activeWorkspaceId,mainSurface:state.mainSurface}
    })()`) })
  const publications = () => probe.cdp.evaluate('window.__settingsWorkspaceRegistrationEvents.length')
  const shown = () => probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(pane)}))`)
  const show = async () => {
    if (!await probe.cdp.evaluate('Boolean(document.querySelector(".settings-sidebar"))')) {
      await activate(probe.cdp, `${nodes('.window-status-bar button[aria-label="Settings"]')}`)
    }
    await section(probe, 'Workspaces', 'workspaces')
    assert.equal(await shown(), true)
  }
  const configExceptWorkspaces = ({ workspaces: _workspaces, ...config }) => config
  const fromReceipt = result => ({ id: result.item.id, ...result.item.value })
  async function add(input, changed = true) {
    const response = await command(['settings', 'workspaces', 'add', '--input', '-'], 0, JSON.stringify(input))
    assert.equal(response.operation, 'settings.workspaces.add'); assert.equal(response.result.changed, changed)
    const record = fromReceipt(response.result)
    assert.deepEqual((await read()).workspaces.find(value => value.id === record.id), record, 'Receipt is the actual committed record')
    return record
  }
  async function unchanged(input, expectedRecord) {
    const bytes = await readFile(configPath), count = await publications(), before = await snapshot()
    assert.deepEqual(await add(input, false), expectedRecord)
    assert.deepEqual(await readFile(configPath), bytes); assert.equal(await publications(), count)
    assert.deepEqual(await snapshot(), before, 'An unchanged registration never changes the workbench')
  }
  async function form(path, name = '') {
    await show()
    const hidden = await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(`${pane} .settings-workspace-create`)}).hidden`)
    if (hidden) await activate(probe.cdp, `${nodes(`${pane} .settings-pane-toolbar button`)}.filter(e=>e.textContent.trim()==='Add project')`)
    await waitFor('actual ready Host in project form', () => probe.cdp.evaluate(`(() => {
      const field=document.querySelector(${JSON.stringify(`${composer} select`)});return field?.value==='local'&&!field.disabled
    })()`))
    await replaceText(probe.cdp, `document.querySelector(${JSON.stringify(`${composer} input[placeholder="/path/to/project"]`)})`, path)
    await replaceText(probe.cdp, `document.querySelector(${JSON.stringify(`${composer} input[placeholder="Project name"]`)})`, name)
    assert.equal(await probe.cdp.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${composer} select`)})).at(-1).value`), 'none', 'UI Add explicitly opens without an Agent')
  }
  const submit = () => activate(probe.cdp, nodes(`${composer} .primary-button`))
  async function selected(record, before) {
    await waitFor('UI selected the actual committed identity', async () => {
      const current = await snapshot()
      return current.selection.activeWorkspaceId === record.id && current.surface.workbench.layouts[record.id] && !await shown()
    })
    const after = await snapshot(), layout = after.surface.workbench.layouts[record.id]
    const group = layout.groups[0]
    assert.equal(layout.groups.length, 1); assert.equal(typeof group.id, 'string'); assert.ok(group.id.length > 0)
    assert.deepEqual(layout, { root: { type: 'leaf', groupId: group.id },
      groups: [{ id: group.id, tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: group.id })
    const expected = structuredClone(before)
    expected.selection = { activeWorkspaceId: record.id, mainSurface: 'workbench' }
    expected.surface.workbench.layouts[record.id] = layout
    assert.deepEqual(after, expected, 'Explicit UI selection adds only the returned empty layout and active project intent')
    assert.equal(await probe.cdp.evaluate(`(() => {
      const slot=Array.from(document.querySelectorAll('.workspace-workbench-slot')).find(e=>e.dataset.workspaceId===${JSON.stringify(record.id)});
      return slot?.dataset.visible==='true'&&slot.getClientRects().length>0&&getComputedStyle(slot).visibility!=='hidden'
    })()`), true, 'The new project is actually selected and visible; preserved inactive Views remain mounted')
    const observedPreview = await waitFor('one actual prewarm owner in the selected project', () => probe.cdp.evaluate(`(() => {
      const slot=Array.from(document.querySelectorAll('.workspace-workbench-slot')).find(e=>e.dataset.workspaceId===${JSON.stringify(record.id)});
      const buttons=slot?.querySelectorAll('.launch-terminal__claim[data-agentmux-session-id]');
      const ids=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.unclaimedTerminalSessionIds;
      if(buttons?.length!==1||!Array.isArray(ids))return false;
      const id=buttons[0].dataset.agentmuxSessionId;return ids.includes(id)?{claimSessionId:id,unclaimedTerminalSessionIds:ids}:false
    })()`))
    const previewId = observedPreview.claimSessionId
    assert.equal(typeof previewId, 'string'); assert.ok(previewId.length > 0)
    assert.equal(selectedPreviews.has(previewId), false, 'Each newly selected project has its own actual preview')
    assert.equal(Array.from(selectedPreviews.values()).some(preview => preview.path === record.path), false)
    const preview = { workspaceId: record.id, hostId: record.hostId, path: record.path, groupId: group.id }
    selectedPreviews.set(previewId, preview)
    facts.previewOwners ??= []
    facts.previewOwners.push({ id: previewId, ...preview, ...observedPreview })
    await assertSessionContinuity('explicit UI project selection')
    await activate(probe.cdp, `${nodes('.project-rail-row[data-workspace-id]')}.filter(e=>e.dataset.workspaceId===${JSON.stringify(workspaceId)})`)
    await waitFor('real UI returned to the original split', async () => (await snapshot()).selection.activeWorkspaceId === workspaceId && (await surface(probe)).regions.length === before.surface.regions.length)
    expected.selection = before.selection
    assert.deepEqual(await snapshot(), expected, 'All original Tab/group/Region/focus/draft facts survive the explicit project round trip')
    facts.ui.push({ id: record.id, exactOriginalPreserved: true, oneEmptyLayoutAdded: true, returnedThroughRealUi: true })
    await show()
    return expected
  }
  async function capturePreparation() {
    const mainPath = join(desktopRoot, 'out/main/index.js')
    const lines = (await readFile(mainPath, 'utf8')).split('\n')
    const found = lines.flatMap((line, index) => line.includes('if (request.operation === "settings.get" || request.operation === "settings.set")') ? [index] : [])
    assert.equal(found.length, 1, 'One actual compiled Main owner dispatch boundary')
    const point = await probe.main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: found[0] })
    const pending = command(['settings', 'get', 'copyPathsAsAbsolute'])
    pending.catch(() => {}) // The original rejection is awaited below after the inspector is released.
    try {
      const paused = await waitFor('owned Main preparation capture', () => probe.main.pauses.shift())
      assert.ok(paused.hitBreakpoints?.includes(point.breakpointId))
      const result = await probe.main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
        expression: `(() => { const runtime=args.runtime; const fixture=${fixtureName}={};
          fixture.hold=()=>{const original=runtime.prepare;const held=new Promise(resolve=>{fixture.release=resolve});fixture.entered=false;
            runtime.prepare=async(...input)=>{runtime.prepare=original;fixture.entered=true;await held;return original.apply(runtime,input)}};
          return typeof fixture.hold })()`, returnByValue: true })
      assert.equal(result.exceptionDetails, undefined); assert.equal(result.result.value, 'function')
    } finally {
      await probe.main.call('Debugger.removeBreakpoint', { breakpointId: point.breakpointId })
      await probe.main.call('Debugger.resume')
    }
    await pending
  }
  async function sessionFact() {
    return probe.cdp.evaluate(`(async()=>{
      const snapshot=await window.agentmux.sessions.snapshot();const session=snapshot.sessions.find(item=>item.id===${JSON.stringify(sessionId)});
      if(!session)throw new Error('Original healthy Session absent');
      let history;try{history={page:await window.agentmux.sessions.historyPage(session.control,{limit:5})}}catch(error){history={error:error.message}}
      return {sessions:snapshot.sessions.map(({id,kind,providerId,hostId,workspacePath,control,processState})=>({id,kind,providerId,hostId,workspacePath,control,processState})).sort((a,b)=>a.id.localeCompare(b.id)),processState:session.processState,control:session.control,history}
    })()`)
  }
  async function assertSessionContinuity(observation, allowUiPreviews = true) {
    const current = await sessionFact()
    const { sessions: originalSessions, ...originalHealthy } = originalSession
    const { sessions: currentSessions, ...currentHealthy } = current
    facts.sessions ??= []
    facts.sessions.push({ observation, ...current })
    assert.deepEqual(currentHealthy, originalHealthy, 'The original healthy Agent and honest History remain usable')
    const originalIds = new Set(originalSessions.map(session => session.id))
    assert.deepEqual(currentSessions.filter(session => originalIds.has(session.id)), originalSessions, 'Every original Session keeps its identity and process state')
    assert.deepEqual(currentSessions.filter(session => session.kind === 'agent'), originalSessions.filter(session => session.kind === 'agent'), 'Registration never launches or replaces an Agent')
    const additions = currentSessions.filter(session => !originalIds.has(session.id))
    if (!allowUiPreviews) assert.deepEqual(additions, [], 'CLI-only registration never launches any Session')
    assert.ok(additions.length <= selectedPreviews.size, 'At most one preview is admitted for each explicit UI selection')
    for (const session of additions) {
      const preview = selectedPreviews.get(session.id)
      assert.ok(preview, 'Every extra Session is the exact preview observed from the existing UI prewarm owner')
      assert.equal(session.kind, 'terminal'); assert.equal(session.providerId, null)
      assert.equal(session.control.kind, 'terminal'); assert.equal(session.hostId, preview.hostId)
      assert.equal(session.workspacePath, preview.path)
      assert.equal(session.control.runId, session.id); assert.equal(session.control.run.runId, session.id)
    }
  }

  async function exercise() {
    phase('workspace-cli-current-registration')
    await probe.cdp.evaluate(`(() => { window.__settingsWorkspaceRegistrationEvents=[];
      window.agentmux.config.onChange(config=>window.__settingsWorkspaceRegistrationEvents.push(config.workspaces));
      window.__settingsWorkspaceNativeInput=[];
      for(const type of ['click','input','change'])document.addEventListener(type,event=>{
        if(event.target?.closest?.(${JSON.stringify(pane)}))window.__settingsWorkspaceNativeInput.push({type,trusted:event.isTrusted,tag:event.target.tagName})
      });return true })()`)
    await show()
    const original = { surface: structuredClone(originalSurface), selection: { activeWorkspaceId: workspaceId, mainSurface: 'workbench' } }
    assert.deepEqual(await snapshot(), original, 'Workspace baseline is the already asserted original strong surface, not a new post-operation expectation')
    const initial = await read(), originalRecord = initial.workspaces.find(item => item.id === workspaceId)
    let expected = structuredClone(original)
    assert.ok(originalRecord); assert.ok(original.surface.tabs.length > 0); assert.ok(original.surface.regions.length > 1)
    originalSession = await sessionFact(); assert.equal(originalSession.processState, 'running')
    await unchanged({ hostId: 'local', path: originalRecord.path + '/', name: 'Never rename the original' }, originalRecord)
    const literal = join(root, '~literal-trailing ')
    const cliFirst = await add({ hostId: 'local', path: literal, name: '   ' })
    assert.equal(cliFirst.path, literal); assert.equal(cliFirst.name, '~literal-trailing '); assert.equal(cliFirst.kind, 'folder')
    await assert.rejects(stat(literal), { code: 'ENOENT' })
    await waitFor('current Settings receives CLI registration', () => probe.cdp.evaluate(`${nodes(`${pane} .workspace-settings-list small`)}.some(e=>e.textContent===${JSON.stringify(literal)})`))
    assert.deepEqual(await snapshot(), original, 'CLI Add neither selects a project nor changes a layout')
    await unchanged({ hostId: 'local', path: literal + '/.', name: 'Never rename the registered record' }, cliFirst)
    const [one, two] = await Promise.all([add({ hostId: 'local', path: join(root, 'cli-one') }), add({ hostId: 'local', path: join(root, 'cli-two') })])
    assert.notEqual(one.id, two.id); assert.deepEqual((await read()).workspaces.filter(item => item.id === one.id || item.id === two.id).sort((a, b) => a.id.localeCompare(b.id)), [one, two].sort((a, b) => a.id.localeCompare(b.id)))
    assert.deepEqual(await snapshot(), original)
    facts.cli.push({ literal: cliFirst, disjoint: [one, two], noDirectoryCreated: true, exactSurfacePreserved: true })
    for (const input of [{ hostId: 'missing', path: join(root, 'invalid-host') }, { hostId: 'local', path: '' }, { hostId: 'local', path: join(root, 'invalid-id'), id: 'caller-id' }]) {
      const bytes = await readFile(configPath), count = await publications()
      const result = await command(['settings', 'workspaces', 'add', '--input', '-'], 1, JSON.stringify(input))
      assert.equal(result.error.code, 'INVALID_SETTING_VALUE'); assert.deepEqual(await readFile(configPath), bytes); assert.equal(await publications(), count)
      facts.invalid.push({ code: result.error.code, bytesUnchanged: true, publicationsUnchanged: true })
    }
    await assertSessionContinuity('CLI-only registrations', false)

    phase('workspace-cli-first-ui-same-identity')
    let before = await snapshot(), bytes = await readFile(configPath), count = await publications()
    await form(literal + '/.', 'Never rename via UI'); await submit(); expected = await selected(cliFirst, before)
    assert.deepEqual(await readFile(configPath), bytes); assert.equal(await publications(), count)
    phase('workspace-ui-first-cli-same-identity')
    before = await snapshot(); assert.deepEqual(before, expected); const uiPath = join(root, 'ui-first')
    await form(`  ${uiPath}  `, '  Authored UI name  '); await submit()
    await waitFor('actual UI record committed', async () => (await read()).workspaces.some(item => item.path === uiPath))
    const uiFirst = (await read()).workspaces.find(item => item.path === uiPath)
    assert.equal(uiFirst.name, 'Authored UI name'); expected = await selected(uiFirst, before)
    await unchanged({ hostId: 'local', path: uiPath + '/', name: '' }, uiFirst)

    phase('workspace-concurrent-ui-cli-admission')
    await capturePreparation(); await probe.main.evaluate(`${fixtureName}.hold()`)
    before = await snapshot(); assert.deepEqual(before, expected); const concurrentPath = join(root, 'same-concurrent')
    const first = add({ hostId: 'local', path: concurrentPath, name: 'CLI admitted first' })
    first.catch(() => {}) // Cleanup may need to release preparation before this original rejection is awaited.
    let same
    try {
      await waitFor('actual registration preparation is held', () => probe.main.evaluate(`${fixtureName}.entered`))
      await form(concurrentPath + '/', 'UI must reuse'); await submit()
      await assertSessionContinuity('held configuration admission')
      await command(['settings', 'get', 'copyPathsAsAbsolute'])
      assert.deepEqual(await snapshot(), before, 'The pending UI has not invented a registration or selected a project')
    } finally { await probe.main.evaluate(`${fixtureName}.release()`) }
    same = await first; expected = await selected(same, before)
    assert.equal((await read()).workspaces.filter(item => item.id === same.id).length, 1)
    facts.concurrent = { id: same.id, sharedIdentity: true, healthySessionAndHistoryPreserved: true, readonlyOwnerAvailable: true }

    phase('workspace-failed-persistence-keeps-ui-draft')
    before = await snapshot(); assert.deepEqual(before, expected); const retryPath = join(root, 'explicit-retry'), backup = configPath + '.workspace-held'
    const preservedBytes = await readFile(configPath); count = await publications()
    await form(retryPath, 'Retry retained'); await rename(configPath, backup); await mkdir(configPath)
    try {
      await submit()
      await waitFor('actual failed registration is visible', () => probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${composer} .dialog-error`)}))`))
      assert.equal(await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(`${composer} input[placeholder="/path/to/project"]`)}).value`), retryPath)
      assert.equal(await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(`${composer} input[placeholder="Project name"]`)}).value`), 'Retry retained')
      assert.deepEqual(await readFile(backup), preservedBytes); assert.equal(await publications(), count)
      assert.deepEqual(await snapshot(), before)
    } finally { await rmdir(configPath); await rename(backup, configPath) }
    await submit(); await waitFor('explicit retry is committed', async () => (await read()).workspaces.some(item => item.path === retryPath))
    expected = await selected((await read()).workspaces.find(item => item.path === retryPath), before)
    facts.failedSave = { bytesPreserved: true, publicationUnchanged: true, originalWorkbenchPreserved: true, fieldsRetained: true, explicitRetrySucceeded: true }
    assert.deepEqual(configExceptWorkspaces(await read()), configExceptWorkspaces(initial), 'Every other settings domain is preserved')
    for (const item of initial.workspaces) assert.deepEqual((await read()).workspaces.find(value => value.id === item.id), item)
    await assertSessionContinuity('completed UI and CLI registrations')
    assert.deepEqual(await snapshot(), expected, 'Final restart expectations come from the asserted original plus explicit UI actions')
    facts.expectedSurface = expected.surface
    facts.expectedSelection = expected.selection
    facts.expectedWorkspaces = (await read()).workspaces
    facts.nativeInput = await probe.cdp.evaluate('window.__settingsWorkspaceNativeInput')
    assert.ok(facts.nativeInput.length > 0); assert.ok(facts.nativeInput.some(event => event.type === 'input'))
    assert.ok(facts.nativeInput.every(event => event.trusted === true))
  }
  async function verifyRestart(target) {
    phase('workspace-complete-restart-records')
    assert.deepEqual((await read()).workspaces, facts.expectedWorkspaces)
    const restored = await target.cdp.evaluate(`(() => { const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;return {activeWorkspaceId:state.activeWorkspaceId,mainSurface:state.mainSurface} })()`)
    assert.deepEqual(restored, facts.expectedSelection)
    await section(target, 'Workspaces', 'workspaces')
    const paths = await target.cdp.evaluate(`${nodes(`${pane} .workspace-settings-list small`)}.map(e=>e.textContent)`)
    assert.ok(paths.length > 0); assert.deepEqual(paths.sort(), facts.expectedWorkspaces.map(item => item.path).sort())
    facts.restart = { exactWorkspaces: true, exactSelectedWorkspace: true, currentUiRecords: true }
  }
  async function verifyNoView() {
    phase('workspace-main-owner-without-view')
    const original = facts.expectedWorkspaces[0]
    const bytes = await readFile(configPath)
    assert.deepEqual(await add({ hostId: original.hostId, path: original.path, name: '' }, false), original)
    assert.deepEqual(await readFile(configPath), bytes)
    const added = await add({ hostId: 'local', path: join(root, 'no-view-project'), name: 'Main without a View' })
    assert.deepEqual((await read()).workspaces, [...facts.expectedWorkspaces, added])
    facts.noView = { actual: added, noRendererRequired: true, originalRecordsPreserved: true, duplicateNochange: true }
  }
  async function verifyOffline() {
    phase('workspace-offline-owner')
    const bytes = await readFile(configPath)
    const result = await command(['settings', 'workspaces', 'add', '--input', '-'], 1, JSON.stringify({ hostId: 'local', path: join(root, 'offline-project') }))
    assert.equal(result.error.code, 'CONTROL_UNAVAILABLE'); assert.deepEqual(await readFile(configPath), bytes)
    facts.offline = { code: result.error.code, configUnchanged: true }
  }
  return { facts, exercise, verifyRestart, verifyNoView, verifyOffline }
}
