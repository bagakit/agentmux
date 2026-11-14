// @vitest-environment happy-dom
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppConfig } from '../src/shared/contracts'
import type { AgentSteerQueueEntry } from '../src/renderer/src/store'
import type { AgentSessionUsagePage } from '@agentmux/core'

const isolated = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const supplied = process.env.AMX_HISTORY_HOME
  const directory = supplied ?? mkdtempSync(join(tmpdir(), 'amx-history-inputs-'))
  const { isolateCoreFixtureEnvironment } = await import('./helpers/isolate-core-environment')
  isolateCoreFixtureEnvironment(directory); vi.stubEnv('HOME', directory)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  await import('../src/renderer/src/lib/api')
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  return { directory, owned: !supplied }
})
const root = isolated.directory, reading = process.env.AMX_HISTORY_PHASE === 'read'
const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (isolated.owned) await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) })
const check = reading ? it.skip : it
const originalQueue: AgentSteerQueueEntry = { operationId: 'history-original-input', text: 'Synthetic retained queue body 中🙂\n  exact end  ', status: 'deferred',
  archived: true, inputIntakeStarted: true, awaitingExplicitSend: true,
  directInputControl: { kind: 'agent', hostId: 'selected-host', agentSessionId: 'retired-original', run: { runId: 'old-run' } },
  directInputBinding: { expectedRun: { runId: 'old-run' }, admissionIntent: { kind: 'manual-actor' } } }
const originalDraft = 'Synthetic unassociated Region draft 中🙂\n  exact end  '
const archivedId = 'confirmed-original-input'
const archivedKey = { kind: 'prompt' as const, agentSessionId: 'retired-original', expectedRun: { runId: 'old-run' }, submissionId: archivedId }
const archivedRef = { key: archivedKey, waitGeneration: 1 }
const originalArchive: AgentSteerQueueEntry = { ...originalQueue, operationId: archivedId, text: 'Synthetic cold archive body 中🙂\n  exact end  ',
  inputReceipt: { key: archivedKey, ref: archivedRef, status: 'terminal-confirmed', persistence: 'confirmed', observation: 'closed', admission: null,
    control: { ref: archivedRef, state: 'dispatch-authorized', gateId: 'original-gate', at: 2 } } }

async function mount(content: React.ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const element = document.createElement('div'); document.body.append(element)
  const view = createRoot(element); closes.push(async () => { await act(async () => view.unmount()); element.remove() })
  await act(async () => view.render(content)); return document.body
}
async function toggle(details: HTMLDetailsElement, open = true) { await act(async () => { details.open = open; details.dispatchEvent(new Event('toggle')) }) }
async function click(button: Element) { await act(async () => (button as HTMLElement).click()) }
const button = (element: Element, label: string) => {
  const found = [...element.querySelectorAll('button')].find(node => node.textContent === label)
  expect(found, `Actual mounted button ${label}`).toBeDefined(); return found!
}

check('original client owner projection preserves orphan keys, text, frozen Host and queue authority', async () => {
  const { localRetainedInputs } = await import('../src/renderer/src/lib/local-retained-inputs')
  const queue = [structuredClone(originalQueue), { ...originalQueue, operationId: 'other-host', directInputControl: { ...originalQueue.directInputControl!, hostId: 'other-host' } },
    { ...originalQueue, operationId: 'old-no-control', directInputControl: undefined }]
  const drafts = { 'old-orphan-region': originalDraft }
  const before = structuredClone({ drafts, queue })
  const inputs = localRetainedInputs(drafts, { 'retired-original': queue }, null)
  expect(inputs.length, 'local-unassociated-route-present').toBe(4)
  expect(inputs[0]).toMatchObject({ key: 'old-orphan-region', text: originalDraft, target: undefined })
  expect(inputs[1]).toMatchObject({ text: originalQueue.text, target: { hostId: 'selected-host', agentSessionId: 'retired-original' } })
  expect(inputs[2]!.target?.hostId).toBe('other-host'); expect(inputs[3]!.target).toBeUndefined()
  expect(inputs[1]!.entry).toBe(queue[0]); expect({ drafts, queue }).toEqual(before)
  const conflict = localRetainedInputs({}, { original: [{ ...originalQueue, browserRecipient: { ...originalQueue.directInputControl!, hostId: 'other-host' } }] }, null)
  expect(conflict[0]!.target).toBeUndefined()
  const graph = { regions: [{ kind: 'agent', regionId: 'known-region', agentSessionId: 'retired-original', execution: { hostId: 'selected-host' } }] } as unknown as import('@agentmux/core/spatial-graph').AgentMuxSpatialGraph
  expect(localRetainedInputs({ 'known-region': originalDraft }, {}, graph)[0]!.target).toEqual({ hostId: 'selected-host', agentSessionId: 'retired-original' })
})

