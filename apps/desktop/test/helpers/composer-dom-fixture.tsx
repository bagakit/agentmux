import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { useAppStore } from '../../src/renderer/src/store'

export const composerConfig: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
export function composerSession(id = 'agent-1', providerId = 'codex'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id, kind: 'agent', providerId, executorId: providerId, hostId: 'local', workspacePath: '/repo',
    label: providerId, createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

/** Real Store + React + rich input. Only native desktop calls are mocked by the individual tests. */
export function composerDOM() {
  const initial = useAppStore.getState()
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useAppStore.setState({ config: composerConfig, sessions: [composerSession()], error: null,
      agentNames: {}, agentComposerDrafts: { 'agent-1': 'Keep my draft' }, agentSteerQueues: {} })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(initial, true)
    vi.restoreAllMocks()
  })
  return {
    get container() { return container },
    render: async (element: ReactNode) => { await act(async () => root.render(element)) },
    click: async (selector: string) => {
      const button = container.querySelector<HTMLButtonElement>(selector)
      if (!button) throw new Error(`Missing button: ${selector}`)
      await act(async () => button.click())
    },
    draft: (id = 'agent-1') => useAppStore.getState().agentComposerDrafts[id]
  }
}
