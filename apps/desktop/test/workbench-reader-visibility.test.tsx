// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AppWindowDescriptor } from '@agentmux/core/control'
import { AgentInformationPreviewHost, useAgentInformationPreview } from '../src/renderer/src/components/AgentInformationPreview'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { agentContextForSession, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { observeWorkbenchNativeVisibility, registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


async function scene(pinned: boolean) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), sessions = (await api.sessions.snapshot()).sessions
  const session = sessions.find(value => value.kind === 'agent')!
  expect(session).toBeDefined()
  useAppStore.setState({ sessions: [session] })
  const frame = document.createElement('iframe'); document.body.append(frame)
  const owner = frame.contentDocument!, container = owner.createElement('div'); owner.body.append(container)
  const root = createRoot(container), identity = { windowId: 'original-window', documentGeneration: 'original-document' }
  const release = registerWorkbenchDocument(owner, identity)
  const context: FocusContext = { ...agentContextForSession(session, undefined, 'Original Agent', undefined, null), lastActivityAt: _historyFixtureEpoch(0, 0, 0), recap: { text: 'Original reading text', reading: { text: 'Original reading text', truncated: false }, source: 'Last assistant message', origin: 'timeline' }, detailIsRecap: true }
  const descriptor = (presentation: AppWindowDescriptor['presentation'], documentGeneration = identity.documentGeneration): AppWindowDescriptor => ({ ...identity, documentGeneration, target: { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab' }, presentation, bounds: null, focused: null })
  function Trigger() { const preview = useAgentInformationPreview(context, true, undefined, undefined, () => {}); return <button ref={preview.anchor} {...preview.triggerEvents}>Read original source</button> }
  await act(async () => root.render(<WorkbenchDocumentContext.Provider value={{ document: owner, window: identity }}><AgentInformationPreviewHost/><Trigger/></WorkbenchDocumentContext.Provider>))
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  const open = async () => { await act(async () => { trigger.blur(); trigger.focus() }); await vi.waitFor(() => expect(owner.querySelector('.agent-information-reader')).not.toBeNull()); if (pinned) await act(async () => owner.querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click()) }
  const close = async () => { await act(async () => { const current = agentInformationPreview.get(); if (current) agentInformationPreview.dismiss(current.token, true); root.unmount() }); release(); container.remove(); frame.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  return { owner, container, descriptor, open, close, trigger }
}

it('keeps native-hidden pinned reading and its Range while stopping its actual layout and state clock until the same document is visible', async () => {
  const input = await scene(true)
  const { owner, descriptor } = input
  const clock = vi.spyOn(globalThis, 'setInterval'), clearClock = vi.spyOn(globalThis, 'clearInterval')
  try {
    await input.open()
    const panel = owner.querySelector<HTMLElement>('.agent-information-reader')!, reading = panel.querySelector<HTMLElement>('.agent-information-reader__reading')!
    expect(panel.hidden).toBe(false); expect(agentInformationPreview.get()?.pinned).toBe(true)
    const text = reading.querySelector('p')!.firstChild!, range = owner.createRange(); range.setStart(text, 2); range.setEnd(text, 10)
    owner.getSelection()!.removeAllRanges(); owner.getSelection()!.addRange(range); reading.scrollTop = 37
    const geometry = vi.spyOn(panel, 'getBoundingClientRect'), source = panel.textContent
    const clocks = clock.mock.calls.flatMap((args, index) => args[1] === 1000 ? [clock.mock.results[index]!.value] : [])
    expect(clocks.length).toBeGreaterThan(0)
    const readCalls = vi.spyOn(api.sessions, 'historyPage')
    await act(async () => observeWorkbenchNativeVisibility([descriptor('hidden', 'stale-document')]))
    expect(panel.hidden).toBe(false)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('hidden')]))
    expect(owner.visibilityState).toBe('visible'); expect(panel.hidden).toBe(true)
    expect(owner.querySelector('.agent-information-reader')).toBe(panel); expect(agentInformationPreview.get()?.pinned).toBe(true)
    expect(clocks.some(id => clearClock.mock.calls.some(([cleared]) => cleared === id))).toBe(true)
    const bounds = geometry.mock.calls.length, reads = readCalls.mock.calls.length
    await act(async () => { owner.defaultView!.dispatchEvent(new Event('resize')); await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(geometry).toHaveBeenCalledTimes(bounds); expect(readCalls).toHaveBeenCalledTimes(reads)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('unknown')]))
    expect(panel.hidden).toBe(true)
    await act(async () => observeWorkbenchNativeVisibility([descriptor('visible')]))
    expect(panel.hidden).toBe(false); expect(owner.querySelector('.agent-information-reader')).toBe(panel)
    expect(panel.querySelector('.agent-information-reader__reading')).toBe(reading); expect(reading.scrollTop).toBe(37)
    expect(owner.getSelection()!.anchorNode).toBe(text); expect(owner.getSelection()!.anchorOffset).toBe(2); expect(owner.getSelection()!.focusOffset).toBe(10)
    expect(panel.textContent).toBe(source)
  } finally { await input.close() }
})

it('blocks new transient disclosure in a known hidden native document without adding a per-card visibility subscription', async () => {
  const input = await scene(false)
  try {
    const open = vi.spyOn(agentInformationPreview, 'show')
    await act(async () => observeWorkbenchNativeVisibility([input.descriptor('hidden')]))
    expect(input.owner.visibilityState).toBe('visible')
    await act(async () => input.trigger.focus())
    expect(open).not.toHaveBeenCalled(); expect(input.owner.querySelector('.agent-information-reader')).toBeNull()
    await act(async () => observeWorkbenchNativeVisibility([input.descriptor('visible')]))
    await input.open(); expect(agentInformationPreview.get()?.pinned).toBe(false)
    await act(async () => observeWorkbenchNativeVisibility([input.descriptor('hidden')]))
    expect(agentInformationPreview.get()).toBeNull(); expect(input.owner.querySelector('.agent-information-reader')).toBeNull()
  } finally { await input.close() }
})
