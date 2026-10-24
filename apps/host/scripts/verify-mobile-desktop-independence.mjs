import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bindCandidate, digest } from '../test/fixtures/mobile-desktop-independence/candidate-inputs.mjs'
import { compiledHostFixture, until } from '../test/fixtures/mobile-desktop-independence/compiled-host-fixture.mjs'
import { privateMobileBrowser, openMobile, openOriginalSession, mobileInput, dropReply, browserState,
  readOriginalContent, editOriginalGoal, editOriginalNote, recoverOriginalSession, openNewMobileConnection, waitOriginalConnection,
  createMobileAgentTab, inspectOriginalCreation, dropCreationReply, captureOriginalCreation, continueOriginalCreation } from '../test/fixtures/mobile-desktop-independence/private-browser.mjs'

const args = process.argv.slice(2), value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback
const repository = resolve(value('--repository', process.cwd())), directory = resolve(value('--output', join(repository, '.local/state/mobile-independent-host/join')))
const serviceReceipt = resolve(value('--service-receipt', join(repository, '.local/state/mobile-independent-host/service/receipt.json')))
await mkdir(directory, { recursive: true })
const receipt = { schema: 'agentmux.mobile-desktop-independence.v1', passed: false,
  scope: 'Actual compiled main Desktop and Mobile, private Chrome mobile context, compiled original Node Host library, official ctxmux and the maintained native Provider CLI fixture. Desktop quit/reopen and manual Host restart are real. Platform automatic recovery is joined separately from the same-candidate launchd proof. No installed user App, commercial Provider CLI, physical phone, cloud deployment, logout or power-loss qualification.',
  phases: [], cleanup: {} }