check('mounted global local-input entry copies original unassociated draft and retained queue without Session/send/retry', async () => {
  const { LocalRetainedInputsPanel } = await import('../src/renderer/src/components/LocalRetainedInputs')
  const { useAppStore: store } = await import('../src/renderer/src/store')
  const { api } = await import('../src/renderer/src/lib/api')
  store.setState({ sessions: [], tabs: {}, agentComposerDrafts: { 'old-orphan-region': originalDraft }, agentSteerQueues: { 'retired-original': [structuredClone(originalQueue)] } })
  const before = structuredClone({ drafts: store.getState().agentComposerDrafts, queues: store.getState().agentSteerQueues })
  const copied = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const send = vi.spyOn(api.sessions, 'submitPrompt'), stop = vi.spyOn(api.sessions, 'stop'), reopen = vi.spyOn(api.sessions, 'reopen')
  const element = await mount(<LocalRetainedInputsPanel />)
  await click(button(element, 'Drafts & queue'))
  const records = [...element.querySelectorAll<HTMLDetailsElement>('.local-input-record')]
  expect(records.length, 'local-unassociated-route-present').toBe(2)
  await toggle(records[0]!); expect(records[0]!.querySelector('textarea')!.value).toBe(originalDraft)
  await click(button(records[0]!, 'Copy saved input')); expect(copied).toHaveBeenLastCalledWith(originalDraft)
  await toggle(records[1]!); expect(records[1]!.querySelector('textarea')!.value, 'local-original-body-preserved').toBe(originalQueue.text)
  await click(button(records[1]!, 'Copy saved input')); expect(copied).toHaveBeenLastCalledWith(originalQueue.text)
  expect({ drafts: store.getState().agentComposerDrafts, queues: store.getState().agentSteerQueues }).toEqual(before)
  expect(store.getState().sessions).toEqual([]); expect(send).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled()
})

check('selected detail automatically pages exact usage and cancels the active read on close, unknown stays unknown', async () => {
  const { SessionRecordDetails } = await import('../src/renderer/src/components/SessionRecordDetails')
  const { api } = await import('../src/renderer/src/lib/api')
  const target = { hostId: 'selected-host', agentSessionId: 'retired-original' }
  const base: AgentSessionUsagePage = { ...target, observedAt: 1, lifecycle: { state: 'retired', retiredAt: 1 },
    captured: { status: 'measured', epoch: 'original-epoch', throughSequence: 500, afterSequence: 0, lastSequence: 256, records: 256, logicalBytes: 4096, complete: false, nextCursor: 'original-cursor' },
    unmeasured: ['other-core-records', 'provider-native', 'ctxmux-runtime', 'shared-database-physical'] }
  let secondSignal: AbortSignal | undefined
  const read = vi.spyOn(api.sessions, 'readUsage').mockImplementation(async (reference, options, context) => {
    expect(reference).toEqual(target)
    if (!options.cursor) return base
    expect(options.cursor).toBe('original-cursor'); secondSignal = context?.signal
    return await new Promise((_resolve, reject) => context!.signal!.addEventListener('abort', () => reject(context!.signal!.reason), { once: true }))
  })
  const element = await mount(<SessionRecordDetails target={target} />)
  expect(read).not.toHaveBeenCalled()
  await click(button(element, 'Record details'))
  await act(async () => { await new Promise(done => setTimeout(done, 30)) })
  expect(read).toHaveBeenCalledTimes(2); expect(element.textContent).toContain('4.0 KiB')
  expect(element.textContent).toContain('Other Core records'); expect(element.textContent).toContain('not measured')
  await click(button(element.querySelector('.session-record-details')!, 'Close')); expect(secondSignal?.aborted).toBe(true)
  read.mockResolvedValue({ ...base, captured: { status: 'not-measured', reason: 'Original source not confirmed' } })
  await click(button(element, 'Record details'))
  expect(element.textContent).toContain('Original source not confirmed'); expect(element.textContent).not.toContain('0 B')
})

