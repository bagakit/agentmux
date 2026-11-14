// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import { BrowserDemonstrationRecorder, BrowserDemonstrationFileStore } from '../src/main/browser-demonstration-recorder.js'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state.js'
import { WORKBENCH_USER_STATE_KEY } from '../src/renderer/src/lib/workbench-user-storage.js'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state.js'
import { browserTaskCreateInput, type BrowserTaskCreateInput } from '@agentmux/core/control'
import type { BrowserTaskAssetDocument } from '../src/shared/browser-task-assets.js'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration.js'
import { submitBrowserTaskCreation, inspectBrowserTaskCreation, type BrowserTaskCreationPorts } from '../src/renderer/src/lib/browser-task-creation.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { reducePersistedTab, hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore, checkpointSpatialWorkbench } from '../src/renderer/src/store.js'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'

const browserId = 'original-browser', url = 'https://generic.invalid/form'
function recording(): BrowserDemonstrationDraft {
  return { id: 'recording-original', browserId, revision: 2, status: 'stopped', navigationId: 'navigation-original', url,
    startedAt: 1, updatedAt: 2, steps: [{ id: 'fill-original', sequence: 1, navigationId: 'navigation-original', recordedAt: 2,
      source: 'native-human', method: 'fillInput', url, target: { role: 'text input', name: 'Field', ordinal: 1, count: 1 },
      inputKey: 'fresh', args: ['private-input-sentinel'] }] }
}
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  async load() { return structuredClone(this.document) }
  async save(value: BrowserTaskAssetDocument) { this.document = structuredClone(value) }
}
const directories: string[] = []
let bundle: string
beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-create-code-')); directories.push(directory)
  bundle = join(directory, 'process.mjs')
  await build({ configFile: false, logLevel: 'silent', build: { ssr: true, minify: false, emptyOutDir: false, outDir: directory,
    rollupOptions: { input: resolve('apps/desktop/test/fixtures/browser-task-create-process.ts'), external: id => !id.startsWith('.') && !id.startsWith('/'),
      output: { format: 'es', entryFileNames: 'process.mjs' } } } })
  await symlink(resolve('apps/desktop/node_modules'), join(directory, 'node_modules'))
})
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))) })
afterEach(() => { vi.restoreAllMocks() })
async function files() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-create-state-')); directories.push(directory)
  const input = browserTaskCreateInput(recording()), inputPath = join(directory, 'input.json'), sourcePath = join(directory, 'recordings.json'), assetPath = join(directory, 'assets.json')
  await writeFile(inputPath, JSON.stringify(input))
  // This is the Main recorder's own storage, not a client-provided replacement in a request.
  const stopped = recording(); stopped.steps = stopped.steps.map(step => ({ ...step, args: [] }))
  await new BrowserDemonstrationFileStore(sourcePath).save({ version: 1, drafts: [stopped] })
  return { directory, input, inputPath, sourcePath, assetPath }
}
async function child(mode: string, f: Awaited<ReturnType<typeof files>>) {
  return new Promise<{ pid: number; code: number; value: any; stdout: string }>((accept, reject) => {
    const processChild = spawn(process.execPath, [bundle, mode, f.assetPath, f.sourcePath, f.inputPath], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    processChild.stdout.setEncoding('utf8').on('data', value => { stdout += value })
    processChild.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    processChild.once('error', reject)
    processChild.once('close', code => code === 0 ? accept({ pid: processChild.pid!, code, stdout, value: stdout ? JSON.parse(stdout) : null }) : reject(new Error(stderr)))
  })
}
function manager(owner: BrowserTaskAssets, source: BrowserDemonstrationRecorder) {
  const value = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(value, { taskAssets: owner, demonstrations: source })
  return value
}
function gui(f: { manager: BrowserViewManager; input: BrowserTaskCreateInput }) {
  let pending: BrowserTaskCreateInput[] = [], currentBrowser = browserId, generation = 0
  const selected = vi.fn(), order: string[] = []
  const create = vi.spyOn(api.browser, 'importTaskAsset').mockImplementation((id, input) => { order.push('Main'); return f.manager.importTaskAsset(id, input) })
  vi.spyOn(api.browser, 'inspectTaskAssetCreation').mockImplementation((id, input) => f.manager.inspectTaskAssetCreation(id, input))
  const ports = (): BrowserTaskCreationPorts => { const originalGeneration = generation; return {
    keep: async (input, expected) => {
      if (input) { order.push('input'); if (!pending.some(value => value.createOperationId === input.createOperationId)) pending.push(structuredClone(input)) }
      else { if (!pending.some(value => value.createOperationId === expected)) return false; pending = pending.filter(value => value.createOperationId !== expected) }
      return true
    }, create: input => api.browser.importTaskAsset(input.browserId, input), inspect: input => api.browser.inspectTaskAssetCreation(input.browserId, input),
    isCurrent: input => currentBrowser === input.browserId && generation === originalGeneration, select: selected
  } }
  return { get ports() { return ports() }, selected, order, create, pending: () => pending,
    restore: (inputs: BrowserTaskCreateInput[]) => { pending = inputs }, addLater: (input: BrowserTaskCreateInput) => { pending.push(input); generation++ }, switchBrowser: () => { currentBrowser = 'another-browser' } }
}

describe('original task creation owner and GUI input', () => {
  it('reuses the exact operation/asset and frozen intent, including after edits and source changes', async () => {
    const store = new MemoryStore(), owner = new BrowserTaskAssets(store), source = recording(), input = browserTaskCreateInput(source)
    const read = vi.fn(async () => source)
    const first = await owner.importRecording(input, read)
    const edited = await owner.edit(first.id, first.revision, { ...first.draft, name: 'Later draft' })
    const again = await owner.importRecording(input, async () => { throw new Error('The original recording has changed') })
    expect(again.id).toBe(input.assetId); expect(again.draft.name).toBe('Later draft')
    expect(again.creation).toEqual(input); expect(again.creation).toEqual(first.creation)
    expect((await owner.state(browserId)).assets).toHaveLength(1)
    expect(again).toEqual(edited); expect(read).toHaveBeenCalledOnce()
    expect(JSON.stringify(store.document)).not.toContain('private-input-sentinel')
    expect(first.draft.steps).toMatchObject([{ reviewed: false }]); expect(first.versions).toEqual([])
    expect((await owner.state(browserId)).runs).toEqual([])
  })

  it('refuses both binding directions, changed intent and legacy asset claims without touching original data', async () => {
    const store = new MemoryStore(), owner = new BrowserTaskAssets(store), source = recording(), input = browserTaskCreateInput(source)
    const first = await owner.importRecording(input, async () => source), before = structuredClone(store.document)
    for (const change of [{ assetId: browserTaskCreateInput(source).assetId }, { browserId: 'wrong-browser' }, { sourceRecordingId: 'wrong-recording' },
      { sourceRevision: 3 }, { name: 'Different original name' }, { createOperationId: browserTaskCreateInput(source).createOperationId }]) {
      await expect(owner.importRecording({ ...input, ...change }, async () => source)).rejects.toMatchObject({ code: 'BROWSER_TASK_CREATE_CONFLICT' })
      expect(store.document).toEqual(before)
    }
    delete store.document!.assets[0]!.creation
    const legacy = new BrowserTaskAssets(store)
    await expect(legacy.importRecording({ ...input, createOperationId: browserTaskCreateInput(source).createOperationId }, async () => source)).rejects.toMatchObject({ code: 'BROWSER_TASK_CREATE_CONFLICT' })
    expect((await legacy.get(first.id))?.draft).toEqual(first.draft)
  })

  it('requires the actual stopped/interrupted Main source id, Browser and revision, never client body or approval', async () => {
    const source = recording(), input = browserTaskCreateInput(source), store = new MemoryStore(), owner = new BrowserTaskAssets(store)
    for (const changed of [null, { ...source, id: 'new-recording' }, { ...source, browserId: 'another-browser' }, { ...source, revision: 3 }, { ...source, status: 'recording' as const }]) {
      await expect(owner.importRecording(input, async () => changed)).rejects.toMatchObject({ code: 'BROWSER_TASK_CREATE_SOURCE_CONFLICT' })
      expect((await owner.state(browserId)).assets).toEqual([])
    }
    await expect(owner.importRecording({ ...input, recording: source } as any, async () => source)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(owner.importRecording({ ...input, humanCheckpoints: [{ origin: 'trusted-ui' }] } as any, async () => source)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    const created = await owner.importRecording(input, async () => ({ ...source, status: 'interrupted' }))
    expect(created.creation).toEqual(input); expect(created.draft.steps.every(step => !step.reviewed)).toBe(true)
  })

  it('checks unknown writes read-only, then explicitly continues the original proposed identity without duplicates', async () => {
    for (const after of [false, true]) {
      const store = new MemoryStore(), source = recording(), input = browserTaskCreateInput(source)
      let fail = true
      const save = vi.spyOn(store, 'save').mockImplementation(async value => {
        if (!fail || after) store.document = structuredClone(value)
        if (fail) throw new Error('Unknown write acknowledgement')
      })
      const owner = new BrowserTaskAssets(store)
      await expect(owner.importRecording(input, async () => source)).rejects.toMatchObject({ code: 'BROWSER_TASK_CREATE_UNCONFIRMED' })
      const savedCalls = save.mock.calls.length
      expect(await owner.inspectCreation(input)).toMatchObject({ status: after ? 'created' : 'unknown', assetId: input.assetId })
      expect(save).toHaveBeenCalledTimes(savedCalls)
      fail = false
      await owner.importRecording(input, async () => { throw new Error('Source must not be reinterpreted') })
      expect((await owner.state(browserId)).assets.map(asset => asset.id)).toEqual([input.assetId])
      expect(await owner.inspectCreation(input)).toMatchObject({ status: 'created' })
    }
  })

  it('a later readable receipt retains original versions and interrupted Runs without a readonly rewrite or replay', async () => {
    const store = new MemoryStore(), original = new BrowserTaskAssets(store), source = recording(), input = browserTaskCreateInput(source)
    const created = await original.importRecording(input, async () => source)
    const edited = await original.edit(created.id, created.revision, { ...created.draft, parameters: [], steps: [{ id: 'human-step', kind: 'checkpoint', url, reviewed: true }] })
    const published = await original.saveVersion(created.id, edited.revision)
    const runScript = vi.fn()
    const run = await original.run({ browserId, assetId: created.id, version: 1, parameters: {} }, {
      control: () => 'agent', yieldControl: vi.fn(), onRunPrepared: vi.fn(), runScript
    })
    store.document!.runs[0]!.status = 'running'
    const before = structuredClone(store.document)
    let unreadable = true
    const restored = new BrowserTaskAssets({ load: async () => { if (unreadable) throw new Error('Private read unavailable'); return store.load() }, save: value => store.save(value) })
    expect((await restored.state(browserId)).warning).toContain('could not be restored')
    unreadable = false
    const save = vi.spyOn(store, 'save')
    expect(await restored.inspectCreation(input)).toMatchObject({ status: 'created', assetId: created.id })
    const state = await restored.state(browserId)
    expect(state.assets[0]!.versions).toEqual(published.versions)
    expect(state.runs).toMatchObject([{ id: run.id, status: 'interrupted', nextStep: run.nextStep }])
    expect(state.runs[0]!.warning).toContain('not automatically replayed')
    expect(store.document).toEqual(before); expect(save).not.toHaveBeenCalled(); expect(runScript).not.toHaveBeenCalled()
  })

  it('survives real process exits before/after unknown writes and a lost reply using the original frozen IDs', async () => {
    for (const mode of ['fail-before', 'fail-after', 'commit-no-reply']) {
      const f = await files(), first = await child(mode, f)
      if (mode === 'commit-no-reply') expect(first.stdout).toBe('')
      else expect(first.value.code).toBe('BROWSER_TASK_CREATE_UNCONFIRMED')
      const inspected = await child('inspect', f)
      expect(inspected.pid).not.toBe(first.pid)
      expect(inspected.value).toMatchObject({ assetId: f.input.assetId, createOperationId: f.input.createOperationId,
        status: mode === 'fail-before' ? 'not-found' : 'created' })
      const resumed = await child('continue', f)
      expect(resumed.value).toMatchObject({ assetId: f.input.assetId, count: 1, reads: mode === 'fail-before' ? 1 : 0 })
      const confirmed = new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.assetPath))
      expect((await confirmed.state(browserId)).assets).toHaveLength(1)
      expect((await confirmed.get(f.input.assetId))?.creation).toEqual(f.input)
    }
  }, 30_000)

  it('GUI → API → original Manager/recorder/owner preserves frozen input over lost reply and remount, then checks instead of recreating', async () => {
    const f = await files(), assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.assetPath))
    const recorder = new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(f.sourcePath)), main = manager(assets, recorder), ui = gui({ manager: main, input: f.input })
    ui.create.mockImplementationOnce(async (id, input) => { await main.importTaskAsset(id, input); throw new Error('Reply was lost') })
    await expect(submitBrowserTaskCreation(ui.ports, f.input)).rejects.toThrow('Reply was lost')
    expect(ui.order[0]).toBe('input'); expect(ui.pending()).toEqual([f.input]); expect(ui.selected).not.toHaveBeenCalled()
    const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'browser', workspaceId: 'workspace', browserId,
      id: browserId, url, title: 'Page', mode: 'normal', profileId: 'profile', loading: false, canGoBack: false, canGoForward: false,
      viewport: 'responsive', navigationId: 'navigation', error: null, driving: false, appLinkPrompt: null, taskCreationInputs: ui.pending() })
    const persisted = JSON.parse(JSON.stringify(reducePersistedTab(tab))), restored = hydratePersistedTab(persisted)
    const recovered = restored.regions['original-region']!
    if (recovered.kind !== 'browser') throw new Error('Exact Browser input missing')
    expect(recovered.taskCreationInputs).toEqual([f.input])
    ui.restore(recovered.taskCreationInputs!)
    const creates = ui.create.mock.calls.length
    await inspectBrowserTaskCreation(ui.ports, recovered.taskCreationInputs![0]!)
    expect(ui.create).toHaveBeenCalledTimes(creates); expect(ui.selected).toHaveBeenCalledExactlyOnceWith(f.input.assetId)
    expect(ui.pending()).toEqual([]); expect((await assets.state(browserId)).assets).toHaveLength(1)
  })

  it('late replies cannot clear a newer input or select an asset in another Browser', async () => {
    const f = await files(), owner = new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.assetPath)), main = manager(owner, new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(f.sourcePath)))
    const ui = gui({ manager: main, input: f.input }), later = browserTaskCreateInput(recording())
    let finish!: () => void
    ui.create.mockImplementationOnce(async (id, input) => { const value = await main.importTaskAsset(id, input); await new Promise<void>(done => { finish = done }); return value })
    const request = submitBrowserTaskCreation(ui.ports, f.input)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    ui.addLater(later); finish(); await request
    expect(ui.pending()).toEqual([f.input, later]); expect(ui.selected).not.toHaveBeenCalled()
    ui.switchBrowser()
    await inspectBrowserTaskCreation(ui.ports, f.input)
    expect(ui.pending()).toEqual([f.input, later]); expect(ui.selected).not.toHaveBeenCalled()
  })

  it('the actual workbench input writer waits for confirmation and retains the original input when saving fails', async () => {
    const initial = useAppStore.getState(), f = await files(), spatialPath = join(f.directory, 'spatial.json')
    const spatial = new AgentMuxSpatialStateStore(spatialPath)
    await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} } })
    vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
    let failSpatial = false
    vi.spyOn(api.spatial, 'commit').mockImplementation(input => {
      if (failSpatial) return Promise.reject(new Error('Private spatial acknowledgement unavailable'))
      return spatial.commit(input)
    })
    vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
    vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
    const dispose = await useAppStore.getState().initialize()
    try {
      const input = f.input, workspaceId = 'workspace-demo'
      const tab = createWorkbenchTab('input-tab', { regionId: 'input-region', kind: 'browser', workspaceId, browserId,
        id: browserId, url, title: 'Page', mode: 'normal', profileId: 'profile', loading: false, canGoBack: false, canGoForward: false,
        viewport: 'responsive', navigationId: 'navigation', error: null, driving: false, appLinkPrompt: null })
      useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('input-group', [tab.id]) } })
      await checkpointSpatialWorkbench()
      const flush = vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
      const create = vi.fn()
      const ports: BrowserTaskCreationPorts = {
        keep: (value, expected) => useAppStore.getState().saveBrowserTaskCreationInput(browserId, value, expected),
        create, inspect: vi.fn(), isCurrent: input => input.browserId === browserId, select: vi.fn()
      }
      failSpatial = true
      const refused = await submitBrowserTaskCreation(ports, input).catch(error => error)
      expect(create).not.toHaveBeenCalled()
      expect(refused).toMatchObject({ message: 'Private spatial acknowledgement unavailable' })
      failSpatial = false
      flush.mockRejectedValue(new Error('Private storage acknowledgement unavailable'))
      await expect(submitBrowserTaskCreation(ports, input)).rejects.toThrow('Private storage acknowledgement unavailable')
      const region = useAppStore.getState().tabs[tab.id]!.regions['input-region']!
      expect(region.kind === 'browser' && region.taskCreationInputs).toEqual([input])
      expect(create).not.toHaveBeenCalled(); expect(flush).toHaveBeenCalled()
      const later = browserTaskCreateInput(recording())
      await expect(useAppStore.getState().saveBrowserTaskCreationInput(browserId, later)).rejects.toThrow('original task import input is kept')
      expect(await useAppStore.getState().saveBrowserTaskCreationInput(browserId, null, later.createOperationId)).toBe(false)
      expect(useAppStore.getState().tabs[tab.id]!.regions['input-region']).toBe(region)
      const newSource = browserTaskCreateInput({ ...recording(), id: 'next-source', revision: 1 })
      await expect(useAppStore.getState().saveBrowserTaskCreationInput(browserId, newSource)).rejects.toThrow('Private storage acknowledgement unavailable')
      const latest = useAppStore.getState().tabs[tab.id]!.regions['input-region']!
      expect(latest.kind === 'browser' && latest.taskCreationInputs).toEqual([input, newSource])
      const changedRecording = { ...recording(), id: newSource.sourceRecordingId, revision: newSource.sourceRevision,
        steps: recording().steps.map(step => ({ ...step, args: [] })) }
      await new BrowserDemonstrationFileStore(f.sourcePath).save({ version: 1, drafts: [changedRecording] })
      const owner = new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.assetPath))
      const main = manager(owner, new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(f.sourcePath)))
      const userPath = join(f.directory, 'workbench.json'), userState = new WorkbenchUserStateStore(userPath)
      vi.spyOn(api.browser, 'importTaskAsset').mockImplementation((id, request) => main.importTaskAsset(id, request))
      // Vitest's preview host stores the real Store checkpoint in Web Storage. Bind that
      // transport to the real native user-document writer, including its exact digest ACK.
      flush.mockImplementation(async () => {
        const raw = localStorage.getItem(WORKBENCH_USER_STATE_KEY)!
        await userState.write(raw)
        expect(await userState.read()).toBe(raw)
        expect(userState.observe().contentDigest).toBe(userState.observe().lastConfirmedWrite?.contentDigest)
      })
      create.mockImplementation(async request => {
        const persisted = await spatial.read()
        const browser = persisted!.graph.resources['region:input-region'] as { taskCreationInputs: BrowserTaskCreateInput[] }
        expect(browser.taskCreationInputs).toContainEqual(request)
        return api.browser.importTaskAsset(browserId, request)
      })
      await submitBrowserTaskCreation(ports, newSource)
      expect(ports.select).toHaveBeenCalledExactlyOnceWith(newSource.assetId)
      expect((await owner.state(browserId)).assets.map(asset => asset.id)).toEqual([newSource.assetId])
      expect(await owner.inspectCreation(input)).toMatchObject({ status: 'not-found' })
      const after = useAppStore.getState().tabs[tab.id]!.regions['input-region']!
      expect(after.kind === 'browser' && after.taskCreationInputs).toEqual([input])
      expect(after.kind === 'browser' && after.url).toBe(url)
      // A different OS process reads the confirmed original user document. The actual
      // hydration reducer restores only the remaining original request on this Browser.
      const reopened = await child('read-spatial', { ...f, assetPath: spatialPath })
      const restored = hydratePersistedTab(desktopWorkbenchFromSpatial(reopened.value.graph).tabs[tab.id]!)
      const restoredBrowser = restored.regions['input-region']!
      expect(restoredBrowser.kind === 'browser' && restoredBrowser.taskCreationInputs).toEqual([input])
      expect(restoredBrowser.kind === 'browser' && restoredBrowser.url).toBe(url)
    } finally { dispose?.(); useAppStore.setState(initial, true) }
  })
})
