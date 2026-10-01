// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserDemonstrationRecorder } from '../src/main/browser-demonstration-recorder'
import { BrowserDemonstrationInterpreter } from '../src/main/browser-demonstration-interpretation'
import { interpretBrowserDemonstrationStep } from '../src/shared/browser-demonstration-semantics'
import type { BrowserDemonstrationInterpretation } from '../src/shared/browser-demonstration-semantics'
import type { BrowserDemonstrationDocument, BrowserDemonstrationDraft, BrowserDemonstrationStep } from '../src/shared/browser-demonstration'
import { BrowserTaskAssets } from '../src/main/browser-task-assets'
import type { BrowserTaskAssetDocument } from '../src/shared/browser-task-assets'
import { BrowserDemonstrationSurface } from '../src/renderer/src/components/BrowserDemonstrationSurface'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const settle = async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function recorded() {
  let document: BrowserDemonstrationDocument | null = null, next = 0
  const store = { load: async () => structuredClone(document), save: async (value: BrowserDemonstrationDocument) => { document = structuredClone(value) } }
  const recorder = new BrowserDemonstrationRecorder(store, { id: () => `fact-${++next}`, now: () => 100 })
  await recorder.start({ browserId: 'browser', navigationId: 'navigation', url: 'https://example.test/form' })
  recorder.noteNativeInput({ browserId: 'browser', navigationId: 'navigation', type: 'char' })
  const draft = (await recorder.recordBrowserDemonstration({ browserId: 'browser', navigationId: 'navigation', isTrusted: true, kind: 'fill',
    target: { role: 'textbox', name: 'Display name', ordinal: 1, count: 1 } }))!
  return { recorder, draft, store }
}
async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(element))
  return { container, root, dispose: async () => { await act(async () => root.unmount()); container.remove() } }
}
function edit(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('recorded-target suggestions at the real asynchronous boundary', () => {
  it('consumes actual Recorder facts first and then publishes an honest rule suggestion without a recorded value', async () => {
    const { draft } = await recorded(), publish = vi.fn(), projector = new BrowserDemonstrationInterpreter(publish)
    expect(projector.update(draft).map(step => step.status)).toEqual(['interpreting'])
    await settle()
    expect(projector.state()).toEqual([{ stepId: draft.steps[0]!.id, factRevision: expect.any(String), status: 'available', source: 'recorded-target-rule',
      title: 'Enter Display name', parameter: { key: 'input-1', label: 'Display name', secret: true } }])
    expect(projector.getWork()).toEqual({ requested: 1, applied: 1, discarded: 0 }); expect(publish).toHaveBeenCalledTimes(1)
  })
  it('merges two real asynchronous facts out of order without invalidating the first on an unrelated draft revision', async () => {
    const { draft, recorder } = await recorded(), gates = new Map<string, ReturnType<typeof deferred<BrowserDemonstrationInterpretation>>>()
    const projector = new BrowserDemonstrationInterpreter(() => {}, step => {
      const gate = deferred<BrowserDemonstrationInterpretation>(); gates.set(step.id, gate); return gate.promise
    })
    projector.update(draft); await settle()
    recorder.noteNativeInput({ browserId: 'browser', navigationId: 'navigation', type: 'mouseUp' })
    const second = (await recorder.recordBrowserDemonstration({ browserId: 'browser', navigationId: 'navigation', isTrusted: true, kind: 'click',
      target: { role: 'button', name: 'Continue', ordinal: 1, count: 1 } }))!
    projector.update(second); await settle()
    expect(gates.size).toBe(2)
    gates.get(second.steps[1]!.id)!.resolve(await interpretBrowserDemonstrationStep(second.steps[1]!)); await settle()
    gates.get(second.steps[0]!.id)!.resolve(await interpretBrowserDemonstrationStep(second.steps[0]!)); await settle()
    expect(projector.state().map(step => [step.stepId, step.status, step.title])).toEqual([
      [second.steps[0]!.id, 'available', 'Enter Display name'], [second.steps[1]!.id, 'available', 'Click Continue']])
    projector.update({ ...second, revision: second.revision + 1 })
    expect(projector.getWork()).toEqual({ requested: 2, applied: 2, discarded: 0 })
  })
  it('rejects an older changed-step explanation by actual fact digest while keeping the new pending fact', async () => {
    const { draft } = await recorded(), gates: ReturnType<typeof deferred<BrowserDemonstrationInterpretation>>[] = []
    const projector = new BrowserDemonstrationInterpreter(() => {}, () => { const gate = deferred<BrowserDemonstrationInterpretation>(); gates.push(gate); return gate.promise })
    projector.update(draft); await settle()
    const changed = { ...draft, steps: draft.steps.map(step => ({ ...step, target: { ...step.target!, name: 'Changed observed target' } })) }
    projector.update(changed); await settle()
    expect(gates).toHaveLength(2)
    gates[0]!.resolve(await interpretBrowserDemonstrationStep(draft.steps[0]!)); await settle()
    expect(projector.state()[0]!.status).toBe('interpreting')
    gates[1]!.resolve(await interpretBrowserDemonstrationStep(changed.steps[0]!)); await settle()
    expect(projector.state()[0]!.title).toBe('Enter Changed observed target')
  })
  it('cancels preparation on actual stop and preserves completed suggestions without reopening work', async () => {
    const { draft, recorder } = await recorded(), gate = deferred<BrowserDemonstrationInterpretation>()
    const projector = new BrowserDemonstrationInterpreter(() => {}, () => gate.promise)
    projector.update(draft); await settle()
    projector.update(await recorder.stop('browser'))
    expect(projector.state()[0]!.status).toBe('unknown')
    gate.resolve(await interpretBrowserDemonstrationStep(draft.steps[0]!)); await settle()
    expect(projector.state()[0]!.status).toBe('unknown')
    const completed = new BrowserDemonstrationInterpreter(() => {})
    completed.update(draft); await settle(); completed.update({ ...draft, status: 'stopped' })
    expect(completed.state()[0]!.status).toBe('available')
    expect(completed.getWork().requested).toBe(1)
  })
  it('never mixes old navigation, new recording or a deleted step with late preparation', async () => {
    const { draft } = await recorded()
    const changes: BrowserDemonstrationDraft[] = [{ ...draft, navigationId: 'new-navigation' }, { ...draft, id: 'new-recording', steps: [] }, { ...draft, steps: [] }]
    expect(changes).toHaveLength(3)
    for (const changed of changes) {
      const gate = deferred<BrowserDemonstrationInterpretation>(), projector = new BrowserDemonstrationInterpreter(() => {}, () => gate.promise)
      projector.update(draft); await settle(); projector.update(changed)
      gate.resolve(await interpretBrowserDemonstrationStep(draft.steps[0]!)); await settle()
      expect(projector.state().filter(step => step.status === 'available')).toEqual([])
    }
  })
  it('drops raw args before the asynchronous interpreter and never classifies a private target as public', async () => {
    const { draft } = await recorded(), inputs: BrowserDemonstrationStep[] = []
    const raw = { ...draft, steps: draft.steps.map(step => ({ ...step, args: ['private-input-value'] })) }
    const projector = new BrowserDemonstrationInterpreter(() => {}, async step => { inputs.push(step); return interpretBrowserDemonstrationStep(step) })
    projector.update(raw); await settle()
    expect(inputs).toHaveLength(1); expect(inputs[0]!.args).toEqual([])
    expect(JSON.stringify(projector.state())).not.toContain('private-input-value')
    expect((await interpretBrowserDemonstrationStep({ ...draft.steps[0]!, target: { ...draft.steps[0]!.target!, role: 'password input' } })).status).toBe('unknown')
    expect(projector.state()[0]!.parameter?.secret).toBe(true)
  })
  it('keeps empty and ambiguous facts unknown, with zero irrelevant explanation work', async () => {
    const { draft } = await recorded(), projector = new BrowserDemonstrationInterpreter(() => {})
    expect(projector.update({ ...draft, steps: [] })).toEqual([]); expect(projector.getWork().requested).toBe(0)
    const { target: _target, ...withoutTarget } = draft.steps[0]!
    expect((await interpretBrowserDemonstrationStep(withoutTarget)).status).toBe('unknown')
    expect((await interpretBrowserDemonstrationStep({ ...draft.steps[0]!, target: { ...draft.steps[0]!.target!, count: 2 } })).status).toBe('unknown')
  })
  it('shows bounded preparation and publication failures without throwing or changing original actions', async () => {
    const { draft } = await recorded(), before = JSON.stringify(draft)
    const failed = new BrowserDemonstrationInterpreter(() => {}, async () => { throw new Error('private raw failure') })
    failed.update(draft); await settle(); expect(failed.state()[0]!.status).toBe('failed')
    expect(JSON.stringify(failed.state())).not.toContain('private raw failure')
    const publication = new BrowserDemonstrationInterpreter(() => { throw new Error('Listener unavailable') })
    publication.update(draft); await settle(); expect(publication.state()[0]!.reason).toContain('could not be published')
    expect(JSON.stringify(draft)).toBe(before)
  })
  it('reads the same durable draft after another Recorder owner and only derives suggestions, never page actions', async () => {
    const { recorder, store, draft } = await recorded(); await recorder.stop('browser')
    const restored = await new BrowserDemonstrationRecorder(store).get('browser')
    expect(restored?.steps).toEqual(draft.steps)
    const projector = new BrowserDemonstrationInterpreter(() => {}); projector.update(restored); await settle()
    expect(projector.state()[0]!.title).toBe('Enter Display name'); expect(restored?.status).toBe('stopped')
  })
})

describe('live suggestions and explicit person-owned asset correction', () => {
  it('previews the matching suggestion before explicit use without altering the edited title or secret parameter', async () => {
    const { draft, recorder } = await recorded(); await recorder.stop('browser')
    const owner = new BrowserTaskAssets({ load: async () => null, save: async () => {} })
    const asset = await owner.importRecording((await recorder.get('browser'))!)
    asset.draft.steps[0]!.label = 'Person-owned title'
    const projector = new BrowserDemonstrationInterpreter(() => {}); projector.update(draft); await settle()
    const props = { asset, recording: draft, suggestions: projector.state(), onImport: () => {}, onSaveDraft: async () => {}, onSaveVersion: async () => {},
      onLocateStep: () => {}, onRun: async () => {}, onStop: () => {} }
    const mounted = await mount(createElement(BrowserTaskAssetEditor, props))
    expect(mounted.container.querySelector('.browser-demonstration-suggestion')?.textContent).toContain('Enter Display name')
    expect(mounted.container.querySelector('.browser-demonstration-suggestion')?.textContent).toContain('Recorded target')
    expect(mounted.container.querySelector('.browser-demonstration-suggestion')?.textContent).toContain('Value not recorded')
    expect(mounted.container.querySelector<HTMLInputElement>('input[aria-label="Task step 1 title"]')!.value).toBe('Person-owned title')
    expect(asset.draft.parameters).toEqual([{ key: 'input-1', label: 'input-1', secret: true }])
    await act(async () => mounted.root.render(createElement(BrowserTaskAssetEditor, { ...props, recording: { ...draft, id: 'another-recording' } })))
    expect(mounted.container.querySelector('.browser-demonstration-suggestion')).toBeNull()
    expect(mounted.container.textContent).not.toContain('Use suggestion')
    await mounted.dispose()
  })
  it('renders recorded facts and honest suggestion provenance in the original demonstration surface', async () => {
    const { draft } = await recorded(), projector = new BrowserDemonstrationInterpreter(() => {}); projector.update(draft); await settle()
    const mounted = await mount(createElement(BrowserDemonstrationSurface, { draft, suggestions: projector.state(), onStart: () => {}, onStop: () => {} }))
    expect(mounted.container.textContent).toContain('Enter Display name'); expect(mounted.container.textContent).toContain('Recorded target')
    expect(mounted.container.textContent).toContain('value not recorded'); await mounted.dispose()
  })
  it('retains an edited title and deleted step when the real asynchronous explanation arrives late', async () => {
    const { draft, recorder } = await recorded(); await recorder.stop('browser')
    let document: BrowserTaskAssetDocument | null = null
    const owner = new BrowserTaskAssets({ load: async () => structuredClone(document), save: async value => { document = structuredClone(value) } })
    const asset = await owner.importRecording((await recorder.get('browser'))!), gate = deferred<BrowserDemonstrationInterpretation>()
    let suggestions = new BrowserDemonstrationInterpreter(() => {}).state()
    const projector = new BrowserDemonstrationInterpreter(next => { suggestions = next }, () => gate.promise)
    projector.update(draft); await settle()
    const props = { asset, recording: draft, onImport: () => {}, onSaveDraft: async () => {}, onSaveVersion: async () => {}, onLocateStep: () => {}, onRun: async () => {}, onStop: () => {} }
    const mounted = await mount(createElement(BrowserTaskAssetEditor, { ...props, suggestions }))
    await act(async () => { edit(mounted.container.querySelector('input[aria-label="Task step 1 title"]')!, 'Person title') })
    gate.resolve(await interpretBrowserDemonstrationStep(draft.steps[0]!)); await settle()
    await act(async () => { mounted.root.render(createElement(BrowserTaskAssetEditor, { ...props, suggestions })) })
    expect(mounted.container.querySelector<HTMLInputElement>('input[aria-label="Task step 1 title"]')?.value).toBe('Person title')
    const remove = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Delete task step 1"]')!
    await act(async () => remove.click())
    await act(async () => { mounted.root.render(createElement(BrowserTaskAssetEditor, { ...props, suggestions: [...suggestions] })) })
    expect(mounted.container.querySelector('[data-task-step-id]')).toBeNull(); expect(mounted.container.textContent).toContain('deleted steps stay deleted')
    await mounted.dispose()
  })
  it('saves explicit Use suggestion through the actual original asset Owner while keeping secret defaults', async () => {
    const { draft, recorder } = await recorded(); await recorder.stop('browser')
    let document: BrowserTaskAssetDocument | null = null
    const owner = new BrowserTaskAssets({ load: async () => structuredClone(document), save: async value => { document = structuredClone(value) } })
    let asset = await owner.importRecording((await recorder.get('browser'))!)
    const projector = new BrowserDemonstrationInterpreter(() => {}); projector.update(draft); await settle()
    const mounted = await mount(createElement(BrowserTaskAssetEditor, { asset, recording: draft, suggestions: projector.state(), onImport: () => {},
      onSaveDraft: async next => { asset = await owner.edit(asset.id, asset.revision, next) }, onSaveVersion: async () => {}, onLocateStep: () => {}, onRun: async () => {}, onStop: () => {} }))
    const use = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use suggestion')!
    await act(async () => use.click())
    expect(mounted.container.querySelector<HTMLInputElement>('input[aria-label="Task step 1 title"]')?.value).toBe('Enter Display name')
    const save = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save draft')!
    await act(async () => save.click())
    expect((await owner.get(asset.id))?.draft.steps[0]!.label).toBe('Enter Display name')
    expect((await owner.get(asset.id))?.draft.parameters).toEqual([{ key: 'input-1', label: 'Display name', secret: true }])
    expect(JSON.stringify(document)).not.toContain('private-input-value'); await mounted.dispose()
  })
})
