import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
// Keep App, Settings, Workbench, SessionPane, Composer and every UI owner real.
// Native terminal attachment and Markdown rendering are outside this DOM proof.
vi.mock('../../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ sessionId }: { sessionId: string }) =>
  createElement('div', { 'data-terminal-session': sessionId }) }))
vi.mock('../../src/renderer/src/components/ActivityView', () => ({ ActivityView: ({ sessionId }: { sessionId: string }) =>
  createElement('div', { 'data-activity-session': sessionId }) }))

import { App } from '../../src/renderer/src/App'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../../src/shared/scratch-topics'
import { defaultTab, installNativePopover, moteTopics, seedMoteWorkface } from './mote-workface'

export async function settleMoteApp(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
}
export async function motePointer(element: HTMLElement, type: 'over' | 'out' | 'down'): Promise<void> {
  await act(async () => element.dispatchEvent(new PointerEvent('pointer' + type, {
    bubbles: true, pointerType: 'mouse', buttons: type === 'down' ? 1 : 0
  })))
  // happy-dom does not synthesize Chromium's non-bubbling enter/leave events.
  if (type !== 'down') await act(async () => element.dispatchEvent(new PointerEvent(
    type === 'over' ? 'pointerenter' : 'pointerleave', { pointerType: 'mouse' }
  )))
}
export async function moteClick(element: HTMLElement): Promise<void> {
  await motePointer(element, 'down'); await act(async () => element.click()); await settleMoteApp()
}
export async function moteType(input: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    input.focus()
    input.replaceChildren(Object.assign(document.createElement('p'), { textContent: text }))
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }))
  }); await settleMoteApp()
}

export function createMoteApp() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const baseline = useAppStore.getState()
  const restorePopover = installNativePopover()
  window.localStorage.clear(); seedMoteWorkface()
  const warm = vi.fn(), launch = vi.fn(), send = vi.fn(() => true), stop = vi.fn(), enqueue = vi.fn(() => true)
  useAppStore.setState({ loading: false, initialize: async () => () => {},
    activeWorkspaceId: SCRATCH_WORKSPACE_ID, mainSurface: 'workbench',
    prewarmTerminal: warm, detectExecutors: vi.fn(async () => {}), launchAgent: launch,
    send, stopSession: stop, enqueueAgentSteer: enqueue, reportError: vi.fn() })
  useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)
  const listTopics = vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics)
  const ensureMote = vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id)!)
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null)
  const container = document.createElement('div'); document.body.append(container)
  let root = createRoot(container)
  const panel = () => {
    const found = container.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')
    expect(found).not.toBeNull(); return found!
  }
  const entry = () => {
    const found = document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')
    expect(found).not.toBeNull(); return found!
  }
  return {
    container, panel, entry, warm, launch, send, stop, enqueue, listTopics, ensureMote,
    async mount(extra?: ReactNode) {
      await act(async () => root.render(createElement(Fragment, null, createElement(App), extra)))
      await settleMoteApp()
    },
    async hover() { await motePointer(entry(), 'over'); await settleMoteApp() },
    async remount() {
      await act(async () => root.unmount()); root = createRoot(container)
      await act(async () => root.render(createElement(App))); await settleMoteApp()
    },
    async dispose() {
      await act(async () => root.unmount()); container.remove(); restorePopover()
      window.localStorage.clear(); vi.restoreAllMocks(); useAppStore.setState(baseline, true)
    }
  }
}
export type MoteAppFixture = ReturnType<typeof createMoteApp>
