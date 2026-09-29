import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { ScratchTopics } from '../../../src/main/scratch-topics.ts'
import { RuntimeController } from '../../../src/main/runtime-controller.ts'
import { ConfigOwner } from '../../../src/main/config-owner.ts'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store.ts'
import { executeSettingsWorkspaceAddControl } from '../../../src/main/settings-workspace-add-control.ts'
import { executeSettingsResourcesControl } from '../../../src/main/settings-resources-control.ts'
import { executeSettingsControl } from '../../../src/main/settings-control.ts'
import { SCRATCH_WORKSPACE_ID, MOTE_COORDINATION_ROLE } from '../../../src/shared/scratch-topics.ts'

const [root, output, executable, model] = process.argv.slice(2)
const record = { schema: 'agentmux.mote-project-execution.v1', passed: false, root, model, executable,
  scope: 'Private Node/HappyDOM host of current Source owners with actual Codex and public Core/CLI. No installed App, paint, or user Runtime claim.',
  inputs: [], calls: [], creations: [], runs: [], stage: 'setup', cleanup: {} }
const save = async () => { await writeFile(join(output, 'behavior.json'), JSON.stringify(record, null, 2) + '\n') }
const stage = async value => { record.stage = value; await save(); console.log(value) }
const window = new Window({ url: 'http://private-mote.test' })
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement })
const { api } = await import('../../../src/renderer/src/lib/api.ts')
const { useAppStore } = await import('../../../src/renderer/src/store.ts')
const topics = new ScratchTopics(), sessions = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const configStore = new ConfigStore(join(root, 'config.json'))
await mkdir(join(root, 'scratch'), { recursive: true })
const args = ['--model', model, '--config', 'cli_auth_credentials_store="file"', '--config', 'notify=[]',
  '--config', 'features.plugins=false', '--config', 'features.plugin_hooks=false', '--config', 'features.memories=false', '--config', 'features.chronicle=false',
  '--config', 'model_reasoning_effort="low"', '--dangerously-bypass-hook-trust', '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox']
