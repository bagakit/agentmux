import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// This join consumes explicit qualified evidence; it never launches a capture,
// rebuild, test mutation or Runtime. The original verifiers must report reuse.
const root = resolve(import.meta.dirname, '../../..'), execute = promisify(execFile)
const names = { '--layout-receipt': 'layoutReceipt', '--settings-receipt': 'settingsReceipt', '--config-receipt': 'configReceipt',
  '--scene-receipt': 'sceneReceipt', '--runtime-receipt': 'runtimeReceipt', '--review': 'review', '--inputs': 'inputs', '--evidence': 'evidence' }
const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index]
  if (flag === '--help') {
    console.log('Use --evidence <directory> and --inputs <JSON> (or AGENTMUX_FOCUS_COLLECTION_PRODUCT_INPUTS). JSON fields: layoutReceipt, settingsReceipt, configReceipt, sceneReceipt, runtimeReceipt, review. Corresponding explicit receipt flags override JSON fields.')
    process.exit(0)
  }
  assert.ok(names[flag] && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), 'Unknown or incomplete join argument: ' + flag)
  assert.equal(options[names[flag]], undefined, 'A join argument must be explicit once: ' + flag)
  options[names[flag]] = process.argv[index + 1]
}
assert.ok(options.evidence, 'Use --evidence <private evidence directory>')
const evidence = resolve(root, options.evidence), output = join(evidence, 'receipt.json')
await mkdir(evidence, { recursive: true })
let outputIsInput = false
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const nonempty = (value, label) => { assert.equal(typeof value, 'string', label); assert.ok(value.length > 0, label); return value }
const checksum = (value, label) => { assert.match(nonempty(value, label), /^[a-f0-9]{64}$/, label); return value }
function hashMap(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label)
  assert.ok(Object.keys(value).length > 0, label + ' must not be empty')
  for (const [name, digest] of Object.entries(value)) { nonempty(name, label); checksum(digest, name) }
  return value
}
async function artifact(path) {
  const full = resolve(root, path)
  if (full === output) { outputIsInput = true; throw new Error('Join output must not replace an original input receipt') }
  const bytes = await readFile(full)
  return { path: full, sha256: hash(bytes), value: JSON.parse(bytes) }
}
const reference = value => ({ path: relative(root, value.path), sha256: value.sha256 })
async function checkedRelative(parent, name, digest) {
  nonempty(name, 'Evidence file name'); assert.equal(isAbsolute(name), false)
  const path = resolve(parent, name), local = relative(parent, path)
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Evidence must remain beside its original receipt')
  const bytes = await readFile(path); assert.equal(hash(bytes), checksum(digest, name), 'Original evidence bytes: ' + name)
  return bytes
}
const receipt = { schema: 'agentmux.focus-collection-product.v1', passed: false, readOnlyJoin: true, userRuntimeTouched: false,
  newRuntimeCreated: false, checks: [], evidenceBoundaries: [
    'Actual private copied-source mutants and original Settings/public CLI/config processes retain their own exact receipts.',
    'The independent full-image review binds the current private Renderer scene, including its original declared transport/paint isolation. Those pixels do not certify native execution or installation.',
    'The original ordinary-product private Runtime receipt proves exact Session/Run/workface continuity and applied PTY bytes. Its Provider fixture is not a vendor Writer or a semantic task-completion claim.',
    'Ordinary Main/preload/Renderer consumes the official Node Host in its own package dependency scope. This does not qualify Desktop packaged Host dependency assembly.',
    'Only the original verifiers run here, with explicit reuse inputs; no mutation, capture, build, Runtime or user operation is replayed.'
  ] }
