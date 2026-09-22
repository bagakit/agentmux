// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { BrowserTaskAssets, type BrowserTaskAssetHost, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import { BrowserOperationJournal, type BrowserOperationJournalDocument } from '../src/main/browser-operation-journal'
import type { BrowserTaskAssetDocument, BrowserTaskAssetState, BrowserTaskAssetRun } from '../src/shared/browser-task-assets'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration'
import type { BrowserActivityState } from '../src/shared/browser-operation'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const bridge = vi.hoisted(() => ({ executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] })),
  runTask: vi.fn(), stopTask: vi.fn(), saveDraft: vi.fn(), returnControl: vi.fn(), reportError: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: {
  getDemonstration: async () => ({ draft: null }), getTaskAssets: async () => ({ assets: [], runs: [] }),
  cancelElementSelection: async () => {}, setAnnotationMarkers: async () => {}, setBounds: async () => {},
  runTaskAsset: bridge.runTask, stopTaskAsset: bridge.stopTask, saveTaskAssetDraft: bridge.saveDraft,
  returnControl: bridge.returnControl
}, ui: { getZoomFactor: () => 1 } } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({
  executeControl: bridge.executeControl, reportError: bridge.reportError, applyBrowserEvent: vi.fn(),
  setWorkspaceTool: vi.fn(), saveBrowserBookmark: vi.fn(), openFile: vi.fn(),
  config: { browser: { toolbar: { more: true } } }, toolsOpen: false,
  browserAnnotationsByBrowserId: {}, addBrowserAnnotation: vi.fn()
}) }))
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { BrowserOperationStatus } from '../src/renderer/src/components/BrowserOperationSurface'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import { BrowserDemonstrationSurface } from '../src/renderer/src/components/BrowserDemonstrationSurface'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
beforeEach(() => vi.clearAllMocks())

const recording: BrowserDemonstrationDraft = {
  id: 'recorded-source', browserId: 'browser-1', navigationId: 'navigation-1', url: 'https://example.test/form',
  revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2,
  steps: Array.from({ length: 5 }, (_, index) => ({ id: `recorded-${index}`, sequence: index + 1,
    recordedAt: index + 2, navigationId: 'navigation-1', source: 'native-human' as const, method: 'click' as const,
    url: 'https://example.test/form', args: [], target: { role: 'button', name: `Action ${index + 1}`, ordinal: 1, count: 1 } }))
}

