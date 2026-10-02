const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { createConnection, createServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { privateRuntimeConnector } from './helpers/private-runtime-connector.js'
import type { AppConfig, RuntimeEvent } from '../src/shared/contracts.js'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture.js'

const selector = vi.hoisted(() => ({ paths: new Map<string, string>(), home: _hygiene_fixturePath("tmp/agentmux-recovery-unused") }))
// Only Desktop's SSH transport selector is replaced with a private Unix endpoint. The same public
// Runtime client, RPC registry, owner process, Provider, Store and ctxmux are actually exercised.
// This gate qualifies mounted recovery, and makes no SSH/Farm or real Provider qualification claim.

vi.mock('electron', () => ({ app: { getPath: () => selector.home } }))
const dom = composerDOM()
const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
const controllers: RuntimeController[] = []
const subscriptions: Array<() => void> = []
const transports: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of subscriptions.splice(0)) dispose()
  for (const controller of controllers.splice(0)) await controller.dispose()
  for (const dispose of transports.splice(0)) await dispose()
  for (const scope of scopes.splice(0)) await scope.cleanup()
  selector.paths.clear(); vi.unstubAllEnvs()
})

async function setup() {
  const local = await headlessFixture(); scopes.push(local)
  const remote = await headlessFixture(); scopes.push(remote)
  for (const [key, value] of Object.entries(local.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) vi.stubEnv(key, value!)
  selector.home = local.root
  // Transparent Unix transport to the real owner. On the deliberately selected outage, a final
  // incomplete frame exercises a classified transport error instead of a graceful, causeless EOF.
  // No Session/Run authority or event is supplied by this fault trigger.
  const transportPath = join(local.root, 'proxy.sock'), sockets = new Set<Socket>()
  let incompleteEnd = false
  const proxy = createServer(downstream => {
    const upstream = createConnection(remote.socketPath)
    sockets.add(downstream); sockets.add(upstream)
    downstream.pipe(upstream)
    upstream.on('data', bytes => downstream.write(bytes))
    upstream.once('end', () => { if (incompleteEnd) downstream.end('{'); else downstream.end() })
    upstream.once('error', () => downstream.destroy())
    downstream.once('error', () => upstream.destroy())
    downstream.once('close', () => { sockets.delete(downstream); upstream.destroy() })
    upstream.once('close', () => sockets.delete(upstream))
  })
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(transportPath, resolve) })
  transports.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
  })
  selector.paths.set('private-owner.fixture', transportPath)
  const client = await remote.client()
  const command = resolve(import.meta.dirname, '../../../packages/core/test/fixtures/fake-codex-cli.mjs')
  const created = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: remote.root,
    createOperationId: 'mounted-recovery-create', commandOverride: command, injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'before' } })
  const original = await client.reattachAgent(created.agentSessionId, 0, 'terminal')
  const native = await until(() => client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle) && value.semanticStatus?.state === 'done', 'original native identity')
  const terminal = await client.createTerminal({ createOperationId: 'mounted-recovery-split-terminal', workspacePath: remote.root,
    command: process.execPath, args: ['-e', 'process.stdin.resume()'], cols: 100, rows: 20 })
  // This owning recovery case has exactly one real remote endpoint. Mixed local/remote failure
  // isolation is exercised by runtime-endpoint-isolation.integration.test.ts in Node, and by the
  // actual Electron proof. No browser transform is allowed to become a local ctxmux qualification.
  const config: AppConfig = { ...composerConfig, hosts: [{
    id: 'build-host', kind: 'ssh', label: 'Private remote owner', hostname: 'private-owner.fixture', runtimeId: remote.owner.runtimeId
  }], executors: { codex: { ...composerConfig.executors.codex!, command, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'remote-space', hostId: 'build-host', name: 'Original remote workspace', path: remote.root, kind: 'folder' }] }
  const controller = new RuntimeController(new AgentMuxFileAgentSessionStore(join(local.root, 'main-sessions.json')),
    privateRuntimeConnector(local.socketPath, hostname => selector.paths.get(hostname)!))
  controllers.push(controller)
  controller.commit(await controller.prepare(config))
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  const read = vi.spyOn(api.sessions, 'snapshot').mockImplementation(() => controller.snapshot(config))
  // Open the actual startup write fence. Otherwise automatic dispatch would stop at saving the
  // workbench before reaching our target guard, and removing that guard would falsely stay green.
  subscriptions.push(await useAppStore.getState().initialize())
  const snapshot = await until(() => controller.snapshot(config), value => value.runtimeEndpointWarnings?.length === 0, 'initial trusted remote snapshot')
  expect(snapshot.sessions.map(session => [session.id, session.hostId]).sort()).toEqual([[created.agentSessionId, 'build-host'], [terminal.runId, 'build-host']].sort())
  const projected = snapshot.sessions.find(session => session.id === created.agentSessionId)!
  expect(projected.kind).toBe('agent')
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'remote-space', sessionId: projected.id })
  const terminalTab = createWorkbenchTab('original-terminal-tab', { regionId: 'original-terminal-region', kind: 'terminal', phase: 'attached', workspaceId: 'remote-space', sessionId: terminal.runId })
  const splitLayout = moveTabToNewGroup(createWorkspaceLayout('original-group', [tab.id, terminalTab.id]), terminalTab.id,
    'original-group', 'original-group', 'down', 'original-terminal-group')
  useAppStore.setState({ config, loading: false, sessions: snapshot.sessions, timelines: snapshot.timelines,
    tabs: { [tab.id]: tab, [terminalTab.id]: terminalTab }, layouts: { 'remote-space': { ...splitLayout, activeGroupId: 'original-group' } },
    activeWorkspaceId: 'remote-space', runtimeEndpointWarnings: snapshot.runtimeEndpointWarnings ?? [],
    agentComposerDrafts: { [projected.id]: 'Original remote unsent draft' }, agentSteerQueues: {}, pendingAgentLaunches: {} })
  const events: RuntimeEvent[] = []
  const contents = Object.assign(new EventEmitter(), { id: 48, isDestroyed: () => false,
    send: (_channel: string, event: RuntimeEvent) => { events.push(event); useAppStore.getState().applyEvent(event) } }) as unknown as WebContents
  controller.attach(contents)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation((control, text, operation, condition) => controller.submitPrompt(control, text, operation, condition))
  await dom.render(<GlobalSystemNotices />)
  return { remote, client, controller, config, created, original, native, projected, events, read, submit, terminal,
    stopWithTransportError: async () => { incompleteEnd = true; await remote.stopOwner() } }
}