async function desktop(seed: boolean) {
  const { WorkbenchUserStateStore } = await import('../src/main/workbench-user-state')
  const owner = new WorkbenchUserStateStore(join(root, 'workbench-user-state.json'))
  if (seed) await writeFile(owner.path, JSON.stringify({ state: { agentComposerDrafts: { 'old-orphan-region': originalDraft },
    agentSteerQueues: { 'retired-original': [originalQueue, originalArchive] } }, version: 1, desktopFragments: { exactUnknownFragment: { keep: true } } }))
  const { useAppStore: store, prepareRendererUpdate } = await import('../src/renderer/src/store')
  const { api } = await import('../src/renderer/src/lib/api')
  const { AgentMuxSpatialStateStore } = await import('@agentmux/core/spatial-state')
  const { providerCatalogReader, historySourcesReader } = await import('./helpers/startup-observation-api-fixture')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {}, workspaces: [],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  store.setState({ config, sessions: [], tabs: {}, layouts: {}, agentComposerDrafts: {}, agentSteerQueues: {} })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => owner.read())
  vi.spyOn(api.ui, 'readWorkbenchInputArchive').mockImplementation(query => owner.readInputArchive(query))
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => owner.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => owner.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined); vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  closes.push(await store.getState().initialize())
  return { store, api, owner, prepareRendererUpdate }
}
check('original Main user-document hydrate and actual save keep unassociated input reachable without an active Session', async () => {
  const f = await desktop(true)
  const { LocalRetainedInputsPanel } = await import('../src/renderer/src/components/LocalRetainedInputs')
  expect(f.api.ui.readWorkbenchInputArchive).not.toHaveBeenCalled()
  const element = await mount(<LocalRetainedInputsPanel />); await click(button(element, 'Drafts & queue'))
  await vi.waitFor(() => expect(element.querySelectorAll('.local-input-record')).toHaveLength(3))
  expect(f.store.getState().agentComposerDrafts['old-orphan-region']).toBe(originalDraft)
  expect(f.store.getState().agentSteerQueues['retired-original']![0]).toMatchObject(originalQueue)
  await f.prepareRendererUpdate('quit')
  expect(f.api.ui.writeWorkbenchState).toHaveBeenCalled(); expect(f.owner.observe().lastConfirmedWrite?.diskDurability).toBe('confirmed')
  const saved = JSON.parse((await f.owner.read())!)
  expect(saved.state.agentComposerDrafts['old-orphan-region']).toBe(originalDraft)
  expect(saved.state.agentSteerQueues['retired-original']).toMatchObject([originalQueue])
  expect(await f.owner.readInputArchive({ ownerKey: 'retired-original' })).toMatchObject({ entries: [{ ownerKey: 'retired-original', entry: originalArchive }], nextCursor: null })
  expect(saved.desktopFragments.exactUnknownFragment.keep).toBe(true)
  expect(f.api.sessions.submitPrompt).not.toHaveBeenCalled(); expect(f.api.sessions.stop).not.toHaveBeenCalled()
}, 20000)

;(reading ? it : it.skip)('fresh process discovers and copies the original saved draft and queue without reseeding', async () => {
  const f = await desktop(false)
  const before = JSON.parse((await f.owner.read())!)
  expect(before.state.agentComposerDrafts['old-orphan-region']).toBe(originalDraft)
  expect(before.state.agentSteerQueues['retired-original']).toMatchObject([originalQueue])
  const { LocalRetainedInputsPanel } = await import('../src/renderer/src/components/LocalRetainedInputs')
  const copied = vi.spyOn(f.api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  expect(f.api.ui.readWorkbenchInputArchive).not.toHaveBeenCalled()
  const element = await mount(<LocalRetainedInputsPanel />); await click(button(element, 'Drafts & queue'))
  await vi.waitFor(() => expect(element.querySelectorAll('.local-input-record')).toHaveLength(3))
  const records = [...element.querySelectorAll<HTMLDetailsElement>('.local-input-record')]
  await toggle(records[0]!); await click(button(records[0]!, 'Copy saved input')); expect(copied).toHaveBeenLastCalledWith(originalDraft)
  await toggle(records[1]!); await click(button(records[1]!, 'Copy saved input')); expect(copied).toHaveBeenLastCalledWith(originalQueue.text)
  await toggle(records[2]!); await click(button(records[2]!, 'Copy saved input')); expect(copied).toHaveBeenLastCalledWith(originalArchive.text)
  expect(f.store.getState().sessions).toEqual([])
  expect(f.api.sessions.submitPrompt).not.toHaveBeenCalled(); expect(f.api.sessions.stop).not.toHaveBeenCalled()
}, 20000)
