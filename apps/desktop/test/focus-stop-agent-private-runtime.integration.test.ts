import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
// Real private Core/ctxmux, RuntimeController Stop and durable readers. Only the
// Electron service shell and Node DOM are controlled; no user Runtime is touched.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore,
  type AgentMuxClientEvent, type AgentMuxAgentSession } from '@agentmux/core'
import { agentPromptCondition } from '@agentmux/core/prompt-condition'
import { createWorkspaceLayout } from '@agentmux/layout'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { privateRuntimeConnector } from './helpers/private-runtime-connector'
import { RuntimeController } from '../src/main/runtime-controller'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { summarizeRecoveryStorage } from '../src/main/recovery-probe'
import { useAppStore } from '../src/renderer/src/store'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import type { AppConfig } from '../src/shared/contracts'

vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("unused-private-stop-service") } }))

const execute = promisify(execFile)
const original = useAppStore.getState()
let scope: Awaited<ReturnType<typeof headlessFixture>> | undefined
let controller: RuntimeController | undefined
let privateClient: import('@agentmux/core/hosted').AgentMuxHostedClient | undefined
const privatePids = new Set<number>()
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  for (const session of privateClient?.agentSessions() ?? []) {
    expect(session.agentSessionId.startsWith('private-focus-stop-')).toBe(true)
    await privateClient!.stopAgent(session.agentSessionId, session.run)
  }
  await controller?.dispose()
  await scope?.cleanup()
  const stillRunning = [...privatePids].filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  expect(stillRunning).toEqual([])
  const receiptPath = process.env.AGENTMUX_FOCUS_STOP_PRIVATE_RECEIPT
  if (receiptPath) await writeFile(receiptPath.replace(/\.json$/u, '-cleanup.json'), JSON.stringify({
    privatePids: [...privatePids], remaining: stillRunning, privateRootRemoved: true, sharedRuntimeControls: 0
  }, null, 2) + '\n')
  vi.restoreAllMocks()
  useAppStore.setState(original, true)
})