it('automatically reconnects a mounted remote owner to the same Session, native identity, Run and PID without replaying an unknown prepared operation', async () => {
  const scope = await setup()
  const originalWorkbench = useAppStore.getState(), originalOwner = scope.remote.owner
  expect(originalWorkbench.layouts['remote-space']?.root.type).toBe('split')
  expect(originalWorkbench.layouts['remote-space']?.groups.map(group => group.tabOrder)).toEqual([['original-tab'], ['original-terminal-tab']])
  const condition = { expectedRun: scope.created.run, afterSubmissionId: null }
  await act(async () => useAppStore.setState({ agentSteerQueues: { [scope.projected.id]: [{
    operationId: 'original-unconfirmed-operation', text: 'Kept unconfirmed message', runId: scope.created.run.runId,
    status: 'deferred', promptCondition: condition, error: 'The original result is unknown.'
  }] } }))
  // A completion wake can race ahead of the lost event. This real public consumer must not
  // dispatch a prepared uncertain intent even while its last observed owner is still healthy.
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(scope.projected.id) })
  expect(scope.submit).not.toHaveBeenCalled()
  await act(async () => {
    await scope.stopWithTransportError()
    await until(() => useAppStore.getState().runtimeEndpointWarnings, value => Boolean(value?.some(item => item.hostId === 'build-host')), 'mounted real lost notice')
  })
  const offline = useAppStore.getState()
  expect(offline.sessions.map(session => session.id).sort()).toEqual([scope.created.agentSessionId, scope.terminal.runId].sort())
  const offlineAgent = offline.sessions.find(session => session.id === scope.created.agentSessionId)
  expect(offlineAgent?.processState).toBe('running')
  expect(offlineAgent?.status.state).toBe('disconnected')
  expect(offline.tabs).toBe(originalWorkbench.tabs)
  expect(offline.layouts).toBe(originalWorkbench.layouts)
  expect(offline.agentComposerDrafts).toBe(originalWorkbench.agentComposerDrafts)
  expect(dom.container.textContent).toContain('Private remote owner:')
  const loss = scope.events.find(event => event.event.type === 'connection-state' && event.event.state === 'lost')!
  expect(loss.event.type).toBe('connection-state')
  if (loss.event.type !== 'connection-state') throw new Error('The actual connection loss must be observed')
  expect(loss.event.diagnostic).toBeDefined()
  expect(offline.runtimeEndpointWarnings).toEqual([expect.objectContaining({ hostId: 'build-host',
    code: loss.event.diagnostic!.code, message: loss.event.diagnostic!.message, availability: 'unverified' })])
  expect(offline.error).toBeNull()
  expect(scope.events.filter(event => event.event.type === 'agent-error')).toEqual([])
  await act(async () => {
    await scope.remote.restart()
    const recovered = await until(() => useAppStore.getState(), value => value.runtimeEndpointWarnings?.length === 0 &&
      value.sessions.some(session => session.id === scope.created.agentSessionId && session.kind === 'agent' && session.status.state !== 'disconnected') &&
      value.agentSteerQueues[scope.projected.id]?.[0]?.error?.includes('unconfirmed after reconnect') === true,
    'mounted automatic reconnect after fresh canonical cut').then(() => true, () => false)
    if (!recovered) console.error(JSON.stringify({ warnings: useAppStore.getState().runtimeEndpointWarnings,
      sessions: useAppStore.getState().sessions, queue: useAppStore.getState().agentSteerQueues,
      readCalls: scope.read.mock.calls.length, submitCalls: scope.submit.mock.calls.length,
      events: scope.events.map(event => ({ type: event.event.type, hostId: event.hostId, ...(event.event.type === 'connection-state' ? { state: event.event.state } : {}), endpointWarning: event.endpointWarning })),
      error: useAppStore.getState().error }, null, 2))
    expect(recovered).toBe(true)
  })
  expect(scope.remote.owner.runtimeId).toBe(originalOwner.runtimeId)
  expect(scope.remote.owner.ownerInstanceId).not.toBe(originalOwner.ownerInstanceId)
  expect(scope.read.mock.calls.length).toBeGreaterThan(0)
  expect(scope.events.filter(event => event.event.type === 'connection-state').map(event => [event.hostId, event.event.type === 'connection-state' && event.event.state]))
    .toEqual([['build-host', 'lost'], ['build-host', 'restored']])
  expect(scope.submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions.map(session => session.id).sort()).toEqual([scope.created.agentSessionId, scope.terminal.runId].sort())
  expect(useAppStore.getState().agentSteerQueues[scope.projected.id]).toEqual([{
    operationId: 'original-unconfirmed-operation', text: 'Kept unconfirmed message', runId: scope.created.run.runId,
    status: 'deferred', promptCondition: condition,
    error: 'The original message delivery is unconfirmed after reconnect. Inspect the outbox before retrying.'
  }])
  const restored = await scope.client.statusAgent(scope.created.agentSessionId)
  expect([restored.session.agentSessionId, restored.run.runId, restored.run.pid, restored.run.state])
    .toEqual([scope.created.agentSessionId, scope.created.run.runId, scope.original.attachment.run.pid, 'running'])
  expect(restored.session.nativeHandle).toEqual(scope.native.nativeHandle)
  const terminal = (await scope.client.listRuns()).find(run => run.runId === scope.terminal.runId)
  expect([terminal?.runId, terminal?.pid, terminal?.state]).toEqual([scope.terminal.runId, scope.terminal.pid, 'running'])
  expect(useAppStore.getState().agentComposerDrafts).toBe(originalWorkbench.agentComposerDrafts)
  expect(useAppStore.getState().tabs).toBe(originalWorkbench.tabs)
  expect(useAppStore.getState().layouts).toBe(originalWorkbench.layouts)
  expect(dom.container.textContent).toContain('original message delivery is unconfirmed after reconnect')
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().lastError).toBeNull()
  await act(async () => { await scope.client.stopAgent(scope.created.agentSessionId, scope.created.run); await new Promise(resolve => setTimeout(resolve, 20)) })
}, 120_000)

