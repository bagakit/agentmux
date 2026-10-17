const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createAgentInputContextCaptureRecord } from '@agentmux/core/agent-input-context-capture'
import { useBrowserContextualComposer } from '../src/renderer/src/components/BrowserContextualComposer'
import type { BrowserInputFrameResult, BrowserInputScene, BrowserInputSelectionReceipt } from '../src/shared/browser-input-context-capture'
import type { BrowserOperation } from '../src/shared/browser-operation'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const operation: BrowserOperation = { id: 'live-operation', browserId: 'opinion-browser', operator: { id: 'agent-1', name: 'Original Agent' },
  phase: 'running', summary: 'Working', startedAt: _batchFixtureEpoch(0, 0, 1), url: 'https://example.invalid/live', steps: [] }
const scene: BrowserInputScene = { reference: { hostId: 'local', captureId: 'text-scene' }, diskDurability: 'confirmed',
  inputContext: { kind: 'browser', version: 1, capturedAt: _batchFixtureEpoch(0, 0, 1), browser: { hostId: 'local', browserId: operation.browserId, navigationId: 'text-navigation' },
    page: { url: 'https://example.invalid/original', title: 'Original page' }, activity: { operationId: 'text-operation', stepSequence: 2, phase: 'running', observedAt: _batchFixtureEpoch(0, 0, 1) } } }
const selection = { kind: 'region' as const, capturedAt: _batchFixtureEpoch(0, 0, 3), frameId: 'original-frame',
  source: { hostId: 'local', browserId: operation.browserId, navigationId: 'frame-navigation', operationId: 'frame-operation', stepSequence: 7, association: 'observed-during' as const },
  attachment: { hostId: 'local', path: 'original-processed.png', mimeType: 'image/png' as const, width: 40, height: 30, sha256: 'a'.repeat(64) },
  region: { x: 10, y: 20, width: 40, height: 30, space: 'capture-pixels' as const } }
const receipt: BrowserInputSelectionReceipt = { operationId: 'original-selection',
  scene: { ...scene, reference: { hostId: 'local', captureId: 'selection-scene' }, inputContext: { ...scene.inputContext, selection } },
  artifact: { path: selection.attachment.path, sha256: selection.attachment.sha256, width: 40, height: 30, byteLength: 100, diskDurability: 'confirmed' } }
function Harness({ visible = true }: { visible?: boolean }) {
  const opinion = useBrowserContextualComposer(operation.browserId, operation, visible, 'later-navigation')
  return <><button ref={opinion.buttonRef} onClick={event => opinion.open(event.currentTarget)}>Discuss</button>{opinion.dialog}</>
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  expect(button, label).toBeDefined(); await act(async () => button!.click())
}
async function type(value: string) {
  await act(async () => { const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Opinion for Browser operator"]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function restored(attached = false) {
  useAppStore.setState({ browserOpinionDrafts: { [operation.browserId]: { original: { control: composerSession().control, name: 'Original Agent', browserId: operation.browserId,
    operationId: operation.id, scene: structuredClone(scene), comment: { operationId: 'historical-operation', sequence: 1 },
    ...(attached ? { selection: structuredClone(receipt) } : { selectionPreparation: { operationId: receipt.operationId, frame: { hostId: 'local', captureId: 'original-frame' } } }) },
    text: 'About the original image', includeContext: true, pending: null } } })
}
beforeEach(() => {
  useAppStore.setState({ sessions: [{ ...composerSession(), status: { state: 'working', source: 'native-hook', observedAt: _batchFixtureEpoch(0, 0, 1) } }], browserOpinionDrafts: {} })
  vi.spyOn(api.browser, 'captureInputContext').mockResolvedValue(structuredClone(scene))
  vi.spyOn(api.browser, 'readInputSelection').mockResolvedValue({ operationId: receipt.operationId, state: 'prepared', receipt: structuredClone(receipt) })
  vi.spyOn(api.browser, 'readSelectionImage').mockResolvedValue(null)
  vi.spyOn(api.browser, 'captureInputFrame').mockRejectedValue(new Error('Original frame unavailable'))
  vi.spyOn(api.browser, 'freezeInputContext').mockImplementation(async input => {
    const context = input.scene.captureId === receipt.scene.reference.captureId ? receipt.scene.inputContext : scene.inputContext
    const record = createAgentInputContextCaptureRecord({ reference: { hostId: 'local', operationId: input.operationId },
      binding: { executionHostId: input.control.hostId, agentSessionId: input.control.agentSessionId, originRun: input.control.run }, prompt: input.prompt,
      ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }), inputContext: context })
    return { reference: record.reference, record, diskDurability: 'confirmed' }
  })
})

