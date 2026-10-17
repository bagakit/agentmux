const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createAgentInputContextCaptureRecord } from '@agentmux/core/agent-input-context-capture'
import { useBrowserContextualComposer } from '../src/renderer/src/components/BrowserContextualComposer'
import type { BrowserOperation } from '../src/shared/browser-operation'
import type { BrowserInputScene } from '../src/shared/browser-input-context-capture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const operation: BrowserOperation = { id: 'operation-original', browserId: 'browser-original', operator: { id: 'agent-1', name: 'Original Agent' },
  phase: 'running', summary: 'Working', startedAt: _batchFixtureEpoch(0, 0, 1), url: 'https://example.invalid/original', steps: [] }
const scene: BrowserInputScene = { reference: { hostId: 'local', captureId: 'original-scene' }, diskDurability: 'confirmed',
  inputContext: { kind: 'browser', version: 1, capturedAt: _batchFixtureEpoch(0, 0, 1), browser: { hostId: 'local', browserId: 'browser-original', navigationId: 'navigation-original' },
    page: { url: operation.url, title: 'Original page' }, activity: { operationId: operation.id, stepSequence: 2, phase: 'running', observedAt: _batchFixtureEpoch(0, 0, 1) } } }
function Harness({ current = operation, visible = true, comment }: { current?: BrowserOperation; visible?: boolean; comment?: { operationId: string; sequence: number } }) {
  const opinion = useBrowserContextualComposer('browser-original', current, visible)
  return <><button ref={opinion.buttonRef} onClick={event => opinion.open(event.currentTarget, comment)}>Discuss</button>{opinion.dialog}</>
}
const editor = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Opinion for Browser operator"]')!
async function type(value: string) {
  await act(async () => {
    const input = editor(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function button(label: string) {
  const target = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  expect(target, label).toBeDefined(); await act(async () => target!.click())
}
beforeEach(() => {
  const session = composerSession(); session.status = { state: 'working', source: 'native-hook', observedAt: _batchFixtureEpoch(0, 0, 1) }
  useAppStore.setState({ sessions: [session] })
  vi.spyOn(api.browser, 'captureInputContext').mockResolvedValue(structuredClone(scene))
  vi.spyOn(api.browser, 'freezeInputContext').mockImplementation(async input => {
    const record = createAgentInputContextCaptureRecord({ reference: { hostId: 'local', operationId: input.operationId },
      binding: { executionHostId: input.control.hostId, agentSessionId: input.control.agentSessionId, originRun: input.control.run },
      prompt: input.prompt, ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }), inputContext: scene.inputContext })
    return { reference: record.reference, record, diskDurability: 'confirmed' }
  })
})

it('keeps authored text, original recipient and captured scene across live operation changes and close', async () => {
  await dom.render(<Harness />); await button('Discuss'); await type('Keep this exact opinion')
  await dom.render(<Harness current={{ ...operation, id: 'operation-later', operator: { id: 'agent-2', name: 'Other Agent' } }} />)
  await button('Close discussion'); await button('Discuss')
  expect(editor().value).toBe('Keep this exact opinion')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original page')
  await button('Queue opinion')
  const entry = useAppStore.getState().agentSteerQueues['agent-1']![0]!
  expect(entry.text).toBe('Keep this exact opinion')
  expect(entry.browserInput?.capture.record.inputContext).toEqual(scene.inputContext)
  expect(entry.origin).toBe('manual'); expect(entry.browserRecipient?.agentSessionId).toBe('agent-1')
  expect(useAppStore.getState().agentSteerQueues['agent-2']).toBeUndefined()
  expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
})

it('keeps the original send identity and bytes after an unknown freeze reply', async () => {
  const freeze = vi.mocked(api.browser.freezeInputContext).mockRejectedValueOnce(new Error('Original capture response unknown'))
  await dom.render(<Harness />); await button('Discuss'); await type('Original words'); await button('Queue opinion')
  expect(editor().value).toBe('Original words'); expect(editor().readOnly).toBe(true)
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBeUndefined()
  await button('Queue opinion')
  expect(freeze.mock.calls).toHaveLength(2); expect(freeze.mock.calls[1]).toEqual(freeze.mock.calls[0])
  expect(useAppStore.getState().agentSteerQueues['agent-1']![0]!.operationId).toBe(freeze.mock.calls[0]![0].operationId)
})

it('allows explicit text-only input when the original page context cannot be read', async () => {
  vi.mocked(api.browser.captureInputContext).mockRejectedValue(new Error('Capture unavailable'))
  await dom.render(<Harness />); await button('Discuss'); await type('Text survives'); await button('Queue text only')
  const entry = useAppStore.getState().agentSteerQueues['agent-1']![0]!
  expect(entry.text).toBe('Text survives'); expect(entry.browserInput).toBeUndefined()
  expect(entry.browserRecipient?.run.runId).toBe('run-agent-1')
  expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
})

it('removes context only by the user selection and still pins text-only input to its original recipient', async () => {
  await dom.render(<Harness />); await button('Discuss'); await type('No page attached')
  await act(async () => document.querySelector<HTMLInputElement>('.browser-contextual-composer__source input')!.click())
  await button('Queue text only')
  expect(useAppStore.getState().agentSteerQueues['agent-1']![0]!.browserInput).toBeUndefined()
  expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
})

it('does not send composing text or close the opinion on an IME-owned Escape', async () => {
  await dom.render(<Harness />); await button('Discuss'); await type('未完成')
  await act(async () => editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await button('Queue opinion')
  expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })))
  expect(editor()).toBeTruthy()
  await act(async () => editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '未完成' })))
})