let stage = 'read-inputs'
try {
  const manifestPath = options.inputs ?? process.env.AGENTMUX_FOCUS_COLLECTION_PRODUCT_INPUTS
  const manifest = manifestPath ? await artifact(manifestPath) : null
  if (manifest) { assert.ok(manifest.value && typeof manifest.value === 'object' && !Array.isArray(manifest.value)); receipt.inputsManifest = reference(manifest) }
  const inputs = {}
  for (const key of ['layoutReceipt', 'settingsReceipt', 'configReceipt', 'sceneReceipt', 'runtimeReceipt', 'review']) {
    inputs[key] = await artifact(nonempty(options[key] ?? manifest?.value[key], 'Explicit input required: ' + key))
  }
  receipt.inputs = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, reference(value)]))
  const layout = inputs.layoutReceipt.value, settings = inputs.settingsReceipt.value, config = inputs.configReceipt.value
  const scene = inputs.sceneReceipt.value, native = inputs.runtimeReceipt.value, review = inputs.review.value
  for (const value of [layout, settings]) {
    assert.equal(value.schema, 'agentmux.renderer-source-mutation.v1'); assert.equal(value.passed, true)
    assert.equal(value.sharedTreeMutations, 0); assert.ok(value.cases.length > 0); hashMap(value.sourceBefore, 'Mutation source inputs')
  }
  assert.equal(config.schema, 'agentmux.focus-topic-presentation-config-process.v1'); assert.equal(config.passed, true)
  assert.equal(scene.schema, 'agentmux.focus-collection-scene.v1'); assert.equal(scene.capturedPass, true)
  assert.equal(scene.actual.passed, true); assert.equal(scene.userRuntimeTouched, false)
  hashMap(scene.ownerSources, 'Scene original owners'); hashMap(scene.compiled, 'Scene compiled identities')
  assert.ok(scene.frames.length > 0)
  assert.deepEqual(scene.actual.frames.map(frame => frame.file), scene.frames.map(frame => frame.file))

  stage = 'review-current-scene'
  assert.equal(review.schema, 'agentmux.focus-collection-final-review.v1'); assert.equal(review.status, 'approved')
  assert.equal(review.independent, true); nonempty(review.reviewer, 'Independent reviewer declaration')
  assert.equal(review.sceneReceiptSHA256, inputs.sceneReceipt.sha256)
  assert.equal(resolve(root, nonempty(review.sceneReceipt, 'Reviewed original scene')), inputs.sceneReceipt.path)
  assert.deepEqual(review.compiled, scene.compiled); assert.deepEqual(review.ownerSources, scene.ownerSources)
  assert.equal(review.codeReviewApproved, true); assert.deepEqual(review.mustChange, [])
  const frames = scene.frames.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file))
  assert.equal(new Set(frames.map(frame => frame.file)).size, frames.length)
  assert.equal(review.frames.length, frames.length)
  for (const frame of review.frames) { assert.equal(frame.reviewed, true); checksum(frame.sha256, frame.file) }
  assert.deepEqual(review.frames.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file)), frames)
  receipt.review = { ...reference(inputs.review), reviewer: review.reviewer, frames: frames.length, codeReviewApproved: true, documents: {} }
  for (const field of ['codeReviewArtifact', 'visualReviewArtifact']) {
    const path = resolve(root, nonempty(review[field], field)), bytes = await readFile(path)
    assert.ok(bytes.length > 0); receipt.review.documents[field] = { path: relative(root, path), sha256: hash(bytes) }
  }

  stage = 'consume-original-runtime'
  assert.equal(native.schema, 'agentmux.focus-timeline-name-width-restart.v1'); assert.equal(native.mode, 'collection-layout-join')
  assert.equal(native.passed, true, 'The original native restart must have passed'); assert.equal(native.privateRuntime, true); assert.equal(native.userRuntimeTouched, false)
  assert.equal(native.failure, undefined)
  const original = native.originalSession, originalRun = native.originalRun
  nonempty(original.agentSessionId, 'Original Core-created Session'); nonempty(original.run.runId, 'Original Core-created Run')
  assert.equal(originalRun.agentSessionId, original.agentSessionId); assert.equal(originalRun.runId, original.run.runId)
  assert.equal(originalRun.kind, 'agent'); assert.equal(originalRun.state, 'running'); assert.ok(Number.isSafeInteger(originalRun.pid) && originalRun.pid > 1)
  assert.equal(native.processes.length, 2)
  const [first, second] = native.processes
  assert.notEqual(first.pid, second.pid)
  assert.deepEqual(native.processes.map(process => process.seedWrites), [1, 0])
  for (const process of native.processes) {
    assert.ok(Number.isSafeInteger(process.pid) && process.pid > 1)
    assert.equal(process.exit.pid, process.pid); assert.equal(process.exit.exitCode, 0); assert.equal(process.exit.signal, null)
  }
  assert.equal(native.seedReport.schema, 'agentmux.desktop-restart-recovery.v1'); assert.equal(native.seedReport.pid, first.pid)
  nonempty(native.seedReport.runtimeDirectory, 'Original private Runtime directory')
  assert.equal(isAbsolute(native.seedReport.runtimeDirectory), true)
  assert.deepEqual(native.controls, [])
  assert.equal(first.before.topicPresentation, 'cards'); assert.equal(first.after.topicPresentation, 'sections')
  assert.equal(second.before.topicPresentation, 'sections'); assert.equal(native.collectionPreferencesRestored, true)
  assert.equal(native.originalWorkfacePreserved, true); assert.equal(native.fullCatalogMayGainIndependentResources, true)
  assert.equal(native.sameProcessXtermPreserved, true)
  assert.deepEqual(native.crossProcessXterm, { firstPid: first.pid, secondPid: second.pid, newInstanceExpected: true })
  const before = first.before, after = first.after, restored = second.before
  nonempty(before.draft, 'Original unsent draft'); assert.equal(after.draft, before.draft); assert.equal(restored.draft, before.draft)
  for (const value of [after, restored]) { assert.deepEqual(value.selection, before.selection); assert.deepEqual(value.focus, before.focus); assert.deepEqual(value.regions, before.regions) }
  assert.equal(before.focus.execution.sessionId, original.agentSessionId)
  const selection = native.originalSelection
  for (const key of ['spaceId', 'zoneId', 'workspaceId', 'tabId', 'groupId', 'regionId']) nonempty(selection[key], 'Original exact spatial choice: ' + key)
  assert.equal(selection.topicId, null); assert.deepEqual(before.selection, selection)
  // Parse the original durable owner graph with Core's own pure contract. These
  // helpers make no Runtime call and do not manufacture a new observed catalog.
  const { parseAgentMuxSpatialGraph, spatialCatalog } = await import(pathToFileURL(join(root, 'packages/core/dist/spatial-graph.js')).href)
  const graph = parseAgentMuxSpatialGraph(before.workbench)
  const workfaceGraphs = {}
  for (const [phase, snapshot] of [['before', before], ['edited', after], ['restored', restored]]) {
    const value = native.workfaceGraphs[phase]
    const bytes = await checkedRelative(dirname(inputs.runtimeReceipt.path), value.file, value.sha256)
    assert.deepEqual(JSON.parse(bytes), snapshot.workbench, 'Original full graph bytes match the inline snapshot: ' + phase)
    workfaceGraphs[phase] = { file: value.file, sha256: value.sha256 }
  }
  function originalWorkface(value) {
    const owner = parseAgentMuxSpatialGraph(value)
    const space = owner.spaces.find(value => value.spaceId === selection.spaceId), zone = owner.zones.find(value => value.zoneId === selection.zoneId)
    const tab = owner.tabs.find(value => value.tabId === selection.tabId), layout = owner.layouts[selection.workspaceId], tabLayout = owner.tabLayouts[selection.tabId]
    assert.ok(space && zone && tab && layout && tabLayout)
    const resource = owner.resources['tab:' + selection.tabId]; assert.ok(resource)
    nonempty(resource.titleRegionId, 'Original Tab title Region')
    if (resource.space !== undefined) assert.deepEqual(resource.space, { spaceId: selection.spaceId, zoneId: selection.zoneId })
    const regions = owner.regions.filter(value => value.tabId === selection.tabId).sort((a, b) => a.regionId.localeCompare(b.regionId))
    assert.ok(regions.length >= 2)
    const regionResources = Object.fromEntries(regions.map(region => {
      const resource = owner.resources['region:' + region.regionId]; assert.ok(resource)
      return [region.regionId, resource]
    }))
    const fileResources = Object.fromEntries(regions.filter(value => value.kind === 'file').map(region => {
      const file = owner.resources['region:' + region.regionId]; assert.ok(file)
      return [region.regionId, file]
    }))
    assert.ok(Object.keys(fileResources).length > 0)
    return { space, zone, tab, regions, regionResources, layout, tabLayout, titleRegionId: resource.titleRegionId, fileResources,
      bindings: owner.bindings.filter(value => value.zoneId === selection.zoneId).sort((a, b) => a.spaceId.localeCompare(b.spaceId)) }
  }
  const workface = originalWorkface(graph)
  assert.deepEqual(originalWorkface(after.workbench), workface); assert.deepEqual(originalWorkface(restored.workbench), workface)
  for (const name of ['spaces', 'zones', 'tabs', 'regions', 'bindings']) assert.ok(graph[name].length > 0, 'Nonempty original Core spatial facts: ' + name)
  assert.ok(Object.keys(graph.layouts).length > 0 && Object.keys(graph.tabLayouts).length > 0)
  assert.ok(before.regions.length >= 2); assert.equal(new Set(before.regions).size, before.regions.length)
  const workspaceLayout = graph.layouts[selection.workspaceId]; assert.ok(workspaceLayout)
  const group = workspaceLayout.groups.find(value => value.id === selection.groupId)
  assert.ok(group); assert.equal(workspaceLayout.activeGroupId, selection.groupId); assert.equal(group.activeTabId, selection.tabId)
  assert.ok(group.tabOrder.includes(selection.tabId))
  const tab = graph.tabs.find(value => value.tabId === selection.tabId), tabLayout = graph.tabLayouts[selection.tabId]
  assert.ok(tab); assert.ok(tabLayout); assert.equal(tab.zoneId, selection.zoneId); assert.equal(tabLayout.root.type, 'split'); assert.equal(tabLayout.activeRegionId, selection.regionId)
  const catalog = spatialCatalog(graph, { displayWorkspaceId: selection.workspaceId, groupId: selection.groupId, tabId: selection.tabId, regionId: selection.regionId })
  assert.ok(catalog.locations.some(value => value.spaceId === selection.spaceId && value.zoneId === selection.zoneId), 'Original exact choice remains in Core topology')
  const agentRegion = graph.regions.find(value => value.regionId === selection.regionId)
  assert.ok(agentRegion)
  assert.equal(agentRegion.tabId, selection.tabId); assert.equal(agentRegion.kind, 'agent'); assert.equal(agentRegion.agentSessionId, original.agentSessionId)
  assert.ok(agentRegion.runId === null || agentRegion.runId === original.run.runId, 'A durable unknown Run reference must not claim a different Run')
  assert.ok(before.regions.includes(agentRegion.regionId))
  const siblings = graph.regions.filter(region => region.tabId === selection.tabId && region.kind === 'file')
  assert.ok(siblings.length > 0); for (const region of siblings) assert.ok(before.regions.includes(region.regionId), 'Original sibling file remains visible')
  const seed = native.initialSpatialSeed
  checksum(seed.adapterSha256, 'Original pure spatial adapter identity')
  assert.ok(Array.isArray(seed.inputs) && seed.inputs.length > 0); for (const name of seed.inputs) nonempty(name, 'Original adapter input')
  assert.ok(seed.inputs.includes('apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'))
  const seededBytes = await checkedRelative(dirname(inputs.runtimeReceipt.path), seed.state.file, seed.state.sha256)
  const seededState = JSON.parse(seededBytes)
  assert.equal(seededState.schemaVersion, 1); assert.ok(Number.isSafeInteger(seededState.revision) && seededState.revision > 0)
  const seededGraph = parseAgentMuxSpatialGraph(seededState.graph)
  assert.deepEqual(originalWorkface(seededGraph), workface)
  const seededAgent = seededGraph.regions.find(value => value.regionId === selection.regionId)
  assert.equal(seededAgent.agentSessionId, original.agentSessionId); assert.equal(seededAgent.runId, original.run.runId)
  assert.ok(spatialCatalog(seededGraph).locations.some(value => value.displayWorkspaceId === selection.workspaceId &&
    value.groupId === selection.groupId && value.tabId === selection.tabId && value.regionId === selection.regionId && value.spaceId === selection.spaceId && value.zoneId === selection.zoneId))
  const publicCatalog = native.restoredSpatialCatalog
  for (const name of ['spaces', 'zones', 'tabs', 'regions', 'bindings', 'locations']) assert.ok(publicCatalog[name].length > 0, 'Nonempty actual public spatial projection: ' + name)
  const publicTab = publicCatalog.tabs.find(value => value.tabId === selection.tabId)
  assert.ok(publicTab); assert.equal(publicTab.zoneId, selection.zoneId); assert.ok(publicTab.regionIds.includes(selection.regionId))
  assert.ok(publicCatalog.spaces.some(value => value.spaceId === selection.spaceId))
  assert.ok(publicCatalog.zones.some(value => value.zoneId === selection.zoneId && value.workspaceId === tab.workspaceId))
  assert.ok(publicCatalog.bindings.some(value => value.spaceId === selection.spaceId && value.zoneId === selection.zoneId))
  const publicAgent = publicCatalog.regions.find(value => value.regionId === selection.regionId)
  assert.equal(publicAgent.agentSessionId, original.agentSessionId); assert.equal(publicAgent.runId, original.run.runId); assert.equal(publicAgent.tabId, selection.tabId)
  assert.ok(publicCatalog.locations.some(value => value.displayWorkspaceId === selection.workspaceId && value.workspaceId === tab.workspaceId &&
    value.groupId === selection.groupId && value.tabId === selection.tabId && value.regionId === selection.regionId && value.spaceId === selection.spaceId && value.zoneId === selection.zoneId))
  const current = native.restoredRegion
  assert.equal(current.kind, 'agent'); assert.equal(current.agentSessionId, original.agentSessionId)
  assert.equal(current.terminalView.runId, original.run.runId); assert.equal(current.terminalView.liveReady, true); assert.equal(current.terminalView.acceptsInput, true)
  const { AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(pathToFileURL(join(root, 'packages/core/dist/control.js')).href)
  assert.ok(native.regionObservations.length > 0)
  const requestIds = new Set(), observationPids = new Set()
  for (const observation of native.regionObservations) {
    const { source, request, result } = observation
    assert.ok(native.processes.some(process => process.pid === source.pid)); observationPids.add(source.pid)
    assert.equal(source.source, 'apps/desktop/out/main/index.js'); assert.equal(source.sha256, native.inputsBefore[source.source])
    checksum(source.sha256, 'Original initialized Main bridge source')
    assert.equal(source.symbol, 'DesktopControlIpcBridge'); assert.equal(source.contract, 'Main-to-original-Renderer inspect.region')
    assert.equal(request.schemaVersion, AGENTMUX_CONTROL_SCHEMA_VERSION); nonempty(request.requestId, 'Original region read request ID')
    assert.equal(requestIds.has(request.requestId), false); requestIds.add(request.requestId)
    assert.equal(request.operation, 'inspect.region'); assert.deepEqual(request.target, { kind: 'region', regionId: selection.regionId })
    assert.equal(result.operation, 'inspect.region'); assert.ok(result.region)
    if (result.region.kind === 'agent') assert.equal(result.region.agentSessionId, original.agentSessionId)
  }
  assert.equal(observationPids.size, 2)
  assert.ok(native.regionObservations.some(({ source, result }) => source.pid === second.pid && result.region.kind === 'agent' &&
    result.region.agentSessionId === current.agentSessionId && result.region.terminalView?.runId === current.terminalView.runId &&
    result.region.terminalView.liveReady === true && result.region.terminalView.acceptsInput === true), 'Original second Main/Renderer observation backs the restored live Region')
  assert.equal(native.originalRunAfterQuit.agentSessionId, original.agentSessionId)
  assert.equal(native.originalRunAfterQuit.runId, original.run.runId); assert.equal(native.originalRunAfterQuit.pid, originalRun.pid); assert.equal(native.originalRunAfterQuit.state, 'running')
  assert.equal(native.runs.length, 1)
  const run = native.runs[0]
  assert.deepEqual(run.before, { runId: original.run.runId, pid: originalRun.pid }); assert.deepEqual(run.after, run.before)
  assert.equal(run.ack.passed, true)
  for (const value of [run.ack.beforeByte, run.ack.afterByte, run.ack.appliedByteRange.startByte, run.ack.appliedByteRange.endByte]) assert.ok(Number.isSafeInteger(value) && value >= 0)
  assert.equal(run.ack.afterByte - run.ack.beforeByte, 2); assert.equal(run.ack.appliedByteRange.endByte - run.ack.appliedByteRange.startByte, 2)
  assert.ok(Number.isSafeInteger(native.collectionInputBoundary.beforeByte)); assert.equal(native.collectionInputBoundary.afterByte, native.collectionInputBoundary.beforeByte)
  assert.deepEqual(native.runtimeAfter, native.runtimeBefore)
  for (const name of ['hostId', 'ownership', 'buildIdentity', 'instanceId']) nonempty(native.runtimeBefore[name], 'Actual Runtime identity ' + name)
  assert.equal(native.runtimeBefore.ownership, 'owned'); assert.ok(Number.isSafeInteger(native.runtimeBefore.protocolVersion) && native.runtimeBefore.protocolVersion > 0)
  assert.ok(native.runtimeBefore.processId === null || (Number.isSafeInteger(native.runtimeBefore.processId) && native.runtimeBefore.processId > 1))
  assert.equal(native.collectionInputBoundary.permitsOriginalAttachProtocol, true)
  assert.equal(native.cleanup.ownedPrivateRootsRemoved, true); assert.deepEqual(native.cleanup.remainingOwnedProcesses, [])
  assert.equal(native.cleanup.errors, undefined); assert.equal(native.cleanup.interruptionError, undefined)

  stage = 'consume-original-semantic-host'
  const host = native.semanticHost
  assert.equal(host.entrypoint, 'apps/host/dist/index.js')
  assert.ok(Number.isSafeInteger(host.pid) && host.pid > 1)
  assert.notEqual(host.pid, originalRun.pid); for (const process of native.processes) assert.notEqual(host.pid, process.pid)
  assert.equal(host.birth.pid, host.pid); nonempty(host.birth.birth, 'Original owned Host process birth')
  assert.ok(Number.isSafeInteger(host.birth.uid) && host.birth.uid >= 0); assert.ok(Number.isSafeInteger(host.birth.ppid) && host.birth.ppid > 0)
  assert.equal(isAbsolute(nonempty(native.seedReport.userData, 'Original private Desktop user data')), true)
  assert.equal(host.storePath, join(native.seedReport.userData, 'agent-sessions.json'))
  assert.deepEqual(host.originalSession, original); assert.deepEqual(host.originalRun, run.before)
  const hostArtifacts = {}, hostValues = {}
  for (const name of ['ownerIdentity', 'bootstrap', 'ready', 'afterIdentity']) {
    const value = host[name], bytes = await checkedRelative(dirname(inputs.runtimeReceipt.path), value.file, value.sha256)
    hostValues[name] = JSON.parse(bytes); hostArtifacts[name] = { file: value.file, sha256: value.sha256 }
  }
  const owner = hostValues.ownerIdentity.owner
  const ownerFence = value => {
    nonempty(value.runtimeId, 'Original semantic Runtime identity'); nonempty(value.ownerInstanceId, 'Original semantic owner instance')
    assert.equal(value.protocolVersion, 2); assert.equal(value.processId, host.pid)
    assert.ok(['connected', 'unverified'].includes(value.availability))
    if (value.ctxmux !== null) assert.deepEqual(value.ctxmux, native.runtimeBefore)
    return { runtimeId: value.runtimeId, ownerInstanceId: value.ownerInstanceId, protocolVersion: value.protocolVersion, processId: value.processId }
  }
  for (const value of [hostValues.bootstrap.owner, hostValues.ready.owner, hostValues.afterIdentity.owner]) assert.deepEqual(ownerFence(value), ownerFence(owner))
  assert.deepEqual(hostValues.bootstrap.owner.ctxmux, native.runtimeBefore); assert.deepEqual(hostValues.afterIdentity.owner.ctxmux, native.runtimeAfter)
  assert.equal(hostValues.ready.protocol, 'jsonrpc-2.0'); assert.equal(hostValues.ready.pid, host.pid)
  assert.equal(hostValues.bootstrap.storePath, host.storePath); assert.equal(hostValues.bootstrap.hostProcessId, host.pid)
  const originalBootSessions = hostValues.bootstrap.sessions.filter(value => value.agentSessionId === original.agentSessionId)
  assert.equal(originalBootSessions.length, 1); assert.deepEqual(originalBootSessions[0].run, original.run)
  assert.equal(native.cleanup.privateServiceAbsent, true); assert.equal(native.cleanup.privateHostExited, true)
  assert.equal(native.cleanup.unexpectedPrivateRegistration, undefined)
  assert.deepEqual(native.cleanup.privateHostExit, { pid: host.pid, exitCode: 0, signal: null })

  stage = 'bind-public-single-write-and-durable-config'
  const operation = native.collectionOperation
  nonempty(operation.operationId, 'Original setting operation ID'); assert.equal(operation.key, 'focus.topicPresentation'); assert.equal(operation.value, 'sections')
  assert.equal(native.collectionCli.length, 2)
  const endpoint = 'unix:' + join(native.seedReport.runtimeDirectory, 'control.sock')
  for (const [index, command] of native.collectionCli.entries()) {
    assert.equal(command.code, 0); assert.equal(typeof command.stderr, 'string')
    assert.deepEqual(JSON.parse(command.stdout), command.receipt); assert.equal(command.receipt.ok, true)
    assert.equal(command.operation, index === 0 ? 'settings.inspect' : 'settings.set'); assert.equal(command.receipt.operation, command.operation)
    assert.deepEqual(command.args, ['--endpoint', endpoint, 'settings', ...(index === 0 ? ['inspect', operation.key] : ['set', operation.key, 'sections', '--operation-id', operation.operationId])])
  }
  assert.deepEqual(native.collectionCli[0].receipt.result.entries, [{ key: operation.key, kind: 'string', value: 'cards', default: 'cards', enum: ['cards', 'sections'] }])
  assert.equal(native.collectionCli[1].receipt.result.entry.key, operation.key); assert.equal(native.collectionCli[1].receipt.result.entry.value, 'sections')
  const configs = {}
  for (const name of ['collectionConfigAfterSave', 'collectionConfigAfterRestart']) {
    const value = native[name]; assert.equal(value.value, 'sections')
    const bytes = await checkedRelative(dirname(inputs.runtimeReceipt.path), value.file, value.sha256)
    assert.equal(JSON.parse(bytes).focus.topicPresentation, 'sections'); configs[name] = { file: value.file, sha256: value.sha256 }
  }

  stage = 'bind-native-source-and-output'
  const nativeInputs = hashMap(native.inputsBefore, 'Original native source/output bindings')
  assert.deepEqual(native.inputsAfter, nativeInputs)
  for (const prefix of ['apps/desktop/src/', 'apps/desktop/out/', 'apps/host/src/', 'apps/host/dist/', 'packages/core/src/', 'packages/core/dist/', 'packages/core/vendor/']) assert.ok(Object.keys(nativeInputs).some(name => name.startsWith(prefix)), 'Nonempty original native input group: ' + prefix)
  const featureSources = { ...scene.ownerSources, ...Object.fromEntries(Object.entries(settings.sourceBefore).filter(([name]) => name.startsWith('apps/desktop/src/'))) }
  for (const [name, digest] of Object.entries(featureSources)) assert.equal(nativeInputs[name], digest, 'The native product consumed the same qualified feature owner: ' + name)
  // Recheck critical compiled entries and feature owners, not the producer's
  // entire unchanged repository/vendor inventory a second time.
  const outputNames = Object.keys(nativeInputs).filter(name => /^apps\/desktop\/out\/(?:main|preload)\/index\.[cm]?js$/.test(name))
  for (const area of ['main', 'preload']) assert.ok(outputNames.some(name => name.startsWith(`apps/desktop/out/${area}/`)), 'Actual compiled ' + area + ' entry')
  const htmlName = 'apps/desktop/out/renderer/index.html', html = await readFile(join(root, htmlName), 'utf8')
  assert.equal(hash(html), nativeInputs[htmlName]); outputNames.push(htmlName)
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+\.(?:[cm]?js|css))["'][^>]*>/g)) {
    const name = resolve(root, 'apps/desktop/out/renderer', match[1])
    assert.ok(name.startsWith(join(root, 'apps/desktop/out/renderer') + '/'), 'Compiled Renderer reference remains within its output')
    outputNames.push(relative(root, name))
  }
  // Ordinary Vite output references lazy page CSS in the HTML entry's actual
  // dependency table, rather than necessarily adding a stylesheet to the HTML.
  for (const entry of [...outputNames].filter(name => /renderer\/.+\.[cm]?js$/.test(name))) {
    const bytes = await readFile(join(root, entry)); assert.equal(hash(bytes), nativeInputs[entry])
    for (const match of bytes.toString().matchAll(/["'](\.\/[^"']+\.css)["']/g)) {
      const name = resolve(root, dirname(entry), match[1])
      assert.ok(name.startsWith(join(root, 'apps/desktop/out/renderer') + '/'))
      outputNames.push(relative(root, name))
    }
  }
  assert.ok(outputNames.some(name => /renderer\/.+\.[cm]?js$/.test(name))); assert.ok(outputNames.some(name => name.endsWith('.css')))
  const critical = [...new Set([...Object.keys(featureSources), ...outputNames, 'packages/core/dist/index.js', 'packages/core/dist/public-rpc-client.js',
    'packages/core/bin/amux', 'packages/core/dist/spatial-graph.js', 'packages/core/dist/control.js', 'packages/core/test/fixtures/fake-codex-cli.mjs', 'apps/desktop/scripts/verify-focus-timeline-name-width-restart.mjs',
    'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
    host.entrypoint, 'apps/host/package.json', 'apps/host/src/index.ts', 'apps/host/src/macos-service.ts', 'apps/host/dist/macos-service.js'])]
  for (const name of critical) {
    const bytes = await readFile(join(root, name))
    if (name === host.entrypoint) assert.ok(bytes.length > 0, 'The actual executed Host entry must not be empty')
    assert.equal(hash(bytes), checksum(nativeInputs[name], name), 'The qualified native feature/entry remains current: ' + name)
  }
  receipt.native = { ...reference(inputs.runtimeReceipt), originalSession: original, run: run.before, runtimeIdentity: native.runtimeBefore,
    spatial: { originalSelection: selection, workfaceGraphs, graphSHA256: hash(JSON.stringify(graph)), workfaceScopeSHA256: hash(JSON.stringify(workface)), tabLayout,
      agentRegionId: agentRegion.regionId, siblingRegionIds: siblings.map(region => region.regionId),
      initialSeed: { adapterSha256: seed.adapterSha256, inputs: seed.inputs, state: seed.state }, publicCatalogSHA256: hash(JSON.stringify(publicCatalog)),
      publicEvidence: 'The original Core space.inspect catalog confirms the exact spatial address and same Session/Run. The original selected workface identities, layout, bindings and sibling file resources remain unchanged; independent directory discovery may add other graph resources. The initialized original Main bridge invokes its original Renderer inspect.region getter to confirm live input; this view is not claimed as a Core catalog field. No additional Runtime or UI read was performed by this join.',
      rendererRegionObservations: native.regionObservations.length },
    inputBindingCount: Object.keys(nativeInputs).length, inputBindingsSHA256: hash(JSON.stringify(nativeInputs)), criticalCurrentInputs: Object.fromEntries(critical.map(name => [name, nativeInputs[name]])),
    semanticHost: { entrypoint: host.entrypoint, pid: host.pid, birth: host.birth, owner: ownerFence(owner), artifacts: hostArtifacts,
      dependencyScope: { manifest: 'apps/host/package.json', sha256: nativeInputs['apps/host/package.json'], packagedHostAssemblyQualified: false } },
    processes: native.processes.map(({ pid, seedWrites, exit }) => ({ pid, seedWrites, exitCode: exit.exitCode })), operationId: operation.operationId,
    cliBytes: native.collectionCli.map(command => ({ operation: command.operation, stdoutSHA256: hash(command.stdout), stderrSHA256: hash(command.stderr) })), configs, appliedInputBytes: 2 }

  stage = 'reuse-original-verifiers'
  const environment = { ...process.env, AGENTMUX_MUTATION_RECEIPTS: JSON.stringify([inputs.layoutReceipt.path, inputs.settingsReceipt.path]),
    AGENTMUX_TOPIC_SETTINGS_PROCESS_RECEIPT: inputs.configReceipt.path, AGENTMUX_FOCUS_COLLECTION_SCENE_RECEIPT: inputs.sceneReceipt.path }
  for (const [name, script] of [['layout', 'verify-focus-collection-layout.mjs'], ['settings', 'verify-focus-topic-presentation-setting.mjs'], ['scene', 'capture-focus-collection-layout.mjs']]) {
    const result = await execute(process.execPath, [join(root, 'apps/desktop/scripts', script), '--evidence', join(evidence, name)], { cwd: root, env: environment, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    const log = result.stdout + result.stderr, logFile = name + '-exact-reuse.log'
    await writeFile(join(evidence, logFile), log)
    const reports = result.stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    const expected = name === 'settings' ? [inputs.settingsReceipt, inputs.configReceipt] : [name === 'layout' ? inputs.layoutReceipt : inputs.sceneReceipt]
    assert.equal(reports.length, expected.length)
    for (const [index, report] of reports.entries()) {
      assert.equal(resolve(root, report.receipt), expected[index].path)
      assert.equal(report.passed ?? report.capturedPass, true)
      assert.equal(index === 1 ? report.exactConfigProcessEvidenceReused : report.exactEvidenceReused, true)
      if (name === 'layout' || (name === 'settings' && index === 0)) assert.equal(report.mutants, name === 'layout' ? 9 : 5)
    }
    receipt.checks.push({ name, originalVerifier: 'apps/desktop/scripts/' + script, log: logFile, sha256: hash(log), reused: true })
  }
  receipt.driver = { path: relative(root, fileURLToPath(import.meta.url)), sha256: hash(await readFile(fileURLToPath(import.meta.url))) }
  receipt.passed = true
} catch (error) {
  receipt.failure = { stage, name: error.name, message: error.message }; process.exitCode = 1
} finally { if (!outputIsInput) await writeFile(output, JSON.stringify(receipt, null, 2) + '\n') }
console.log(JSON.stringify({ passed: receipt.passed, receipt: output, failure: receipt.failure }))