let config = await configStore.save({ ...structuredClone(DEFAULT_CONFIG),
  executors: { 'proof-codex': { label: 'Proof Codex', providerId: 'codex', command: executable, args, env: { CODEX_HOME: join(root, 'codex-home'), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime') }, injectAgentMuxGuide: true } },
  workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Private Scratch', path: join(root, 'scratch'), hostId: 'local', kind: 'folder' }] })
let core, runtime, controlServer, detach, disposeUi
try {
  await stage('core-connect')
  core = await connectLocalAgentMux({ store: sessions })
  record.runtime = core.runtimeIdentity()
  const create = core.createAgentWithDelivery.bind(core)
  core.createAgentWithDelivery = async input => {
    const receipt = await create(input)
    record.creations.push({ input: { ...input, env: { CODEX_HOME: input.env.CODEX_HOME, AGENTMUX_RUNTIME_DIRECTORY: input.env.AGENTMUX_RUNTIME_DIRECTORY, AGENTMUX_WIKI_DIR: input.env.AGENTMUX_WIKI_DIR } }, receipt })
    record.runs.push({ agentSessionId: receipt.session.agentSessionId, run: receipt.session.run, workspacePath: receipt.session.workspacePath })
    await save(); return receipt
  }
  runtime = new RuntimeController(sessions, topics)
  runtime.commit({ hosts: [{ id: 'local', client: core, executionHost: { kind: 'local', dispose: async () => {} } }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const listeners = new Set()
  const sender = Object.assign(new EventEmitter(), { id: 192241, isDestroyed: () => false, send: (_channel, event) => { for (const fn of listeners) fn(event) } })
  detach = runtime.attach(sender)
  const owner = new ConfigOwner({ read: () => config, save: next => configStore.save(next), publish: saved => { config = saved; useAppStore.setState({ config: saved }) } })
  const demands = openDemandStore({ root: join(root, 'demands') })
  for (const [key, method] of Object.entries({ list: 'list', create: 'create', update: 'update', delete: 'delete', linkSession: 'linkSession', unlinkSession: 'unlinkSession', activity: 'addActivity', decision: 'addDecision' })) api.demands[key] = demands[method].bind(demands)
  api.config.get = async () => config
  api.sessions.snapshot = async () => ({ ...await runtime.snapshot(config), localHome: join(root, 'home') })
  api.providers.list = async () => runtime.providerCatalog()
  api.sessions.onEvent = fn => { listeners.add(fn); return () => listeners.delete(fn) }
  api.sessions.launchAgent = async input => {
    const snapshot = input.scratchTopicId ? await topics.read(scratch(), input.scratchTopicId) : null
    const cwd = snapshot ? join(await realpath(scratch().path), snapshot.directoryPath) : await realpath(input.workspacePath)
    assert.ok(cwd.startsWith(await realpath(root) + '/'), 'Fixture trust must stay in its authorized private directory')
    const executor = config.executors[input.executorId]
    const launchConfig = { ...config, executors: { ...config.executors, [input.executorId]: { ...executor,
      args: [...executor.args, '--config', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`] } } }
    return runtime.launchAgent(input, launchConfig)
  }
  api.sessions.refresh = input => runtime.refresh(input, config)
  api.sessions.timeline = input => runtime.sessionTimeline(input)
  api.sessions.submitPrompt = (...input) => runtime.submitPrompt(...input)
  api.ui.requestStorageFlush = async () => {}
  const scratch = () => config.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID)
  api.scratch.ensureMote = (_id, id) => topics.ensureMote(scratch(), id)
  api.scratch.ensureTopic = (_id, id) => topics.ensure(scratch(), id)
  api.scratch.readTopic = (_id, id) => topics.read(scratch(), id)
  api.scratch.listTopics = () => topics.list(scratch())
  disposeUi = await useAppStore.getState().initialize()
  controlServer = new AgentMuxControlServer({ execute: async request => {
    const call = { request, startedAt: Date.now() }; record.calls.push(call)
    try {
      call.result = request.operation === 'settings.workspaces.add'
        ? await executeSettingsWorkspaceAddControl(request, owner, id => runtime.executionHost(id))
        : request.operation.startsWith('settings.resource.') ? await executeSettingsResourcesControl(request, owner)
        : request.operation === 'settings.get' || request.operation === 'settings.set' ? await executeSettingsControl(request, owner)
        : await useAppStore.getState().executeControl(request)
      call.completedAt = Date.now(); await save(); return call.result
    } catch (error) { call.error = { code: error.code, message: error.message }; await save(); throw error }
  } })
  await controlServer.start()
  const wait = async (predicate, label, budget = 150000) => {
    const end = Date.now() + budget
    do { const value = await predicate(); if (value) return value; await new Promise(done => setTimeout(done, 500)) } while (Date.now() < end)
    throw new Error('Bounded deadline: ' + label)
  }
  const finishedTurn = async id => {
    const value = await core.statusAgent(id)
    return value.session.semanticStatus?.state === 'done' || value.session.semanticStatus?.state === 'waiting' ? value : null
  }
  const capture = async (id, label) => {
    const status = await core.statusAgent(id), timeline = await core.sessionTimeline(id), replay = await core.readRunReplay(status.session.run)
    assert.ok(replay.replay.length > 0, 'Ordered output is empty')
    await writeFile(join(output, label + '.json'), JSON.stringify({ status, timeline, replay }, null, 2) + '\n')
    return status
  }
  await stage('A-vague-discussion')
  const first = '我有一些点子，我们开始尝试一个项目'
  record.inputs.push({ phase: 'A', text: first, at: Date.now() })
  await useAppStore.getState().createScratchTopic('mote', { executorId: 'proof-codex', prompt: first })
  assert.equal(record.runs.length, 1, 'A did not produce exactly one Mote')
  const mote = record.runs[0]
  assert.ok(record.creations[0].input.agentMuxNote.includes(MOTE_COORDINATION_ROLE))
  assert.equal(record.creations[0].input.prompt, first)
  await wait(() => finishedTurn(mote.agentSessionId), 'A first response')
  await capture(mote.agentSessionId, 'A')
  assert.equal((await demands.list()).length, 0, 'Vague A manufactured an empty Demand')
  assert.equal(config.workspaces.length, 1, 'Vague A manufactured a Project')
  record.A = { projectCount: 0, demandCount: 0, assistantObserved: true }
  const held = { activeWorkspaceId: useAppStore.getState().activeWorkspaceId, mainSurface: useAppStore.getState().mainSurface }
  await stage('B-authorized-attempt')
  const path = join(root, 'project')
  const second = `目标很小：试做一个本地文本结果。你可以在 ${path} 创建项目及最小初始指令，授权范围只限本轮私有目录。请组织真实执行 Agent 在项目里创建 result.txt，内容为 HELLO；你负责协调、绑定需求和跟进证据，不要亲自代写结果。保持当前工作面。这个结果供我检查，目标确认和结果接受仍由我决定。`
  record.inputs.push({ phase: 'B', text: second, at: Date.now() }); await save()
  const moteStatus = await core.statusAgent(mote.agentSessionId)
  const moteProjection = await runtime.resolveSession(mote.agentSessionId, config)
  assert.notEqual(moteProjection.promptSubmissionPredecessor, undefined, 'Original delivery condition is unknown')
  await core.submitAgentPrompt({ agentSessionId: mote.agentSessionId, expectedRun: moteStatus.session.run, afterSubmissionId: moteProjection.promptSubmissionPredecessor, operationId: 'mote-proof-B', prompt: second, authorHuman: true })
  await wait(async () => record.runs.length > 1 && (await demands.list()).some(value => value.sessionIds.some(id => id !== mote.agentSessionId)), 'real execution and Demand binding')
  const demand = (await demands.list()).find(value => value.sessionIds.some(id => id !== mote.agentSessionId))
  assert.ok(demand && demand.projectId && demand.executorId && demand.sessionIds.length > 0)
  const execution = record.runs.find(value => demand.sessionIds.includes(value.agentSessionId) && value.agentSessionId !== mote.agentSessionId)
  assert.ok(execution, 'Demand links no actual creation')
  await wait(async () => existsSync(join(path, 'result.txt')) && (await readFile(join(path, 'result.txt'), 'utf8')).trim() === 'HELLO', 'execution artifact')
  await capture(execution.agentSessionId, 'execution')
  await capture(mote.agentSessionId, 'B')
  const creation = record.creations.find(value => value.receipt.session.agentSessionId === execution.agentSessionId)
  assert.equal(creation.receipt.creation.initialPrompt, 'confirmed', 'Execution first prompt delivery is unconfirmed')
  assert.ok(creation.input.prompt.includes(demand.id), 'Handoff omits actual Demand')
  assert.ok(creation.input.prompt.includes(path) && creation.input.prompt.includes('AGENTS.md'), 'Handoff omits actual Project/instruction path')
  assert.equal(creation.input.agentMuxNote, undefined, 'Execution Agent received Mote role')
  assert.equal(useAppStore.getState().activeWorkspaceId, held.activeWorkspaceId, 'Dispatch changed work surface')
  assert.equal(useAppStore.getState().mainSurface, held.mainSurface)
  assert.ok(!demand.alignment?.confirmedAt && !demand.grounding?.acceptedAt, 'Agent supplied human acknowledgement')
  record.result = { demand, project: config.workspaces.find(value => value.path === path), execution, creation, instructions: await readFile(join(path, 'AGENTS.md'), 'utf8'), artifact: await readFile(join(path, 'result.txt'), 'utf8'), heldSurface: held }
  assert.ok(record.result.project, 'Project registration missing')
  record.passed = true
  await stage('behavior-complete')
} catch (error) {
  record.failure = { stage: record.stage, message: error.message, stack: error.stack }; console.error(record.failure.message)
  // Read current authoritative facts and ordered output before owned Run cleanup, even when observation failed.
  record.failureObservations = []
  for (const owned of record.runs) {
    try {
      const status = await core.statusAgent(owned.agentSessionId), timeline = await core.sessionTimeline(owned.agentSessionId), replay = await core.readRunReplay(owned.run)
      const path = join(output, `failure-${owned.agentSessionId}.json`)
      await writeFile(path, JSON.stringify({ status, timeline, replay }, null, 2) + '\n')
      record.failureObservations.push({ agentSessionId: owned.agentSessionId, path, outputBytes: status.run.latestOutputBytes })
    } catch (observationError) { record.failureObservations.push({ agentSessionId: owned.agentSessionId, error: observationError.message }) }
  }
}
finally {
  const cleanupErrors = []
  for (const owned of record.runs) {
    try { if (core) { const current = await core.statusAgent(owned.agentSessionId); assert.equal(current.session.run.runId, owned.run.runId); await core.stopAgent(owned.agentSessionId, owned.run) } }
    catch (error) { cleanupErrors.push(error.message) }
  }
  try { await controlServer?.stop(); await disposeUi?.(); detach?.(); await runtime?.dispose(); if (!runtime) await core?.dispose(); await window.happyDOM.close() } catch (error) { cleanupErrors.push(error.message) }
  // Secrets are never delivery evidence, including on a behavioral failure.
  await rm(join(root, 'codex-home'), { recursive: true, force: true })
  record.cleanup = { stoppedOnlyOwnedSessions: record.runs.map(value => value.agentSessionId), errors: cleanupErrors, authRemoved: true,
    retainedPrivateRoot: root, reason: 'Native daemon and original config/Demand evidence retained until public namespace cleanup is available; no user App delete or direct config edit.' }
  await save()
  if (!record.passed || cleanupErrors.length) process.exitCode = 1
}