let candidate, fixture, browser, failed, stopCoreErrors
const coreErrors = { events: [], omitted: 0 }
const observeCoreErrors = () => {
  stopCoreErrors?.()
  stopCoreErrors = fixture.sdk.onEvent(event => {
    if (event.type !== 'agent-error') return
    const text = JSON.stringify(event), bytes = Buffer.byteLength(text)
    coreErrors.events.push(bytes <= 65536 ? structuredClone(event) : {
      type: event.type, agentSessionId: event.agentSessionId, code: event.code,
      failure: { logId: event.failure?.logId }, omitted: { bytes, digest: digest(text) }
    })
    if (coreErrors.events.length > 16) { coreErrors.events.shift(); coreErrors.omitted++ }
  })
}
const phase = (name, result) => { receipt.phases.push({ name, result }); process.stdout.write(JSON.stringify({ phase: name, confirmed: true }) + '\n') }
const expectSameRun = (observed, original) => {
  assert.equal(observed.session.agentSessionId, original.session.agentSessionId)
  assert.equal(observed.session.run.runId, original.session.run.runId)
  assert.equal(observed.run.pid, original.run.pid); assert.equal(observed.run.state, 'running')
  assert.deepEqual(observed.session.nativeHandle, original.session.nativeHandle)
  assert.equal(observed.session.workspacePath, original.session.workspacePath)
}
const sameDevice = (observed, original) => {
  assert.equal(observed.publicKey, original.publicKey); assert.deepEqual(observed.record.host, original.record.host)
  assert.equal(observed.record.recordId, original.record.recordId)
}
function sameOriginalInput(current, original) {
  assert.ok(current); assert.deepEqual(current.key, original.key); assert.deepEqual(current.ref, original.ref)
  assert.equal(current.status, original.status); assert.equal(current.persistence, 'confirmed')
  assert.equal(current.admission?.agentSessionId, original.admission?.agentSessionId)
  assert.deepEqual(current.admission?.run, original.admission?.run)
  assert.equal(current.admission?.admission?.submissionId, original.admission?.admission?.submissionId)
  assert.equal(current.admission?.admission?.acknowledged, true)
}
function desktopSeed(f) {
  const sid = f.original.agentSessionId, id = 'original-workspace'
  return { version: 1, state: { activeWorkspaceId: id, mainSurface: 'workbench',
    agentFocus: { execution: { sessionId: sid, history: [{ sessionId: sid, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [sid]: 'Original unsent Desktop draft' }, restoredWorkbench: {
      tabs: { 'original-tab': { id: 'original-tab', workspaceId: id, titleRegionId: 'original-agent-region',
        layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: 'original-agent-region' }, second: { type: 'leaf', regionId: 'original-file-region' } }, activeRegionId: 'original-agent-region' },
        regions: { 'original-agent-region': { regionId: 'original-agent-region', kind: 'agent', phase: 'attached', workspaceId: id, sessionId: sid },
          'original-file-region': { regionId: 'original-file-region', kind: 'file', workspaceId: id, path: 'original.note.md' } } } },
      layouts: { [id]: { root: { type: 'leaf', groupId: 'original-group' }, groups: [{ id: 'original-group', tabOrder: ['original-tab'], activeTabId: 'original-tab', recentTabIds: ['original-tab'] }], activeGroupId: 'original-group' },
        __scratch__: { root: { type: 'leaf', groupId: 'original-scratch-group' }, groups: [{ id: 'original-scratch-group', tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: 'original-scratch-group' } }
    } } }
}
async function originalDesktop(probe, seed, sid, addedTab) {
  await until('actual original nonempty Desktop Regions', () => probe.cdp.evaluate(`Array.from(document.querySelectorAll('[data-workbench-region-id]')).filter(e=>e.getClientRects().length).map(e=>e.dataset.workbenchRegionId).sort()`),
    regions => regions.includes('original-agent-region') && regions.includes('original-file-region'))
  const state = await probe.cdp.evaluate(`(async () => {const s=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;return {spatial:await window.agentmux.spatial.read(),focus:s.agentFocus,draft:s.agentComposerDrafts[${JSON.stringify(sid)}]}})()`)
  const graph = state.spatial.graph, expected = seed.state.restoredWorkbench, originalTab = expected.tabs['original-tab']
  const tabs = graph.tabs.filter(tab => tab.tabId === 'original-tab')
  assert.equal(tabs.length, 1); assert.equal(tabs[0].workspaceId, originalTab.workspaceId)
  assert.deepEqual(tabs[0].regionIds, Object.keys(originalTab.regions))
  assert.deepEqual(graph.tabLayouts['original-tab'], originalTab.layout)
  assert.equal(graph.resources['tab:original-tab'].titleRegionId, originalTab.titleRegionId)
  for (const original of Object.values(originalTab.regions)) {
    const regions = graph.regions.filter(region => region.tabId === 'original-tab' && region.regionId === original.regionId)
    assert.equal(regions.length, 1); assert.equal(regions[0].kind, original.kind)
    assert.equal(graph.resources['region:' + original.regionId].workspaceId, original.workspaceId)
    if (original.kind === 'agent') assert.equal(regions[0].agentSessionId, original.sessionId)
    else assert.equal(regions[0].file.path, original.path)
  }
  assert.deepEqual(graph.layouts.__scratch__, expected.layouts.__scratch__)
  if (addedTab) {
    assert.ok(graph.tabs.some(tab => tab.tabId === addedTab.tabId), 'Desktop must retain the Tab created from the disconnected Mobile client')
    const regions = graph.regions.filter(region => region.tabId === addedTab.tabId && region.regionId === addedTab.regionId)
    assert.equal(regions.length, 1); assert.equal(regions[0].agentSessionId, addedTab.agentSessionId)
    await until('actual Desktop renders the Mobile-created Tab', () => probe.cdp.evaluate(`Boolean(document.querySelector('.workbench-tab[data-workbench-tab-id="${addedTab.tabId}"]'))`))
    const layout = graph.layouts['original-workspace'], originalLayout = expected.layouts['original-workspace']
    assert.deepEqual(layout.root, originalLayout.root); assert.equal(layout.activeGroupId, originalLayout.activeGroupId)
    const group = layout.groups.find(group => group.id === 'original-group')
    assert.ok(group.tabOrder.includes(addedTab.tabId))
    assert.deepEqual(group.tabOrder.filter(tabId => tabId !== addedTab.tabId), originalLayout.groups[0].tabOrder)
    assert.deepEqual(group.recentTabIds, originalLayout.groups[0].recentTabIds)
    assert.equal(group.activeTabId, 'original-tab')
  } else assert.deepEqual(graph.layouts['original-workspace'], expected.layouts['original-workspace'])
  assert.deepEqual(state.focus, seed.state.agentFocus)
  assert.equal(state.draft, seed.state.agentComposerDrafts[sid])
  const sessions = await until('actual Desktop consumes original Host Session', () => probe.cdp.evaluate('window.agentmux.sessions.snapshot()'), snapshot => snapshot.sessions.some(session => session.id === sid))
  const session = sessions.sessions.find(session => session.id === sid)
  assert.equal(session.processState, 'running')
  return { ...state, session }
}
async function originalInput(f, observed, marker) {
  const attempt = observed.attempt, manual = attempt.manualInput
  assert.ok(manual, 'Real Mobile must retain the exact original input request')
  assert.equal(manual.agentSessionId, f.original.agentSessionId); assert.deepEqual(manual.expectedRun, f.original.run)
  const key = { kind: 'prompt', agentSessionId: manual.agentSessionId, expectedRun: manual.expectedRun, submissionId: attempt.operationId }
  const proof = { observed, key, marker }
  ;(receipt.inputs ??= []).push(proof)
  const input = await until('public original input receipt', () => f.sdk.inspectAgentInput({ key }), value => value?.status === 'terminal-confirmed' || value?.status === 'admitted')
  proof.input = input
  assert.deepEqual(input.key, key)
  assert.equal(input.admission?.admission?.submissionId, key.submissionId)
  assert.equal(input.admission?.admission?.acknowledged, true)
  const intent = input.admission?.admission?.intent
  assert.ok(intent); assert.deepEqual(intent.run, key.expectedRun)
  assert.equal(intent.message.userContent, marker)
  const accepted = ('codex-submit:' + intent.prompt + ':accepted').replaceAll('\r\n', '\n')
  try {
    const output = await until('actual Provider receives original Mobile input', async () => {
      proof.replay = await f.sdk.readRunReplay(f.original.run, 0, 'raw')
      assert.equal(proof.replay.run.runId, key.expectedRun.runId)
      return proof.replay.replay.map(chunk => chunk.data).join('').replaceAll('\r\n', '\n')
    }, text => text.includes(accepted))
    assert.equal(output.split(accepted).length - 1, 1, 'The exact input must reach the original native process once')
  } catch (error) {
    proof.failureObservations = Object.fromEntries(await Promise.all([
      ['currentInput', () => f.sdk.inspectAgentInput({ key })],
      ['status', () => f.sdk.statusAgent(f.original.agentSessionId)],
      ['nativeTranscript', () => readFile(f.original.nativeHandle.transcriptPath, 'utf8')]
    ].map(async ([name, read]) => {
      try { return [name, { status: 'observed', value: await read() }] }
      catch (observation) { return [name, { status: 'unavailable', code: observation.code, message: observation.message }] }
    })))
    throw error
  }
  return { key, input, marker }
}
async function servedMobile(f, loaded, candidate) {
  const path = '/mobile/' + candidate.input.mobile.buildId + '/' + candidate.input.mobile.digest.slice('sha256:'.length) + '/'
  assert.equal(new URL(loaded.url).pathname, path + 'index.html')
  assert.ok(loaded.scripts.length > 0)
  const resources = []
  for (const file of candidate.input.mobile.files) {
    const response = await fetch(new URL(path + file.path, f.ready.origin), { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.digest)
    resources.push({ path: file.path, digest: file.digest })
  }
  const reports = await until('actual page loaded report accepted by original Host', () => f.rpc.call('app.mobile.assets.inspect', { hostId: 'local' }),
    state => state.active?.digest === candidate.input.mobile.digest && state.clients.some(client => client.accepted && client.buildId === candidate.input.mobile.buildId && client.namespaceDigest === candidate.input.mobile.digest))
  return { path, resources, reports }
}

try {
  candidate = await bindCandidate(repository, join(directory, 'candidate'))
  receipt.candidate = { commit: candidate.input.commit, tree: candidate.input.tree, digest: digest(JSON.stringify(candidate.input)) }
  const service = JSON.parse(await readFile(serviceReceipt, 'utf8'))
  assert.equal(service.schema, 'agentmux.host-service-qualification.v1'); assert.equal(service.platform.passed, true)
  assert.equal(service.candidate?.commit, candidate.input.commit, 'The platform lifecycle proof must execute against this same integrated main commit')
  assert.equal(service.candidate?.tree, candidate.input.tree)
  assert.equal(service.candidate.inMain, true)
  assert.equal(service.candidate.clean, true); assert.equal(service.candidate.unchanged, true)
  assert.deepEqual(service.environment, { platform: process.platform, architecture: process.arch, node: process.versions.node })
  assert.equal(service.platform.command, 'node apps/host/scripts/verify-host-service-lifecycle.mjs --mutations')
  assert.equal(service.platform.status, 'baseline-and-mutations-confirmed')
  assert.equal(Object.keys(service.sources).length, 6)
  assert.deepEqual(Object.keys(service.platform.mutants).sort(), ['restart', 'stop-fence'])
  for (const [name, mutant] of Object.entries(service.platform.mutants)) {
    assert.equal(mutant.mutation, name); assert.equal(mutant.rejected, true)
    assert.ok(Number.isInteger(mutant.exitCode) && mutant.exitCode !== 0)
    assert.equal(mutant.originalSourceSHA256, service.sources['apps/host/src/macos-service.ts'])
    assert.notEqual(mutant.originalSourceSHA256, mutant.evaluatedSourceSHA256)
    assert.equal(mutant.assertion, name === 'restart' ? 'platform automatic Host recovery was not confirmed' : 'Missing expected rejection.')
  }
  assert.equal(Object.keys(service.artifacts).length, 7)
  for (const [path, sha] of Object.entries(service.artifacts)) assert.equal(candidate.input.artifactHashes[path], sha, 'Platform proof executed a different artifact: ' + path)
  assert.deepEqual(Object.keys(service.compiled).sort(), ['connector', 'entrypoint', 'service'])
  for (const [path, sha] of Object.entries(service.sources)) assert.equal(candidate.input.sourceHashes[path], sha, 'Platform proof must belong to this exact candidate: ' + path)
  receipt.platform = { digest: digest(JSON.stringify(service)), scope: service.scope }
  fixture = await compiledHostFixture(candidate)
  observeCoreErrors()
  const noteDocument = await import(pathToFileURL(join(repository, 'packages/client-ui/dist/note/note-document.js')).href)
  await writeFile(join(fixture.workspace, 'original.note.md'), noteDocument.serializeNoteDocument(noteDocument.newNoteDocument(
    'Original retained Mobile paragraph.', 'original-note', 'original-block', 'Original mobile Note')))
  const seed = desktopSeed(fixture), desktop = await fixture.startDesktop(seed), sid = fixture.original.agentSessionId
  const original = await fixture.sdk.statusAgent(sid), owner = fixture.ready.owner, nativeProcessId = fixture.nativeProcessId
  const desktopBefore = await originalDesktop(desktop, seed, sid)
  const originalView = await fixture.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: sid } })
  const originalName = await fixture.rpc.call('agent.rename', { agentSessionId: sid, name: 'Original private Mobile Agent',
    expectedNameRevision: originalView.displayName.nameRevision ?? 0, operationId: 'original-mobile-name' })
  assert.equal(originalName.save.diskDurability, 'confirmed')
  const graphBefore = (await fixture.rpc.call('space.state', {})).state
  assert.ok(graphBefore.graph.tabs.some(tab => tab.tabId === 'original-tab'))
  assert.ok(graphBefore.graph.regions.some(region => region.agentSessionId === sid))
  const name = (await fixture.rpc.call('space.ls', { target: {}, presentation: true })).catalog.agentPresentation.find(row => row.agentSessionId === sid)?.name
  assert.ok(name)
  const goal = (await fixture.rpc.call('goal.create', { goalId: 'original-mobile-goal', title: 'Original Mobile Goal', description: 'Original authorized goal body.',
    status: 'backlog', operationId: 'original-mobile-goal-create', risk: 'low', confirmation: 'user' })).goal
  phase('compiled-original-host-desktop-native', { owner, original, inputReadiness: fixture.original.terminalPromptReadiness, desktop: desktopBefore, graph: graphBefore, goal })
  browser = await privateMobileBrowser(join(directory, 'browser'))
  const url = fixture.ready.origin + '#offer=' + Buffer.from(JSON.stringify(fixture.ready.offer)).toString('base64url')
  const loaded = await browser.action('open-original-mobile', openMobile, { url })
  const assets = await servedMobile(fixture, loaded, candidate)
  await browser.action('open-original-session', openOriginalSession, { sessionId: sid, name })
  const beforeInput = 'before-desktop-exit-' + randomUUID()
  const before = await browser.action('input-before-desktop-exit', mobileInput, { sessionId: sid, marker: beforeInput })
  const beforeReceipt = await originalInput(fixture, before, beforeInput)
  const deviceBefore = await browser.action('device-before-desktop-exit', browserState)
  const devicesBefore = await fixture.rpc.call('device.ls', {})
  phase('formal-mobile-original-connection', { loaded, assets, device: deviceBefore, devices: devicesBefore, input: beforeReceipt })
  await fixture.quitDesktop()
  const afterOwner = (await fixture.rpc.call('runtime.owner.identity', {})).owner
  assert.deepEqual(afterOwner, owner, 'Ordinary Desktop quit must not restart or replace the original Host')
  expectSameRun(await fixture.sdk.statusAgent(sid), original)
  const afterInput = 'after-desktop-exit-' + randomUUID()
  const after = await browser.action('input-after-desktop-exit', mobileInput, { sessionId: sid, marker: afterInput })
  const afterReceipt = await originalInput(fixture, after, afterInput)
  let content
  try {
    content = await browser.action('content-after-desktop-exit', readOriginalContent,
      { workspaceName: 'Original mobile workspace', fileName: 'original.note.md', body: 'Original retained Mobile paragraph.' })
  } catch (error) {
    receipt.contentFailure = {}
    try {
      const { catalog } = await fixture.rpc.call('space.inspect', { target: { regionId: 'original-file-region' }, presentation: true })
      receipt.contentFailure.catalog = catalog
      const regions = catalog.regions.filter(region => region.regionId === 'original-file-region')
      assert.equal(regions.length, 1)
      const tab = catalog.tabs.find(tab => tab.tabId === regions[0].tabId)
      const params = { zoneId: tab.zoneId, path: regions[0].file.zoneRelativePath,
        expectedResource: { hostId: 'local', workspaceId: regions[0].file.workspaceId, workspacePath: fixture.workspace } }
      receipt.contentFailure.params = params
      receipt.contentFailure.read = await fixture.rpc.call('file.read', params)
    } catch (observation) { receipt.contentFailure.unavailable = { code: observation.code, message: observation.message } }
    throw error
  }
  const editedNoteBody = 'Mobile saved the original Note after Desktop quit.'
  const note = await browser.action('edit-note-after-desktop-exit', editOriginalNote, { body: editedNoteBody })
  const originalTab = graphBefore.graph.tabs.find(tab => tab.tabId === 'original-tab')
  assert.ok(originalTab.zoneId)
  const fileScope = { zoneId: originalTab.zoneId, path: 'original.note.md', expectedResource: { hostId: 'local', workspaceId: 'original-workspace', workspacePath: fixture.workspace } }
  const savedNote = await fixture.rpc.call('file.read', fileScope)
  assert.equal(savedNote.result.status, 'read'); assert.ok(savedNote.result.document.content.includes(editedNoteBody))
  assert.ok(savedNote.resource)
  const noteHistoryScope = { ...fileScope, expectedResource: savedNote.resource, noteId: 'original-note' }
  const listedHistory = await fixture.rpc.call('file.history', noteHistoryScope)
  assert.equal(listedHistory.result.status, 'read')
  const historyMatches = listedHistory.result.entries.filter(entry => entry.revision === savedNote.result.document.revision && entry.status === 'committed')
  assert.equal(historyMatches.length, 1, 'The saved Note revision must have one exact original history event')
  const noteHistory = await fixture.rpc.call('file.history', { ...noteHistoryScope, eventId: historyMatches[0].eventId, includeContent: true })
  assert.ok(JSON.stringify(noteHistory).includes(editedNoteBody), 'Real Mobile Note save must enter original Note history')
  const changedBody = 'Mobile saved this same Goal after Desktop quit.'
  const editedGoal = await browser.action('goal-after-desktop-exit', editOriginalGoal, { title: goal.title, description: changedBody })
  assert.equal((await fixture.rpc.call('goal.inspect', { goalId: goal.id })).goal.description, changedBody)
  phase('desktop-exit-original-mobile-stays-operational', { owner: afterOwner, input: afterReceipt, content, note, noteHistory, goal: editedGoal })
  const newConnection = await browser.action('new-connection-after-desktop-exit', openNewMobileConnection, { url })
  await browser.action('new-connection-original-session', openOriginalSession, { page: 'second', sessionId: sid, name })
  const newDevice = await browser.action('new-connection-original-device', browserState, { page: 'second' })
  sameDevice(newDevice, deviceBefore)
  await browser.action('new-connection-original-content', readOriginalContent,
    { page: 'second', workspaceName: 'Original mobile workspace', fileName: 'original.note.md', body: editedNoteBody })
  const newGoalBody = 'A new Mobile connection saved the same original Goal.'
  await browser.action('new-connection-original-goal', editOriginalGoal, { page: 'second', title: goal.title, description: newGoalBody })
  assert.equal((await fixture.rpc.call('goal.inspect', { goalId: goal.id })).goal.description, newGoalBody)
  await browser.action('close-second-connection', async page => { await page.__independentSecond.close(); page.__independentSecond = undefined; return { closed: true } })
  phase('new-mobile-connection-without-desktop', { newConnection, publicKey: newDevice.publicKey, host: newDevice.record.host })
  const zone = graphBefore.graph.zones.find(zone => zone.workspaceId === 'original-workspace')
  const bindings = graphBefore.graph.bindings.filter(binding => binding.zoneId === zone?.zoneId)
  assert.equal(bindings.length, 1)
  const newAgentPrompt = 'Mobile creates an independent original Tab ' + randomUUID()
  const pendingCreate = await browser.action('mobile-creates-original-agent-and-tab', createMobileAgentTab,
    { spaceId: bindings[0].spaceId, zoneId: zone.zoneId, executorId: 'codex', prompt: newAgentPrompt, hold: true })
  assert.ok(pendingCreate.input.operationId)
  const creation = receipt.creation = { intent: pendingCreate }
  let creationReport
  try {
    creationReport = await until('the original Core creation exists while its real reply is withheld', async () => {
      creation.lastInspection = await fixture.rpc.call('space.inspect', { target: { operationId: pendingCreate.input.operationId } })
      return creation.lastInspection.request?.report
    }, report => report?.outcome === 'opened' && report.agent?.initialPrompt === 'confirmed')
  } catch (error) {
    const observe = async read => {
      try { return { status: 'observed', value: await read() } }
      catch (observation) { return { status: 'unavailable', code: observation.code, message: observation.message } }
    }
    creation.currentInspection = await observe(() => fixture.rpc.call('space.inspect', { target: { operationId: pendingCreate.input.operationId } }))
    creation.durableSessions = await observe(async () => (await fixture.sdk.readAgentSessions()).filter(session => session.creation?.createOperationId === pendingCreate.input.operationId))
    creation.sessions = await Promise.all((creation.durableSessions.value ?? []).map(async session => {
      fixture.ownCreatedSession(session.agentSessionId)
      return { session, creation: await observe(() => fixture.sdk.inspectAgentCreation(session.agentSessionId)),
        status: await observe(() => fixture.sdk.statusAgent(session.agentSessionId)),
        replay: await observe(() => fixture.sdk.readRunReplay(session.run, 0, 'raw')),
        nativeTranscript: session.nativeHandle?.kind === 'provider' && session.nativeHandle.transcriptPath
          ? await observe(() => readFile(session.nativeHandle.transcriptPath, 'utf8')) : { status: 'unavailable', message: 'No exact native transcript is recorded.' }
      }
    }))
    creation.browser = await observe(() => browser.action('inspect-original-creation', inspectOriginalCreation, { operationId: pendingCreate.input.operationId }))
    throw error
  }
  const createdSid = creationReport.agent.agentSessionId
  assert.notEqual(createdSid, sid); fixture.ownCreatedSession(createdSid)
  assert.equal(creationReport.agent.createOperationId, pendingCreate.input.operationId)
  assert.ok(creationReport.to?.tabId && creationReport.to?.regionId)
  const addedTab = { ...creationReport.to, agentSessionId: createdSid }
  const newOriginal = await until('actual input-ready Run of Mobile-created Agent', () => fixture.sdk.statusAgent(createdSid),
    value => value.run.state === 'running' && value.run.pid > 1 && Boolean(value.session.nativeHandle) &&
      value.session.run.runId === creationReport.agent.runId && value.run.runId === creationReport.agent.runId &&
      value.observation.process === 'running' && value.observation.source === 'native-transcript' &&
      value.observation.semantic === 'idle' && value.observation.readiness === 'ready' && !value.observation.stale &&
      value.run.nativeService?.input.phase.type === 'open' && value.run.nativeService.input.unsettledCommands === 0 &&
      value.run.nativeService.input.unsettledRequestBytes === 0 && value.run.nativeService.terminalFault === null)
  assert.equal(newOriginal.session.run.runId, creationReport.agent.runId)
  assert.equal(newOriginal.session.workspacePath, fixture.workspace)
  const graphAfterMobileCreate = (await fixture.rpc.call('space.state', {})).state.graph
  assert.equal(graphAfterMobileCreate.tabs.length, graphBefore.graph.tabs.length + 1)
  assert.deepEqual(graphAfterMobileCreate.tabLayouts['original-tab'], graphBefore.graph.tabLayouts['original-tab'])
  assert.deepEqual(graphAfterMobileCreate.regions.filter(region => region.tabId === 'original-tab'), graphBefore.graph.regions.filter(region => region.tabId === 'original-tab'))
  const droppedCreate = await browser.action('discard-original-creation-reply', dropCreationReply, { operationId: pendingCreate.input.operationId })
  const creationCapture = await browser.action('capture-unknown-original-creation', captureOriginalCreation,
    { operationId: pendingCreate.input.operationId, screenshot: join(directory, 'unknown-original-creation.png') })
  assert.deepEqual(creationCapture.intent.input, pendingCreate.input)
  receipt.visual = creationCapture
  const continuedCreate = await browser.action('continue-same-original-creation', continueOriginalCreation, { operationId: pendingCreate.input.operationId })
  const newIntent = continuedCreate.intent
  assert.equal(newIntent.phase, 'confirmed'); assert.equal(newIntent.agentSessionId, createdSid)
  assert.deepEqual(newIntent.input, pendingCreate.input)
  assert.equal(continuedCreate.intents.filter(intent => intent.input.operationId === pendingCreate.input.operationId).length, 1)
  assert.equal(continuedCreate.intents.filter(intent => intent.input.content.prompt === newAgentPrompt).length, 1)
  expectSameRun(await fixture.sdk.statusAgent(createdSid), newOriginal)
  assert.deepEqual((await fixture.rpc.call('space.state', {})).state.graph, graphAfterMobileCreate)
  const createdOutput = (await fixture.sdk.reattachAgent(createdSid, 0, 'raw')).attachment.replay.map(chunk => chunk.data).join('')
  // This maintained CLI parses the original creation prompt from its own argv.
  // Later manual messages use its distinct PTY-submit witness.
  assert.equal(createdOutput.split('codex-ready:').length - 1, 1)
  assert.equal(createdOutput.split(newAgentPrompt).length - 1, 1, 'Continuing the same creation must not deliver its initial instruction twice')
  phase('desktop-absent-mobile-creates-one-original-agent-and-tab', { intent: newIntent, report: creationReport, actual: newOriginal,
    replyLoss: droppedCreate, continuation: continuedCreate, capture: creationCapture })
  await browser.action('return-original-conversation', openOriginalSession, { sessionId: sid, name })
  const unknownMarker = 'unknown-original-input-' + randomUUID()
  const submitted = await browser.action('withhold-real-input-reply', mobileInput, { sessionId: sid, marker: unknownMarker, hold: true })
  const originalUnknown = await originalInput(fixture, submitted, unknownMarker)
  const dropped = await browser.action('discard-withheld-reply', dropReply, { marker: unknownMarker })
  assert.equal(dropped.attempt.phase, 'unknown'); assert.equal(dropped.attempt.operationId, originalUnknown.key.submissionId)
  await browser.action('reconnect-original-page', waitOriginalConnection)
  const draft = 'Original unsent Mobile draft survives Host restart.'
  const mobileBeforeRestart = await browser.action('retain-original-mobile-draft', browserState, { sessionId: sid, draft })
  const restart = await fixture.restartHost()
  observeCoreErrors()
  assert.equal(restart.owner.runtimeId, owner.runtimeId); assert.notEqual(restart.owner.ownerInstanceId, owner.ownerInstanceId)
  assert.deepEqual(restart.owner.ctxmux, owner.ctxmux); assert.equal(fixture.nativeProcessId, nativeProcessId)
  expectSameRun(await fixture.sdk.statusAgent(sid), original)
  expectSameRun(await fixture.sdk.statusAgent(newIntent.agentSessionId), newOriginal)
  await browser.action('same-page-after-host-restart', waitOriginalConnection)
  const mobileAfterRestart = await browser.action('inspect-preserved-mobile-workface', browserState)
  sameDevice(mobileAfterRestart, mobileBeforeRestart)
  assert.equal(mobileAfterRestart.document, mobileBeforeRestart.document, 'Host reconnect must retain the original document and editor')
  assert.equal(mobileAfterRestart.editor, draft)
  const retainedUnknown = mobileAfterRestart.record.conversation.attempts.find(([, attempt]) => attempt.operationId === originalUnknown.key.submissionId)?.[1]
  assert.ok(retainedUnknown); assert.equal(retainedUnknown.draft, unknownMarker)
  sameOriginalInput(await fixture.sdk.inspectAgentInput({ key: originalUnknown.key }), originalUnknown.input)
  assert.deepEqual((await fixture.rpc.call('space.state', {})).state.graph, graphAfterMobileCreate)
  const afterDeviceRegistry = await fixture.rpc.call('device.ls', {})
  assert.deepEqual(afterDeviceRegistry.devices.map(device => device.deviceId).sort(), devicesBefore.devices.map(device => device.deviceId).sort())
  phase('host-restart-original-spatial-device-run-and-unknown-operation', { owner: restart.owner, input: originalUnknown, mobile: mobileAfterRestart, devices: afterDeviceRegistry })
  const reopened = await fixture.startDesktop()
  const restoredDesktop = await originalDesktop(reopened, seed, sid, addedTab)
  expectSameRun(await fixture.sdk.statusAgent(sid), original)
  expectSameRun(await fixture.sdk.statusAgent(newIntent.agentSessionId), newOriginal)
  assert.deepEqual((await fixture.rpc.call('space.state', {})).state.graph, graphAfterMobileCreate,
    'A stale Desktop workface must not overwrite the Mobile-created Tab or its original Run binding')
  await fixture.quitDesktop()
  phase('actual-desktop-reopens-same-workface', restoredDesktop)
  // End only this fixture's original private CLI. A user stop would retire the Session
  // and would not exercise Level B recovery of an ended original Run.
  expectSameRun(await fixture.sdk.statusAgent(sid), original)
  assert.equal(original.session.workspacePath, fixture.workspace)
  assert.ok(Number.isSafeInteger(original.run.pid) && original.run.pid > 1)
  assert.notEqual(original.run.pid, fixture.nativeProcessId)
  // This is an OS fault in the exact private CLI, not the public portable Interrupt action.
  process.kill(original.run.pid, 'SIGTERM')
  await until('original private Run ended', () => fixture.sdk.statusAgent(sid), status => status.run.state === 'exited')
  const recovery = await browser.action('explicit-mobile-original-session-recovery', recoverOriginalSession, { sessionId: sid })
  const resumed = await until('same Session Level B recovery', () => fixture.sdk.statusAgent(sid),
    status => status.run.state === 'running' && status.session.run.runId !== original.session.run.runId)
  assert.equal(resumed.session.agentSessionId, sid); assert.deepEqual(resumed.session.nativeHandle, original.session.nativeHandle)
  assert.equal(resumed.session.workspacePath, original.session.workspacePath)
  const nativeContext = await until('original native retained conversation restored', async () => {
    const attached = await fixture.sdk.reattachAgent(sid, 0, 'raw')
    return attached.attachment.replay.map(chunk => chunk.data).join('')
  }, text => text.includes('codex-restored-context:') && text.includes(beforeInput) && text.includes(afterInput) && text.includes(unknownMarker))
  sameOriginalInput(await fixture.sdk.inspectAgentInput({ key: originalUnknown.key }), originalUnknown.input)
  phase('explicit-mobile-level-b-same-session-and-retained-native-context', { recovery, resumed, restoredContextDigest: digest(nativeContext), originalInput: originalUnknown.key })
  receipt.passed = true
} catch (error) {
  failed = error; receipt.error = { name: error.name, message: error.message, stack: error.stack }
  if (fixture) {
    stopCoreErrors?.(); stopCoreErrors = undefined
    const logIds = [...new Set(coreErrors.events.flatMap(event => event.failure?.logId ? [event.failure.logId] : []))]
    receipt.coreErrors = { ...coreErrors, deliveryAttempts: await Promise.all(logIds.map(async logId => {
      try {
        const value = await fixture.sdk.readDeliveryAttempt(logId), text = JSON.stringify(value), bytes = Buffer.byteLength(text)
        return { logId, ...(bytes <= 131072 ? { status: 'observed', value } : { status: 'omitted', bytes, digest: digest(text) }) }
      } catch (observation) { return { logId, status: 'unavailable', failure: fixture.core.deliveryFailure(observation) } }
    })) }
  }
  if (error.privateBrowserFailure) {
    receipt.browserFailure = error.privateBrowserFailure
    if (fixture) {
      const observed = error.privateBrowserFailure.observation.value, marker = error.privateBrowserFailure.input.marker
      const attempts = observed?.record?.conversation?.attempts?.map(([, attempt]) => attempt).filter(attempt =>
        attempt.manualInput?.agentSessionId === fixture.original.agentSessionId && (!marker || attempt.draft === marker)) ?? []
      const reads = [
        ['status', () => fixture.sdk.statusAgent(fixture.original.agentSessionId)],
        ['replay', () => fixture.sdk.readRunReplay(fixture.original.run, 0, 'raw')],
        ['nativeTranscript', () => readFile(fixture.original.nativeHandle.transcriptPath, 'utf8')],
        ...attempts.map(attempt => ['input:' + attempt.operationId, () => fixture.sdk.inspectAgentInput({ key: {
          kind: 'prompt', agentSessionId: attempt.manualInput.agentSessionId,
          expectedRun: attempt.manualInput.expectedRun, submissionId: attempt.operationId } })])
      ]
      receipt.browserFailure.inputObservation = attempts.length ? 'exact-original-record' : 'unknown-no-original-record'
      receipt.browserFailure.owner = Object.fromEntries(await Promise.all(reads.map(async ([name, read]) => {
        try { return [name, { status: 'observed', value: await read() }] }
        catch (observation) { return [name, { status: 'unavailable', code: observation.code, message: observation.message }] }
      })))
    }
  }
  if (fixture) receipt.failureContext = {
    agentSessionId: fixture.original.agentSessionId, run: fixture.original.run,
    nativeHandle: fixture.original.nativeHandle, workspacePath: fixture.original.workspacePath,
    desktopSeed: Object.fromEntries(await Promise.all(['seed-desktop.stderr.txt', 'ready-seed.json', 'seed-report.json'].map(async name => {
      try {
        const text = await readFile(join(fixture.root, name), 'utf8')
        return [name, { status: text.length > 16384 ? 'truncated' : 'complete', chars: text.length, tail: text.slice(-16384) }]
      } catch (observation) { return [name, { status: 'unavailable', code: observation.code, message: observation.message }] }
    })))
  }
}
finally {
  stopCoreErrors?.()
  for (const [name, close] of [['browser', () => browser?.close()], ['fixture', () => fixture?.close()], ['candidate', () => candidate?.assertUnchanged()]]) {
    try { await close(); receipt.cleanup[name] = 'confirmed' }
    catch (error) { receipt.cleanup[name] = error.message; receipt.passed = false; failed ??= error }
  }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
}
if (failed) throw failed
assert.equal(receipt.passed, true)
process.stdout.write(JSON.stringify({ passed: true, candidate: receipt.candidate, phases: receipt.phases.map(phase => phase.name) }) + '\n')