it('Stop targets one exact private Run, retains its retired history and leaves the neighboring Run and durable workface recoverable', async () => {
  scope = await headlessFixture()
  const client = await scope.client()
  privateClient = client
  const events: AgentMuxClientEvent[] = []
  client.onEvent(event => events.push(event))
  const fakeCli = resolve('packages/core/test/fixtures/fake-codex-cli.mjs')
  const agents: AgentMuxAgentSession[] = []
  for (const name of ['stopped', 'healthy']) {
    const created = await client.createAgent({ providerId: 'codex', executorId: 'private-codex',
      agentSessionId: `private-focus-stop-${name}`, createOperationId: `private-focus-stop-create-${name}`,
      workspacePath: scope.root, commandOverride: fakeCli, args: [],
      env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false })
    await client.reattachAgent(created.agentSessionId, 0, 'terminal')
    await until(() => client.agentSession(created.agentSessionId), session =>
      Boolean(session.nativeHandle) && session.semanticStatus?.state === 'done', `${name} native identity and ready input`)
    agents.push(client.agentSession(created.agentSessionId))
    const run = (await client.statusAgent(created.agentSessionId)).run
    expect(run.pid).toBeGreaterThan(1)
    privatePids.add(run.pid!)
  }
  const stopped = agents[0]!, healthy = agents[1]!
  const healthyBefore = await client.statusAgent(healthy.agentSessionId)
  expect(healthyBefore.run.state).toBe('running')
  expect(healthyBefore.run.pid).toBeGreaterThan(1)
  const originalPage = await client.sessionHistoryPage(stopped.agentSessionId, { limit: 30 })
  expect(originalPage.items.length).toBeGreaterThan(0)
  // headlessFixture's existing Codex reader is deliberately a protocol fixture.
  // Core/FileStore/stop/reopen/native PTY and exact identities are production owners.
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG),
    hosts: [{ id: 'local', kind: 'local', label: 'Private local' }],
    workspaces: [{ id: 'private-workspace', kind: 'folder', hostId: 'local', name: 'Private', path: scope.root }],
    executors: { 'private-codex': { providerId: 'codex', label: 'Private Codex',
      command: fakeCli, args: [], env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false } } }
  controller = new RuntimeController(new AgentMuxFileAgentSessionStore(join(scope.root, 'desktop-sessions.json')),
    privateRuntimeConnector(scope.socketPath, () => { throw new Error('No remote Host belongs to this private proof') }))
  controller.commit(await controller.prepare(config))
  const snapshot = await controller.snapshot(config)
  const stopControl = snapshot.sessions.find(session => session.id === stopped.agentSessionId)!.control
  expect(stopControl).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: stopped.agentSessionId, run: stopped.run })
  const healthyTab = createWorkbenchTab('private-healthy-tab', { kind: 'agent', regionId: 'private-healthy-region',
    phase: 'attached', workspaceId: 'private-workspace', sessionId: healthy.agentSessionId })
  const workface = { config, sessions: snapshot.sessions, tabs: { [healthyTab.id]: healthyTab },
    layouts: { 'private-workspace': createWorkspaceLayout('private-group', [healthyTab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }
  const spatialPath = join(scope.root, 'spatial.json')
  const spatialOwner = new AgentMuxSpatialStateStore(spatialPath)
  const originalSpatial = await spatialOwner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(workface, []) })
  const draft = { [healthy.agentSessionId]: 'Original neighboring unsent draft', [stopped.agentSessionId]: 'Retained stopped Agent draft' }
  const selection = { spaceId: null, zoneId: null, workspaceId: 'private-workspace', groupId: 'private-group',
    tabId: healthyTab.id, regionId: 'private-healthy-region', topicId: null }
  useAppStore.setState({ ...workface, agentFocus: EMPTY_AGENT_FOCUS, agentComposerDrafts: draft,
    workbenchSpaceSelection: selection, activeWorkspaceId: 'private-workspace', mainSurface: 'agents',
    closingWorkbenchViews: {}, error: null })
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  const uiRaw = JSON.stringify({ state: persisted, version: useAppStore.persist.getOptions().version })
  const uiPath = join(scope.root, 'ui.json')
  await writeFile(uiPath, uiRaw)
  const originalPresentation = summarizeRecoveryStorage(uiRaw, originalSpatial)
  expect(originalPresentation.tabIds).toEqual([healthyTab.id])
  expect(originalPresentation.drafts).toEqual(draft)
  expect(persisted.agentComposerDrafts).toEqual(draft)
  expect(persisted.workbenchSpaceSelection).toEqual(selection)
  const spatialBytes = await readFile(spatialPath)
  const stopBefore = client.runtimeIdentity()
  await controller.stopSession(stopControl)
  const retired = (await client.sessionHistorySources()).find(entry => entry.agentSessionId === stopped.agentSessionId)!
  expect(retired.state).toBe('retired')
  expect(retired.history?.nativeHandle).toEqual(stopped.nativeHandle)
  expect(retired.retiredAt).toBeGreaterThan(0)
  const stoppedRun = (await client.listRuns()).find(run => run.runId === stopped.run.runId)!
  expect(stoppedRun).toBeUndefined()
  expect(client.runtimeIdentity()).toEqual(stopBefore)
  expect((await client.sessionHistoryPage(stopped.agentSessionId, { limit: 30 })).items).toEqual(originalPage.items)
  expect((await client.sessionHistoryPage(stopped.agentSessionId, { limit: 30 })).source).toEqual(originalPage.source)
  const live = await client.statusAgent(healthy.agentSessionId)
  expect(live.run).toMatchObject({ runId: healthy.run.runId, pid: healthyBefore.run.pid, state: 'running' })
  const prompt = 'Same neighboring Agent accepts input after exact private Stop'
  await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(healthy.agentSessionId)),
    agentSessionId: healthy.agentSessionId, operationId: 'private-focus-stop-neighbor-input', prompt })
  await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''),
    output => output.includes(`codex-submit:${prompt}:accepted`), 'same healthy Run actual PTY input/output')
  const healthyAfterInput = await client.statusAgent(healthy.agentSessionId)
  expect(healthyAfterInput.run).toMatchObject({ runId: healthy.run.runId, pid: healthyBefore.run.pid, state: 'running' })
  expect(healthyAfterInput.run.acceptedInputBytes!).toBeGreaterThan(healthyBefore.run.acceptedInputBytes!)
  expect(healthyAfterInput.run.latestOutputBytes).toBeGreaterThan(healthyBefore.run.latestOutputBytes)
  expect(await readFile(spatialPath)).toEqual(spatialBytes)
  expect(await readFile(uiPath, 'utf8')).toBe(uiRaw)
  const worker = resolve('apps/desktop/test/fixtures/focus-stop-agent-restart-worker.mjs')
  const second = await execute(process.execPath, [worker, scope.socketPath, scope.env.AGENTMUX_AGENT_SESSION_STORE!,
    spatialPath, uiPath, stopped.agentSessionId, healthy.agentSessionId], { env: scope.env, timeout: 20_000 })
  const reread = JSON.parse(second.stdout.trim())
  expect(reread.pid).not.toBe(process.pid)
  expect(reread.stopped.agentSessionId).toBe(stopped.agentSessionId)
  expect(reread.stopped.history.state).toBe('retired')
  expect(reread.page).toMatchObject({ items: originalPage.items, source: originalPage.source })
  expect(reread.spatial).toEqual(originalSpatial)
  expect(reread.presentation).toEqual(originalPresentation)
  expect(reread.ui.workbenchSpaceSelection).toEqual(selection)
  expect(reread.ui.agentComposerDrafts).toEqual(draft)
  expect(reread.healthy).toEqual({ agentSessionId: healthy.agentSessionId, runId: healthy.run.runId,
    pid: healthyBefore.run.pid, state: 'running' })
  const reopened = await controller.reopenRetiredSession({ hostId: 'local', agentSessionId: stopped.agentSessionId },
    retired.retiredAt!, 'private-focus-stop-explicit-reopen', config)
  expect(reopened.id).toBe(stopped.agentSessionId)
  expect(reopened.kind).toBe('agent')
  expect(reopened.control.run.runId).not.toBe(stopped.run.runId)
  const reopenedRun = (await client.statusAgent(stopped.agentSessionId)).run
  expect(reopenedRun.pid).toBeGreaterThan(1)
  privatePids.add(reopenedRun.pid!)
  const reopenedAttachment = await client.reattachAgent(stopped.agentSessionId, 0, 'terminal')
  const diagnosticPath = process.env.AGENTMUX_FOCUS_STOP_PRIVATE_RECEIPT
  if (diagnosticPath) {
    const current = await client.statusAgent(stopped.agentSessionId)
    await writeFile(diagnosticPath.replace(/\.json$/u, '-reopen-observation.json'), JSON.stringify({
      sid: current.session.agentSessionId, runId: current.run.runId, pid: current.run.pid, state: current.run.state,
      nativeHandle: current.session.nativeHandle, semanticState: current.session.semanticStatus?.state,
      currentCachedState: client.agentSession(stopped.agentSessionId).semanticStatus?.state,
      actualOutput: reopenedAttachment.attachment.replay.map(event => event.data).join('') +
        events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'terminal-output' }> =>
          event.type === 'terminal-output' && event.run.runId === current.run.runId)
          .map(event => event.data).join('')
    }, null, 2) + '\n')
  }
  const freshReopened = await client.statusAgent(stopped.agentSessionId)
  expect(freshReopened.run.state).toBe('running')
  expect(client.agentSession(stopped.agentSessionId).nativeHandle).toEqual(stopped.nativeHandle)
  expect(client.agentSession(stopped.agentSessionId).retiredRuns).toContainEqual(stopped.run)
  expect((await client.statusAgent(healthy.agentSessionId)).run).toMatchObject({ runId: healthy.run.runId,
    pid: healthyBefore.run.pid, state: 'running' })
  const receiptPath = process.env.AGENTMUX_FOCUS_STOP_PRIVATE_RECEIPT
  if (receiptPath) await writeFile(receiptPath, JSON.stringify({ schema: 'agentmux.focus-stop-private-runtime.v1', passed: true,
    stopped: { sid: stopped.agentSessionId, runId: stopped.run.runId, nativeHandle: stopped.nativeHandle,
      retiredAt: retired.retiredAt, state: 'removed-from-runtime', publicHistoryItems: originalPage.items.length },
    neighbor: { sid: healthy.agentSessionId, runId: healthy.run.runId, pid: healthyBefore.run.pid,
      inputBefore: healthyBefore.run.acceptedInputBytes, inputAfter: healthyAfterInput.run.acceptedInputBytes,
      outputBefore: healthyBefore.run.latestOutputBytes, outputAfter: healthyAfterInput.run.latestOutputBytes },
    reread: { pid: reread.pid, parentPid: process.pid, spatialSHA256: sha(spatialBytes), uiSHA256: sha(uiRaw),
      tabIds: originalPresentation.tabIds, regionIds: originalPresentation.regionIds,
      exactSpatial: true, exactSelection: true, exactDrafts: true },
    reopen: { sid: reopened.id, runId: reopened.control.run.runId, nativeHandle: client.agentSession(stopped.agentSessionId).nativeHandle },
    boundaries: { privateOnly: true, historyReader: 'existing Codex fixture', ordinaryNodeReadback: true,
      electronRestart: false, vendorWriter: false, targetProjectionRetentionRequired: false } }, null, 2) + '\n')
  for (const session of client.agentSessions()) await client.stopAgent(session.agentSessionId, session.run)
}, 90_000)