it('settles only the recovered endpoint workflow notice and preserves an independent Agent error with the same code and message', async () => {
  const scope = await setup()
  await act(async () => {
    await scope.stopWithTransportError()
    await until(() => useAppStore.getState().runtimeEndpointWarnings, value => Boolean(value?.length), 'classified endpoint loss')
  })
  const loss = scope.events.find(event => event.event.type === 'connection-state' && event.event.state === 'lost')!
  if (loss.event.type !== 'connection-state' || !loss.event.diagnostic) throw new Error('Classified transport cause is required')
  const diagnostic = loss.event.diagnostic
  // This independent owner event deliberately has identical presentation. Attribution must use
  // the typed producer, never its code, English text, Host label or current disconnected state.
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'build-host', event: {
    type: 'agent-error', agentSessionId: scope.created.agentSessionId, ...diagnostic,
    evidence: { source: 'run-process', observedAt: Date.now(), run: scope.created.run }
  } }))
  const originalError = useAppStore.getState().error
  expect(originalError).toContain(diagnostic.message)
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(scope.projected.control)
  await act(async () => {
    await scope.remote.restart()
    const restored = await until(() => useAppStore.getState(), state => state.runtimeEndpointWarnings?.length === 0 &&
      state.sessions.some(session => session.id === scope.created.agentSessionId && session.kind === 'agent' && session.status.state !== 'disconnected'),
    'fresh restored owner facts').then(() => true, () => false)
    expect(restored).toBe(true)
  })
  expect(useAppStore.getState().error).toBe(originalError)
  expect(useAppStore.getState().lastError).toBe(originalError)
  expect(useAppStore.getState().errorNoticeContext?.subject).toEqual(scope.projected.control)
  expect((await scope.client.statusAgent(scope.created.agentSessionId)).run.runId).toBe(scope.created.run.runId)
}, 120_000)