// This fixture consumes the actual Main cursor and Journal transitions. The controlled runScript host
// reports a known action; native trusted input and actual product restart remain canonical GUI gates.
async function ownerFixture(mode?: 'step') {
  let document: BrowserTaskAssetDocument | null = null, journalDocument: BrowserOperationJournalDocument | null = null
  let identity = 0, at = 100
  const store: BrowserTaskAssetStore = { load: async () => structuredClone(document), save: async next => { document = structuredClone(next) } }
  const options = { now: () => at++, id: () => `owner-${++identity}` }
  const owner = new BrowserTaskAssets(store, options)
  const journal = new BrowserOperationJournal({ load: async () => journalDocument,
    save: async next => { journalDocument = structuredClone(next) } }, options)
  const imported = await owner.importRecording(recording)
  const draft = { ...imported.draft, name: 'Review profile', parameters: [{ key: 'name', label: 'Name', secret: true }], steps: [
    { ...imported.draft.steps[0]!, reviewed: true },
    { id: 'human-review', kind: 'checkpoint' as const, url: recording.url, label: 'Check the profile', reviewed: true },
    { id: 'fill-name', kind: 'fill' as const, url: recording.url, reviewed: true, parameterKey: 'name',
      target: { role: 'text input', name: 'Name', ordinal: 1, count: 1 } }
  ] }
  const edited = await owner.edit(imported.id, imported.revision, draft)
  const first = await owner.saveVersion(imported.id, edited.revision)
  const newer = await owner.edit(imported.id, first.revision, { ...draft, name: 'Review profile updated' })
  await owner.saveVersion(imported.id, newer.revision)
  let control: 'agent' | 'human' = 'agent'
  let preparedRunId: string | undefined
  const host: BrowserTaskAssetHost = {
    onRunPrepared: runId => { preparedRunId = runId },
    control: () => control, yieldControl: () => { control = 'human' },
    runScript: async browserId => {
      expect((await owner.state(browserId)).runs.map(run => ({ id: run.id, status: run.status })))
        .toEqual([{ id: preparedRunId, status: 'running' }])
      const operation = await journal.start({ browserId, operator: { id: 'person', name: 'Person' }, summary: 'Click Action 1', url: recording.url })
      const step = await journal.startStep(operation.id, { method: 'click', label: 'Click Action 1', target: recording.steps[0]!.target! })
      await journal.finishStep(operation.id, step!.sequence, { status: 'completed' })
      const completed = await journal.finish(operation.id, 'completed')
      return { result: undefined, logs: [], outcome: { kind: 'completed' }, runOperation: completed! }
    }
  }
  const run = await owner.run({ assetId: imported.id, browserId: recording.browserId, version: 1, parameters: {}, ...(mode ? { mode } : {}) }, host)
  expect(preparedRunId).toBe(run.id)
  const state = await owner.state(recording.browserId)
  const operation = (await journal.list())[0]!
  expect(state.assets).toHaveLength(1)
  expect(state.assets[0]!.versions.map(version => version.version)).toEqual([1, 2])
  expect(state.runs).toEqual([run])
  expect(run.operationIds).toEqual([operation.id])
  expect(operation.steps.map(step => step.status)).toEqual(['completed'])
  return { state, operation, control, run, owner, journal,
    restore: async () => new BrowserTaskAssets(store, options).state(recording.browserId) }
}

