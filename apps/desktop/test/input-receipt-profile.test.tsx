// @vitest-environment happy-dom
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentInputSubmissionReceipt, AgentMuxClientEvent } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentSteerQueueEntry } from '../src/renderer/src/store'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { profileReceipt, withoutProfile } from './input-receipt-profile.fixture'

const isolated = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const supplied = process.env.AMX_RECEIPT_HOME
  const directory = supplied ?? mkdtempSync(join(tmpdir(), 'amx-receipt-test-'))
  const { isolateCoreFixtureEnvironment } = await import('./helpers/isolate-core-environment')
  isolateCoreFixtureEnvironment(directory)
  vi.stubEnv('HOME', directory)
  // Cache the controlled external API ports before selecting the real native storage owner.
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  await import('../src/renderer/src/lib/api')
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  await import('../../mobile/test/device-locks')
  return { directory, owned: !supplied }
})
const root = isolated.directory
afterAll(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
  if (isolated.owned) await (await import('node:fs/promises')).rm(root, { recursive: true, force: true })
})
const reading = process.env.AMX_RECEIPT_PHASE === 'read'
const check = reading ? it.skip : it
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const writeEvidence = (name: string, value: unknown) => {
  if (process.env.AMX_RECEIPT_EVIDENCE) appendFileSync(process.env.AMX_RECEIPT_EVIDENCE, JSON.stringify({ name, value }) + '\n')
}

check('profile projection preserves raw source, no-profile reference, regressive prior and every authority guard', async () => {
  const { projectInputReceipt } = await import('../../../packages/client-ui/src/lib/input-receipt-projection')
  const raw = profileReceipt(), before = structuredClone(raw), plain = withoutProfile(raw)
  expect(projectInputReceipt(undefined, plain)).toBe(plain)
  const projected = projectInputReceipt(undefined, raw)
  expect(projected, 'shared-profile-removed').toEqual(plain)
  expect(raw).toEqual(before)
  expect(projected.control).toBe(raw.control)
  expect(projected.key).toBe(raw.key)
  const older = structuredClone(raw); older.ref.waitGeneration--
  expect(projectInputReceipt(raw, older)).toEqual(plain)
  expect(projectInputReceipt(plain, older)).toBe(plain)
  const waiting = { ...raw, admission: null, status: 'waiting' as const,
    control: { ref: raw.ref, state: 'enabled' as const, at: 1 } }
  expect(projectInputReceipt(raw, waiting)).toEqual(plain)
  const later = { ...waiting, ref: { ...waiting.ref, waitGeneration: 3 } }
  expect(projectInputReceipt(waiting, later)).toBe(later)
  expect(() => projectInputReceipt(raw, later)).toThrowError(expect.objectContaining({ code: 'CONTROL_REQUEST_CONFLICT' }))
  for (const mutate of [
    (r: AgentInputSubmissionReceipt) => { r.admission!.admission!.intent!.message!.userContent += ' changed' },
    (r: AgentInputSubmissionReceipt) => { r.admission!.admission!.intent!.message!.sourceDevice!.deviceId += '-changed' },
    (r: AgentInputSubmissionReceipt) => { r.control = { ...r.control, gateId: 'other-gate' } },
    (r: AgentInputSubmissionReceipt) => { r.admission!.admission!.intent!.prompt += ' changed' }
  ]) {
    const conflict = structuredClone(raw); mutate(conflict)
    expect(() => projectInputReceipt(raw, conflict)).toThrowError(expect.objectContaining({ code: 'CONTROL_REQUEST_CONFLICT' }))
  }
  expect(raw).toEqual(before)
})