it('explicitly reads the original prepared image and freezes its derived scene through the real opinion queue', async () => {
  restored(); await dom.render(<Harness />); await click('Discuss')
  expect(api.browser.readInputSelection).not.toHaveBeenCalled()
  await click('Check original image')
  expect(api.browser.readInputSelection).toHaveBeenCalledExactlyOnceWith(receipt.operationId)
  expect(document.querySelector('.browser-opinion-selection')?.textContent).toContain('Captured at step 7')
  expect(document.querySelector('.browser-contextual-composer__source')?.textContent).toContain('Comment on step 1')
  await click('Queue opinion')
  expect(vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0].scene).toEqual(receipt.scene.reference)
  const entry = useAppStore.getState().agentSteerQueues['agent-1']![0]!
  expect(entry.browserInput?.capture.record.inputContext.selection).toEqual(selection)
  expect(entry.browserInput?.capture.record.inputContext.activity?.stepSequence).toBe(2)
  expect(entry.origin).toBe('manual'); expect(entry.browserRecipient?.run.runId).toBe('run-agent-1')
  expect(useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!.scene!.reference).toEqual(scene.reference)
  expect(api.browser.captureInputFrame).not.toHaveBeenCalled(); expect(api.browser.captureInputContext).not.toHaveBeenCalled()
})

it('removes an optional image by returning to the retained text scene, without recapture or deleting its resource', async () => {
  restored(true); await dom.render(<Harness />); await click('Discuss'); await click('Remove image'); await click('Queue opinion')
  expect(vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0].scene).toEqual(scene.reference)
  expect(useAppStore.getState().agentSteerQueues['agent-1']![0]!.browserInput?.capture.record.inputContext.selection).toBeUndefined()
  expect(api.browser.captureInputFrame).not.toHaveBeenCalled(); expect(api.browser.captureInputContext).not.toHaveBeenCalled()
})

it('explicit text-only sending excludes a retained processed image and its context', async () => {
  restored(true); await dom.render(<Harness />); await click('Discuss')
  await act(async () => document.querySelector<HTMLInputElement>('.browser-contextual-composer__source input')!.click())
  expect(document.querySelector('.browser-contextual-composer')?.textContent).toContain('Text-only sending excludes it')
  await click('Queue text only')
  expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues['agent-1']![0]!.browserInput).toBeUndefined()
})

it.each(['close', 'hide'])('does not attach a late original query after %s', async mode => {
  let resolve!: (value: Awaited<ReturnType<typeof api.browser.readInputSelection>>) => void
  vi.mocked(api.browser.readInputSelection).mockImplementation(() => new Promise(yes => { resolve = yes }))
  restored(); await dom.render(<Harness />); await click('Discuss'); await click('Check original image')
  if (mode === 'close') await click('Close discussion')
  else await dom.render(<Harness visible={false} />)
  await act(async () => resolve({ operationId: receipt.operationId, state: 'prepared', receipt }))
  expect(useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!.selection).toBeUndefined()
  expect(document.querySelector('.browser-opinion-selection__editor')).toBeNull()
  if (mode === 'close') await click('Discuss')
  else await dom.render(<Harness />)
  await click('Queue opinion')
  expect(vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0].scene).toEqual(scene.reference)
})

it('keeps the text route after capture failure or an unconfirmed original selection without reading a new page', async () => {
  restored(); await dom.render(<Harness />); await click('Discuss'); await click('Mark captured image…')
  expect(document.querySelector('.browser-opinion-selection')?.textContent).toContain('Original frame unavailable')
  vi.mocked(api.browser.readInputSelection).mockResolvedValue({ operationId: receipt.operationId, state: 'unconfirmed' })
  await click('Check original image'); await click('Queue opinion')
  expect(vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0].scene).toEqual(scene.reference)
  expect(api.browser.captureInputFrame).toHaveBeenCalledTimes(1)
})