async function mount(element: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  return { host, root, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
const tab = (state: BrowserTaskAssetState, activity: BrowserActivityState): BrowserWorkbenchSurface => ({
  kind: 'browser', id: recording.browserId, browserId: recording.browserId, regionId: 'region-1', workspaceId: 'workspace-1',
  navigationId: recording.navigationId, profileId: 'profile-1', title: 'Profile', url: recording.url,
  canGoBack: false, canGoForward: false, loading: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null,
  taskAssets: state, activity, demonstration: { draft: recording, warning: 'Saved recording retained' }
})
async function openStatus(host: HTMLElement) {
  const trigger = host.querySelector<HTMLButtonElement>('.browser-operation-status__trigger')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  const menu = document.querySelector<HTMLElement>('.browser-operation-menu')!
  expect(menu).not.toBeNull()
  return menu
}

it('projects actual Main waiting next to the completed Journal action before opening details, then reviews the real v1', async () => {
  const fixture = await ownerFixture()
  expect(fixture.run.status).toBe('waiting-human')
  const otherAsset = { ...fixture.state.assets[0]!, id: 'different-task', draft: { ...fixture.state.assets[0]!.draft, name: 'Different saved task' } }
  const state = { ...fixture.state, assets: [...fixture.state.assets, otherAsset] }
  const view = await mount(<BrowserPane tab={tab(state, { operation: fixture.operation, control: fixture.control })} visible={false} />)
  try {
    const status = view.host.querySelector('.browser-operation-status')!
    expect(status.getAttribute('data-phase')).toBe('human')
    expect(status.getAttribute('data-task-run-id')).toBe(fixture.run.id)
    expect(status.getAttribute('data-task-version')).toBe('1')
    const trigger = status.querySelector('button')!
    expect(trigger.getAttribute('aria-label')).toContain('Review profile · Waiting for human checkpoint · v1 · Check the profile · Next step 3')
    expect(trigger.querySelector('.lucide-user-round')).not.toBeNull()
    expect(view.host.querySelector('.browser-trace-rail')).toBeNull()
    const menu = await openStatus(view.host)
    const review = menu.querySelector<HTMLElement>('[aria-label="Review and continue task v1"]')!
    expect(review).not.toBeNull()
    await act(async () => { review.focus(); review.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(bridge.runTask).not.toHaveBeenCalled()
    expect(bridge.returnControl).not.toHaveBeenCalled()
    const source = view.host.querySelector<HTMLDetailsElement>('.browser-demonstration__steps')!
    expect(source.open).toBe(false)
    expect(source.querySelectorAll('[data-sequence]')).toHaveLength(5)
    expect(view.host.querySelector('[aria-label="Start recording demonstration"]')).not.toBeNull()
    expect(view.host.textContent).toContain('Saved recording retained')
    const editor = view.host.querySelector('.browser-task-asset')!
    expect(editor.getAttribute('data-task-asset-id')).toBe(fixture.run.assetId)
    expect(editor.querySelectorAll('[data-task-step-id]')).toHaveLength(3)
    const progress = editor.querySelector('.browser-task-asset__progress')!
    expect(progress.getAttribute('data-run-version')).toBe('1')
    const versionSelect = editor.querySelector<HTMLSelectElement>('[aria-label="Task asset version"]')!
    expect(versionSelect.value).toBe('1')
    expect(progress.textContent).toContain('Review profile · v1')
    expect(progress.textContent).not.toContain('Review profile updated')
    await act(async () => { versionSelect.value = '2'; versionSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(versionSelect.value).toBe('2')
    expect(progress.getAttribute('data-run-version')).toBe('1')
    await act(async () => view.root.render(<BrowserPane tab={tab(state, { operation: fixture.operation, control: fixture.control })} visible={false} />))
    expect(versionSelect.value).toBe('2')
    const again = (await openStatus(view.host)).querySelector<HTMLElement>('[aria-label="Review and continue task v1"]')!
    await act(async () => { again.focus(); again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(versionSelect.value).toBe('1')
    expect(bridge.runTask).not.toHaveBeenCalled()
    expect(bridge.returnControl).not.toHaveBeenCalled()
    expect(progress.compareDocumentPosition(editor.querySelector('[aria-label="Task asset name"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0)
    expect(editor.querySelector('header')?.textContent).not.toContain(fixture.state.assets[0]!.id)
    const timeline = view.host.querySelector('.browser-rsi-timeline__step--completed')!
    expect(timeline).not.toBeNull()
    expect(timeline.textContent).toContain('completed')
    const summary = source.querySelector('summary')!
    expect(summary.getAttribute('aria-label')).toBe('Recorded demonstration steps')
    await act(async () => { source.open = true; source.dispatchEvent(new Event('toggle')) })
    expect(source.open).toBe(true)
    // Existing trusted Client handlers still reject synthetic actions after this review-only menu.
    const stop = [...editor.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Stop task')!
    await act(async () => stop.click())
    expect(bridge.stopTask).not.toHaveBeenCalled()
    await act(async () => { versionSelect.value = '2'; versionSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="Close browser activity timeline"]')!.click())
    const activity = (await openStatus(view.host)).querySelector<HTMLElement>('[aria-label="Open browser activity timeline"]')!
    await act(async () => { activity.focus(); activity.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // A generic reopening uses the normal saved-version view; a consumed review intent cannot replay.
    expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Task asset version"]')?.value).toBe('2')
    expect(view.host.querySelector('.browser-task-asset__progress')?.getAttribute('data-run-version')).toBe('1')
  } finally { await view.close() }
})

it('keeps a single completed action distinct from the actual ready cursor', async () => {
  const fixture = await ownerFixture('step')
  expect(fixture.run.status).toBe('ready')
  const view = await mount(<BrowserOperationStatus browserId={recording.browserId} taskAssets={fixture.state} activity={{ operation: fixture.operation, control: 'agent' }} />)
  try {
    expect(view.host.querySelector('.browser-operation-status')?.getAttribute('data-phase')).toBe('waiting')
    expect(view.host.querySelector('button')?.getAttribute('aria-label')).toContain('Task ready to continue · v1 · Next step 2')
    expect(fixture.operation.phase).toBe('completed')
  } finally { await view.close() }
})

it('never lets stale or foreign waiting cover a new actual activity, unknown control, Browser or version', async () => {
  const fixture = await ownerFixture()
  const newOperation = await fixture.journal.start({ browserId: recording.browserId, operator: { id: 'new-agent', name: 'New Navigator' }, summary: 'Inspect page', url: recording.url })
  const running = (await fixture.journal.setPhase(newOperation.id, 'running'))!
  const completed = (await fixture.journal.finish(newOperation.id, 'completed'))!
  const cases = [
    { name: 'new healthy activity', state: fixture.state, activity: { operation: running, control: 'agent' as const }, phase: 'running' },
    { name: 'new completed activity', state: fixture.state, activity: { operation: completed, control: 'human' as const }, phase: 'completed' },
    { name: 'unknown active control', state: fixture.state, activity: { operation: null, control: 'agent' as const }, phase: 'unknown' },
    { name: 'another Browser cursor', state: { ...fixture.state, runs: [{ ...fixture.run, browserId: 'another-browser' }] }, activity: { operation: fixture.operation, control: 'human' as const }, phase: 'completed' },
    { name: 'another asset cursor', state: { ...fixture.state, runs: [{ ...fixture.run, assetId: 'another-asset' }] }, activity: { operation: fixture.operation, control: 'human' as const }, phase: 'completed' },
    { name: 'unavailable cursor version', state: { ...fixture.state, runs: [{ ...fixture.run, version: 99 }] }, activity: { operation: fixture.operation, control: 'human' as const }, phase: 'completed' },
    { name: 'another Journal operation', state: { ...fixture.state, runs: [{ ...fixture.run, operationIds: ['unrelated-operation'] }] }, activity: { operation: fixture.operation, control: 'human' as const }, phase: 'completed' },
    { name: 'older unrelated Journal', state: fixture.state, activity: { operation: { ...fixture.operation, id: 'older-journal', startedAt: fixture.run.startedAt - 1 }, control: 'human' as const }, phase: 'completed' },
    { name: 'another Browser Journal', state: fixture.state, activity: { operation: { ...fixture.operation, browserId: 'another-browser' }, control: 'human' as const }, phase: 'completed' }
  ]
  expect(cases.map(item => item.name)).toHaveLength(9)
  for (const entry of cases) {
    const view = await mount(<BrowserOperationStatus browserId={recording.browserId} taskAssets={entry.state} activity={entry.activity} />)
    try {
      const status = view.host.querySelector('.browser-operation-status')!
      expect(status.getAttribute('data-phase'), entry.name).toBe(entry.phase)
      expect(status.hasAttribute('data-task-run-id'), entry.name).toBe(false)
      expect(view.host.querySelector('button')?.getAttribute('aria-label'), entry.name).not.toContain('Waiting for human checkpoint')
    } finally { await view.close() }
  }
})

it('shows a real first checkpoint with no observed action without adopting an unrelated later operation', async () => {
  const fixture = await ownerFixture(), asset = fixture.state.assets[0]!
  const edited = await fixture.owner.edit(asset.id, asset.revision, { ...asset.draft, name: 'Review before acting',
    steps: [asset.versions[0]!.steps[1]!, asset.versions[0]!.steps[0]!] })
  const saved = await fixture.owner.saveVersion(asset.id, edited.revision)
  const runScript = vi.fn()
  const onRunPrepared = vi.fn<BrowserTaskAssetHost['onRunPrepared']>()
  const first = await fixture.owner.run({ assetId: asset.id, browserId: recording.browserId, version: 3, parameters: {} }, {
    onRunPrepared, control: () => 'agent', yieldControl: vi.fn(), runScript
  })
  expect(onRunPrepared).toHaveBeenCalledExactlyOnceWith(first.id)
  expect(saved.versions.map(version => version.version)).toEqual([1, 2, 3])
  expect(first).toMatchObject({ status: 'waiting-human', operationIds: [], nextStep: 1 })
  expect(runScript).not.toHaveBeenCalled()
  const state = await fixture.owner.state(recording.browserId)
  expect(state.runs).toHaveLength(2)
  const view = await mount(<BrowserOperationStatus browserId={recording.browserId} taskAssets={state} activity={{ operation: fixture.operation, control: 'human' }} />)
  try {
    expect(view.host.querySelector('.browser-operation-status')?.getAttribute('data-task-run-id')).toBe(first.id)
    expect(view.host.querySelector('button')?.getAttribute('aria-label')).toContain('Review before acting · Waiting for human checkpoint · v3')
    await act(async () => view.root.render(<BrowserOperationStatus browserId={recording.browserId} taskAssets={state} activity={{ operation: { ...fixture.operation, id: 'later-independent', startedAt: first.startedAt + 1 }, control: 'human' }} />))
    expect(view.host.querySelector('.browser-operation-status')?.hasAttribute('data-task-run-id')).toBe(false)
  } finally { await view.close() }
})

it('uses invocation facts rather than array position and restores the original waiting version from Main', async () => {
  const fixture = await ownerFixture()
  const olderAsset = { ...fixture.state.assets[0]!, id: 'older-asset' }
  const older = { ...fixture.run, id: 'older-waiting', assetId: olderAsset.id, startedAt: fixture.run.startedAt - 1, updatedAt: fixture.run.updatedAt - 1 }
  const view = await mount(<BrowserOperationStatus browserId={recording.browserId} taskAssets={{ ...fixture.state, assets: [...fixture.state.assets, olderAsset], runs: [fixture.run, older] }} activity={{ operation: fixture.operation, control: 'human' }} />)
  try { expect(view.host.querySelector('.browser-operation-status')?.getAttribute('data-task-run-id')).toBe(fixture.run.id) }
  finally { await view.close() }
  const restored = await fixture.restore()
  expect(restored.runs).toEqual([fixture.run])
  const restart = await mount(<BrowserOperationStatus browserId={recording.browserId} taskAssets={restored} activity={{ operation: null, control: 'human' }} />)
  try {
    expect(restart.host.querySelector('.browser-operation-status')?.getAttribute('data-task-version')).toBe('1')
    expect(restart.host.querySelector('button')?.getAttribute('aria-label')).toContain('Waiting for human checkpoint')
  } finally { await restart.close() }
})

it('reviews and continues only the actual v1 cursor with fresh parameters while v2 editing remains separate', async () => {
  const fixture = await ownerFixture(), asset = fixture.state.assets[0]!
  const onRun = vi.fn<React.ComponentProps<typeof BrowserTaskAssetEditor>['onRun']>(async () => {}), onStop = vi.fn()
  const view = await mount(<BrowserTaskAssetEditor asset={asset} recording={recording} run={fixture.run}
    onImport={vi.fn()} onSaveDraft={vi.fn()} onSaveVersion={vi.fn()} onLocateStep={vi.fn()} onRun={onRun} onStop={onStop} />)
  try {
    const buttons = () => [...view.host.querySelectorAll<HTMLButtonElement>('button')]
    const review = buttons().find(button => button.textContent === 'Review and continue v1')!
    expect(review).not.toBeNull()
    await act(async () => review.click())
    expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Task asset version"]')?.value).toBe('1')
    expect(onRun).not.toHaveBeenCalled()
    const resume = buttons().find(button => button.textContent === 'Return control and continue')!
    expect(resume.disabled).toBe(true)
    const parameter = view.host.querySelector<HTMLInputElement>('[aria-label="Task parameter Name"]')!
    expect(parameter.type).toBe('password')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(parameter, 'fresh-invocation-only')
      parameter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(resume.disabled).toBe(false)
    await act(async () => resume.click())
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun.mock.calls[0]![0]).toEqual({ version: 1, mode: 'run', runId: fixture.run.id, parameters: { name: 'fresh-invocation-only' } })
    expect(onRun.mock.calls[0]![1].nativeEvent.isTrusted).not.toBe(true)
    expect(parameter.value).toBe('')
    await act(async () => buttons().find(button => button.textContent === 'Stop task')!.click())
    expect(onStop.mock.calls[0]![0]).toBe(fixture.run.id)
  } finally { await view.close() }
})

it.each(['completed', 'rejected'] as const)('clears an invocation secret after %s, including when the same Editor reveals the key through a saved draft revision', async outcome => {
  const fixture = await ownerFixture()
  let asset = await fixture.owner.edit(fixture.state.assets[0]!.id, fixture.state.assets[0]!.revision, {
    ...fixture.state.assets[0]!.draft,
    steps: fixture.state.assets[0]!.draft.steps.slice(1),
    parameters: [{ key: 'name', label: 'Name', secret: false }]
  })
  let currentRun = fixture.run
  const immutableVersions = structuredClone(asset.versions)
  const secret = 'fresh-invocation-finally-only'
  const scriptCalls: string[] = []
  let view: Awaited<ReturnType<typeof mount>>
  const onRun = vi.fn<React.ComponentProps<typeof BrowserTaskAssetEditor>['onRun']>(async input => {
    if (outcome === 'rejected') throw new Error('Continuation failed; inspect the retained page')
    currentRun = await fixture.owner.run({ ...input, assetId: asset.id, browserId: recording.browserId }, {
      onRunPrepared: runId => expect(runId).toBe(fixture.run.id), control: () => 'agent',
      yieldControl: () => { throw new Error('The already reviewed checkpoint must not repeat') },
      runScript: async (browserId, script) => {
        scriptCalls.push(script)
        expect(script).toContain(secret)
        const operation = await fixture.journal.start({ browserId, operator: { id: 'person', name: 'Person' }, summary: 'Fill reviewed input', url: recording.url })
        const step = await fixture.journal.startStep(operation.id, { method: 'fillInput', label: 'Fill reviewed input', target: asset.versions[0]!.steps[2]!.target! })
        await fixture.journal.finishStep(operation.id, step!.sequence, { status: 'completed' })
        const completed = await fixture.journal.finish(operation.id, 'completed')
        return { result: undefined, logs: [], outcome: { kind: 'completed' }, runOperation: completed! }
      }
    })
    view.root.render(render())
  })
  const saveVersion = vi.fn<React.ComponentProps<typeof BrowserTaskAssetEditor>['onSaveVersion']>(async content => {
    const edited = await fixture.owner.edit(asset.id, asset.revision, content)
    asset = await fixture.owner.saveVersion(edited.id, edited.revision)
    view.root.render(render())
  })
  const render = () => <BrowserTaskAssetEditor asset={asset} recording={recording} run={currentRun}
    onImport={vi.fn()} onSaveDraft={vi.fn()} onSaveVersion={saveVersion} onLocateStep={vi.fn()} onRun={onRun} onStop={vi.fn()} />
  view = await mount(render())
  try {
    const surface = view.host.querySelector('[aria-label="Editable Browser task asset"]')!
    expect(surface).not.toBeNull()
    const buttons = () => [...view.host.querySelectorAll<HTMLButtonElement>('button')]
    await act(async () => buttons().find(button => button.textContent === 'Review and continue v1')!.click())
    const parameter = view.host.querySelector<HTMLInputElement>('[aria-label="Task parameter Name"]')!
    expect(parameter).not.toBeNull()
    expect(parameter.type).toBe('password')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(parameter, secret)
      parameter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttons().find(button => button.textContent === 'Return control and continue')!.click())
    expect(onRun.mock.calls.map(([input]) => input)).toEqual([{ version: 1, mode: 'run', runId: fixture.run.id, parameters: { name: secret } }])
    if (outcome === 'completed') {
      expect(currentRun.status).toBe('completed')
      expect(currentRun.nextStep).toBe(3)
      expect(currentRun.operationIds).toHaveLength(2)
      expect(currentRun.operationIds[0]).toBe(fixture.run.operationIds[0])
      expect(view.host.querySelector('[aria-label="Task parameter Name"]')).toBeNull()
    } else {
      expect(currentRun).toEqual(fixture.run)
      expect(parameter.value).toBe('')
      expect(surface.textContent).toContain('Continuation failed; inspect the retained page')
    }
    const retainedRun = structuredClone(currentRun)
    // Saving a local draft revision keeps this mounted Editor and does not invoke
    // the version-selector/review handlers that would independently reset values.
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="Delete task step 1"]')!.click())
    await act(async () => buttons().find(button => button.textContent === 'Save version')!.click())
    expect(saveVersion).toHaveBeenCalledTimes(1)
    expect(asset.versions).toHaveLength(3)
    expect(asset.versions.slice(0, 2)).toEqual(immutableVersions)
    expect(asset.versions[2]!.steps.map(step => step.kind)).toEqual(['fill'])
    expect(view.host.querySelector('[aria-label="Editable Browser task asset"]')).toBe(surface)
    expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Task asset version"]')?.value).toBe('3')
    const revealed = view.host.querySelector<HTMLInputElement>('[aria-label="Task parameter Name"]')!
    expect(revealed).not.toBeNull()
    expect(revealed.type).toBe('text')
    expect(revealed.value).toBe('')
    expect(buttons().find(button => button.textContent === 'Run version')?.disabled).toBe(true)
    expect(buttons().find(button => button.textContent === 'Run next step')?.disabled).toBe(true)
    expect((await fixture.owner.state(recording.browserId)).runs).toEqual([retainedRun])
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(scriptCalls).toHaveLength(outcome === 'completed' ? 1 : 0)
    expect(JSON.stringify(await fixture.restore())).not.toContain(secret)
    expect(JSON.stringify(await fixture.journal.list())).not.toContain(secret)
  } finally { await view.close() }
})

it('retains unknown-version, storage and save failures outside folded source details, with Stop available while busy', async () => {
  const fixture = await ownerFixture(), asset = fixture.state.assets[0]!
  const missing: BrowserTaskAssetRun = { ...fixture.run, version: 99, warning: 'Unknown execution result; inspect the page' }
  const onStop = vi.fn(), save = vi.fn(async () => { throw new Error('Draft save failed; local edits remain') })
  const renderEditor = (busy: boolean) => <BrowserTaskAssetEditor asset={asset} recording={recording} run={missing} warning="Storage unavailable; live work retained" busy={busy}
    onImport={vi.fn()} onSaveDraft={save} onSaveVersion={vi.fn()} onLocateStep={vi.fn()} onRun={vi.fn()} onStop={onStop} />
  const view = await mount(renderEditor(false))
  try {
    const saveButton = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save draft')!
    await act(async () => saveButton.click())
    expect(view.host.textContent).toContain('Storage unavailable')
    expect(view.host.textContent).toContain('Draft save failed')
    expect(view.host.textContent).toContain('Unknown execution result')
    expect(view.host.textContent).toContain('running version is unavailable')
    await act(async () => view.root.render(renderEditor(true)))
    const stop = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Stop task')!
    expect(stop.disabled).toBe(false)
    await act(async () => stop.click())
    expect(onStop.mock.calls[0]![0]).toBe(fixture.run.id)
  } finally { await view.close() }
  const source = await mount(<BrowserDemonstrationSurface draft={{ ...recording, status: 'recording' }} collapseSteps warning="Recording warning retained" onStart={vi.fn()} onStop={vi.fn()} />)
  try {
    expect(source.host.querySelector<HTMLDetailsElement>('details')?.open).toBe(true)
    expect(source.host.querySelectorAll('[data-sequence]')).toHaveLength(5)
    expect(source.host.textContent).toContain('Recording warning retained')
    expect(source.host.querySelector('[aria-label="Stop recording demonstration"]')).not.toBeNull()
  } finally { await source.close() }
})