async function desktop(seed: boolean) {
  const { WorkbenchUserStateStore } = await import('../src/main/workbench-user-state')
  const user = new WorkbenchUserStateStore(join(root!, 'workbench-user-state.json'))
  const raw = profileReceipt(), rawBefore = structuredClone(raw)
  const entry: AgentSteerQueueEntry = { operationId: raw.key.kind === 'prompt' ? raw.key.submissionId : '',
    text: 'Synthetic queue body', runId: 'profile-run', status: 'deferred', archived: true, inputReceipt: raw,
    directInputBinding: { expectedRun: { runId: 'profile-run' }, admissionIntent: { kind: 'manual-actor' } },
    directInputControl: { kind: 'agent', hostId: 'local', agentSessionId: 'profile-session', run: { runId: 'profile-run' } } }
  if (seed) await user.write(JSON.stringify({ state: { agentSteerQueues: { 'profile-session': [entry] },
    agentComposerDrafts: { 'profile-region': 'Synthetic unsent draft' } }, version: 1,
    desktopFragments: { compactedTestUnknown: { keep: 'Synthetic untouched fragment' } } }))
  const { useAppStore: store, prepareRendererUpdate } = await import('../src/renderer/src/store')
  const { api } = await import('../src/renderer/src/lib/api')
  const { AgentMuxSpatialStateStore } = await import('@agentmux/core/spatial-state')
  const { createWorkspaceLayout } = await import('@agentmux/layout')
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state')
  const { providerCatalogReader, historySourcesReader } = await import('./helpers/startup-observation-api-fixture')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Synthetic host' }], executors: {},
    workspaces: [{ id: 'profile-workspace', name: 'Synthetic workspace', hostId: 'local', path: root!, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: SessionSnapshot = { id: 'profile-session', kind: 'agent', providerId: 'codex', executorId: 'synthetic',
    hostId: 'local', workspacePath: root!, label: 'Synthetic Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
    promptSubmissionPredecessor: null, processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'profile-session', run: { runId: 'profile-run' } } }
  const tab = createWorkbenchTab('profile-tab', { regionId: 'profile-region', kind: 'agent', phase: 'attached', workspaceId: 'profile-workspace', sessionId: session.id })
  store.setState({ config, tabs: { [tab.id]: tab }, layouts: { 'profile-workspace': createWorkspaceLayout('profile-group', [tab.id]) },
    sessions: [session], activeWorkspaceId: 'profile-workspace' })
  const spatial = new AgentMuxSpatialStateStore(join(root!, 'spatial.json'))
  if (seed) await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  cleanups.push(await store.getState().initialize())
  return { store, user, api, raw, rawBefore, entry, prepareRendererUpdate }
}

check('Desktop real agent-input event retains projected receipt instead of incoming raw profile', async () => {
  const { useAppStore: store } = await import('../src/renderer/src/store')
  const receipt = profileReceipt('event-original'), original = structuredClone(receipt), plain = withoutProfile(receipt)
  const key = receipt.key
  if (key.kind !== 'prompt') throw Error('Synthetic prompt required')
  store.setState({ agentSteerQueues: { 'profile-session': [{ operationId: key.submissionId, text: 'Original event text', status: 'deferred',
    directInputBinding: { expectedRun: key.expectedRun, admissionIntent: { kind: 'manual-actor' } },
    directInputControl: { kind: 'agent', hostId: 'local', agentSessionId: key.agentSessionId, run: key.expectedRun } }] } })
  store.getState().applyEvent({ hostId: 'local', event: { type: 'agent-input', receipt } })
  const entry = store.getState().agentSteerQueues['profile-session']![0]!
  expect(entry.inputReceipt, 'desktop-event-profile-removed').toEqual(plain)
  expect(entry.archived).toBe(true)
  expect(entry.text).toBe('Original event text')
  const queues = store.getState().agentSteerQueues, prior = entry.inputReceipt
  const older = structuredClone(receipt); older.ref.waitGeneration--
  store.getState().applyEvent({ hostId: 'local', event: { type: 'agent-input', receipt: older } })
  expect(store.getState().agentSteerQueues['profile-session']![0]!.inputReceipt).toBe(prior)
  expect(receipt).toEqual(original)
  expect(queues['profile-session']![0]!.directInputBinding!.expectedRun).toEqual(key.expectedRun)
}, 30_000)


check('Desktop cold profile removal reaches original native save without losing input or fragments', async () => {
  const f = await desktop(true)
  const savedEntry = f.store.getState().agentSteerQueues['profile-session']![0]!
  expect(savedEntry.inputReceipt, 'cold-profile-removed').toEqual(withoutProfile(f.raw))
  expect(savedEntry.text).toBe(f.entry.text)
  expect(savedEntry.directInputBinding).toEqual(f.entry.directInputBinding)
  expect(savedEntry.directInputControl).toEqual(f.entry.directInputControl)
  expect(f.store.getState().agentComposerDrafts['profile-region']).toBe('Synthetic unsent draft')
  const queues = f.store.getState().agentSteerQueues
  let reads = 0
  const old = savedEntry.inputReceipt
  Object.defineProperty(savedEntry, 'inputReceipt', { configurable: true, get() { reads++; return old } })
  await f.prepareRendererUpdate('quit')
  expect(f.api.ui.writeWorkbenchState).toHaveBeenCalled()
  const nativeWrite = f.user.observe().lastConfirmedWrite
  expect(nativeWrite?.diskDurability).toBe('confirmed')
  vi.mocked(f.api.ui.writeWorkbenchState).mockClear(); reads = 0
  for (let n = 0; n < 30; n++) f.store.setState({ sessions: [{ ...f.store.getState().sessions[0]!, latestOutputBytes: n }] })
  await new Promise(done => setTimeout(done, 400))
  expect(reads, 'unrelated-session-no-profile-rescan').toBe(0)
  expect(f.store.getState().agentSteerQueues).toBe(queues)
  expect(f.api.ui.writeWorkbenchState).not.toHaveBeenCalled()
  const disk = JSON.parse((await f.user.read())!)
  expect(disk.state.agentSteerQueues['profile-session'][0].inputReceipt).toEqual(withoutProfile(f.raw))
  expect(disk.desktopFragments.compactedTestUnknown.keep).toBe('Synthetic untouched fragment')
  expect(f.raw).toEqual(f.rawBefore)
  expect(f.api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  writeEvidence('desktop-persistence', { beforeReceiptBytes: Buffer.byteLength(JSON.stringify(f.raw)),
    afterReceiptBytes: Buffer.byteLength(JSON.stringify(old)), queueCount: 1, sends: 0, diskDurability: nativeWrite!.diskDurability })
}, 30_000)

;(reading ? it : it.skip)('fresh process reads original saved projection without reseeding or dispatch', async () => {
  const before = await readFile(join(root!, 'workbench-user-state.json'), 'utf8')
  expect(JSON.parse(before).state.agentSteerQueues['profile-session'][0].inputReceipt).toEqual(withoutProfile(profileReceipt()))
  const f = await desktop(false)
  expect(f.store.getState().agentSteerQueues['profile-session']![0]!.inputReceipt).toEqual(withoutProfile(f.raw))
  expect(f.store.getState().agentComposerDrafts['profile-region']).toBe('Synthetic unsent draft')
  expect(f.api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  writeEvidence('fresh-process', { reseeded: false, queueCount: 1, draftPreserved: true, sends: 0 })
})

check('Mobile real hot observer stores slim receipt and cold draft omits Core authority', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { useMobilePromptController } = await import('../../mobile/src/conversation/use-mobile-prompt-controller')
  const { createLocalDrafts } = await import('../../mobile/src/conversation/local-drafts')
  const { getDeviceWorkface, emptyDeviceWorkface } = await import('../../mobile/src/recovery/device-workface')
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  const local = createLocalDrafts(), receipt = profileReceipt('mobile-original'), key = JSON.stringify(['draft', 'profile-session'])
  const original = { operationId: 'mobile-original', runId: 'profile-run', draft: 'Synthetic queue body', phase: 'unknown' as const,
    message: 'Original unknown', explicit: true, originalHostId: 'local',
    manualInput: { agentSessionId: 'profile-session', expectedRun: { runId: 'profile-run' }, runtimeId: null } }
  local.attempts.set(key, original)
  let listener: ((event: AgentMuxClientEvent) => void) | undefined
  const client = { onEvent: (next: typeof listener) => { listener = next; return () => { listener = undefined } },
    runtimeOwnerIdentity: () => ({ runtimeId: 'synthetic-runtime' }), inspectAgentInput: vi.fn(async () => null),
    submitAgentPrompt: vi.fn() } as unknown as AgentMuxHostedClient
  function Consumer() {
    useMobilePromptController({ local, client, agentSessionId: 'profile-session', session: null, timeline: null,
      connection: { state: 'connected', message: 'Synthetic connection' }, disconnected: false, visible: true, refresh: async () => {} })
    return null
  }
  const element = document.createElement('div'), view = createRoot(element)
  cleanups.push(async () => { await act(async () => view.unmount()); element.remove() })
  await act(async () => view.render(<Consumer />))
  expect(listener).toBeTypeOf('function')
  await act(async () => listener!({ type: 'agent-input', receipt }))
  const retained = local.attempts.get(key)!
  expect(retained.inputReceipt, 'mobile-hot-profile-removed').toEqual(withoutProfile(receipt))
  expect(retained).toBe(original)
  expect(retained.manualInput).toBe(original.manualInput)
  expect(retained.draft).toBe('Synthetic queue body')
  await local.save()
  const cold = getDeviceWorkface().snapshot().record.conversation.attempts.find(([id]) => id === key)![1]
  expect(cold).not.toHaveProperty('inputReceipt')
  expect(cold).not.toHaveProperty('mainRecord')
  expect(client.submitAgentPrompt).not.toHaveBeenCalled()
})