it('keeps the same selected scene and input identity across an unknown freeze and restored draft', async () => {
  restored(true); const freeze = vi.mocked(api.browser.freezeInputContext).mockRejectedValueOnce(new Error('Original freeze reply unknown'))
  await dom.render(<Harness />); await click('Discuss'); await click('Queue opinion')
  const first = freeze.mock.calls[0]![0]
  const remove = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Remove image')!
  expect(remove.disabled).toBe(true)
  const saved = JSON.parse(JSON.stringify(useAppStore.getState().browserOpinionDrafts))
  await dom.render(<div />); await act(async () => useAppStore.setState({ browserOpinionDrafts: saved }))
  await dom.render(<Harness />); await click('Discuss'); await click('Queue opinion')
  expect(freeze.mock.calls[1]![0]).toEqual(first); expect(first.scene).toEqual(receipt.scene.reference)
  expect(api.browser.readInputSelection).not.toHaveBeenCalled()
})

it('ignores a late frame after hiding and never treats opening a frame as image attachment', async () => {
  let resolve!: (value: BrowserInputFrameResult) => void
  vi.mocked(api.browser.captureInputFrame).mockImplementation(() => new Promise(yes => { resolve = yes }))
  await dom.render(<Harness />); await click('Discuss'); await type('Only my words'); await click('Mark captured image…')
  await dom.render(<Harness visible={false} />)
  await act(async () => resolve({ scene: { ...scene, reference: { hostId: 'local', captureId: 'late-frame' } }, capture: {
    browserId: operation.browserId, navigationId: 'frame-navigation', image: { mimeType: 'image/png', dataUrl: '', width: 40, height: 30, byteLength: 0 },
    source: { url: operation.url, title: 'Late frame', viewport: null, viewportWarning: null } } }))
  await dom.render(<Harness />)
  expect(document.querySelector('.browser-opinion-selection__editor')).toBeNull()
  expect(useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!.selection).toBeUndefined()
  await click('Queue opinion'); expect(vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0].scene).toEqual(scene.reference)
})

it.each(['missing-scene', 'foreign-text', 'artifact-mismatch'])('keeps a malformed saved image explicit until removal (%s)', async kind => {
  restored(true)
  const original = useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!
  if (kind === 'missing-scene') delete (original.selection as Partial<BrowserInputSelectionReceipt>).scene
  else if (kind === 'foreign-text') original.selection!.scene.inputContext.page.url = 'https://example.invalid/another-observation'
  else original.selection!.artifact.sha256 = 'b'.repeat(64)
  await dom.render(<Harness />); await click('Discuss'); await click('Queue opinion')
  expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBeUndefined()
  expect(document.querySelector('.browser-opinion-selection')?.textContent).toContain('Saved image details cannot be confirmed')
  expect(useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!.selection).toBeDefined()
  await click('Remove image'); await click('Queue opinion')
  expect(vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0].scene).toEqual(scene.reference)
})

it('allows explicit text-only sending while retaining a damaged image reference for inspection', async () => {
  restored(true)
  const original = useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!
  delete (original.selection as Partial<BrowserInputSelectionReceipt>).scene
  await dom.render(<Harness />); await click('Discuss')
  await act(async () => document.querySelector<HTMLInputElement>('.browser-contextual-composer__source input')!.click())
  await click('Queue text only')
  expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues['agent-1']![0]!.browserInput).toBeUndefined()
  expect(useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!.selection).toBeDefined()
})

it('refuses an original selection query that belongs to a different text observation', async () => {
  restored()
  const foreign = structuredClone(receipt); foreign.scene.inputContext.capturedAt++
  vi.mocked(api.browser.readInputSelection).mockResolvedValue({ operationId: receipt.operationId, state: 'prepared', receipt: foreign })
  await dom.render(<Harness />); await click('Discuss'); await click('Check original image')
  expect(useAppStore.getState().browserOpinionDrafts[operation.browserId]!.original!.selection).toBeUndefined()
  expect(document.querySelector('.browser-opinion-selection')?.textContent).toContain('Saved image details cannot be confirmed')
  expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
})