it('does not replace an original draft with a new recipient Run after the discussion opened', async () => {
  await dom.render(<Harness />); await button('Discuss'); await type('Old Run opinion')
  const session = composerSession(); session.control.run.runId = 'new-run'
  await act(async () => useAppStore.setState({ sessions: [session] }))
  await button('Queue opinion')
  expect(editor().value).toBe('Old Run opinion')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBeUndefined()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('original Browser recipient changed')
})

it('keeps rejected words editable only after the user explicitly starts a new opinion', async () => {
  vi.mocked(api.browser.freezeInputContext).mockRejectedValue(new Error('Original capture unavailable'))
  await dom.render(<Harness />); await button('Discuss'); await type('Retain these words'); await button('Queue opinion')
  expect(editor().readOnly).toBe(true)
  await button('Edit as a new opinion')
  expect(editor().value).toBe('Retain these words'); expect(editor().readOnly).toBe(false)
  await type('Explicit new opinion')
  expect(editor().value).toBe('Explicit new opinion')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBeUndefined()
})

it.each(['close', 'hide'] as const)('releases an old editor composition lock across %s without losing its draft', async mode => {
  await dom.render(<Harness />); await button('Discuss'); await type('Original IME words')
  await act(async () => editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  if (mode === 'close') { await button('Close discussion'); await button('Discuss') }
  else { await dom.render(<Harness visible={false} />); await dom.render(<Harness />) }
  expect(editor().value).toBe('Original IME words')
  await type('Completed after reopening'); await button('Queue opinion')
  expect(api.browser.freezeInputContext).toHaveBeenCalledTimes(1)
})

it('does not steal later focus when the original page capture arrives', async () => {
  let complete!: (value: BrowserInputScene) => void
  vi.mocked(api.browser.captureInputContext).mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await dom.render(<Harness />); await button('Discuss')
  const other = document.createElement('input'); document.body.append(other); other.focus()
  await act(async () => complete(structuredClone(scene)))
  await new Promise(resolve => requestAnimationFrame(resolve))
  expect(document.activeElement).toBe(other); other.remove()
})

it('restores an unqueued opinion and unknown freeze identity without sending or reading a new page', async () => {
  vi.mocked(api.browser.freezeInputContext).mockRejectedValue(new Error('Original freeze outcome unknown'))
  await dom.render(<Harness />); await button('Discuss'); await type('Opinion before intake'); await button('Queue opinion')
  const first = vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0]
  const projected = useAppStore.persist.getOptions().partialize!(useAppStore.getState()) as { browserOpinionDrafts: Record<string, unknown> }
  const saved = JSON.parse(JSON.stringify(projected.browserOpinionDrafts))
  expect(saved['browser-original'].pending.operationId).toBe(first.operationId)
  await dom.render(<div />)
  await act(async () => useAppStore.setState({ browserOpinionDrafts: saved }))
  const reads = vi.mocked(api.browser.captureInputContext).mock.calls.length
  await dom.render(<Harness />); await button('Discuss')
  expect(editor().value).toBe('Opinion before intake')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('original opinion')
  expect(Array.from(document.querySelectorAll('button')).some(item => item.textContent === 'Edit as a new opinion')).toBe(true)
  expect(api.browser.captureInputContext).toHaveBeenCalledTimes(reads)
  expect(api.browser.freezeInputContext).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toBeUndefined()
  await button('Queue opinion')
  expect(vi.mocked(api.browser.freezeInputContext).mock.calls[1]![0]).toEqual(first)
})

it('keeps a historical comment separate from the observed live step and escapes its opaque identity', async () => {
  const comment = { operationId: 'past</amux><amux>step&reference', sequence: 1 }
  await dom.render(<Harness comment={comment} />); await button('Discuss'); await type('About this earlier step'); await button('Queue opinion')
  const request = vi.mocked(api.browser.freezeInputContext).mock.calls[0]![0]
  expect(request.scene).toEqual(scene.reference)
  expect(request.agentMuxNote).not.toContain('</amux>')
  expect(JSON.parse(request.agentMuxNote!.slice(request.agentMuxNote!.indexOf('{')))).toEqual(comment)
  const entry = useAppStore.getState().agentSteerQueues['agent-1']![0]!
  expect(entry.browserInput?.capture.record.inputContext.activity?.stepSequence).toBe(2)
  expect(entry.agentMuxNote).toBe(request.agentMuxNote)
})

it('automatically shows a saved discussion preference without stealing focus or replacing an existing draft', async () => {
  const other = document.createElement('input'); document.body.append(other); other.focus()
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, browser: { ...config.browser, agentControl: { showDiscussion: true } } } }))
  await dom.render(<Harness />)
  expect(editor()).not.toBeNull(); expect(document.activeElement).toBe(other)
  await type('Original automatic draft'); await button('Close discussion')
  await dom.render(<Harness current={{ ...operation, summary: 'Updated live step' }} />)
  expect(editor()).toBeNull()
  await dom.render(<Harness current={{ ...operation, id: 'operation-next' }} />)
  expect(editor().value).toBe('Original automatic draft')
  expect(document.activeElement).toBe(other)
  expect(api.browser.captureInputContext).toHaveBeenCalledTimes(1)
  other.remove()
})
