import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initial = useAppStore.getState()
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {},
  workspaces: [{ id: 'workspace', hostId: 'local', path: '/repo', name: 'Project', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const terminal = (processState: 'running' | 'exited'): Extract<SessionSnapshot, { kind: 'terminal' }> => ({
  id: 'old-terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo',
  label: 'Terminal', createdAt: 1, updatedAt: 1, processState,
  status: { state: processState, source: 'run-process', observedAt: 1 }, latestOutputBytes: 29,
  control: { kind: 'terminal', hostId: 'local', runId: 'old-terminal', run: { runId: 'old-terminal' } }
})
const tab = createWorkbenchTab('original-tab', {
  regionId: 'original-region', kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId: 'old-terminal'
})
const layout = createWorkspaceLayout('original-group', [tab.id])

afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

describe('old unclaimed UI markers do not authorize startup Stop', () => {
  for (const processState of ['running', 'exited'] as const) {
    it(`retains an observed ${processState} Terminal, its original View and pending ownership marker`, async () => {
      const session = terminal(processState)
      useAppStore.setState({ loading: true, restoredWorkbench: { tabs: { [tab.id]: tab }, layouts: { workspace: layout } },
        unclaimedTerminalSessionIds: [session.id], agentComposerDrafts: { unrelated: 'original draft' } })
      vi.spyOn(api.config, 'get').mockResolvedValue(config)
      vi.spyOn(api.providers, 'list').mockResolvedValue([])
      vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
      const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
      const dispose = await useAppStore.getState().initialize()
      try {
        const state = useAppStore.getState()
        expect(stop).not.toHaveBeenCalled()
        expect(state.sessions).toEqual([session])
        expect(state.unclaimedTerminalSessionIds).toEqual([session.id])
        expect(Object.keys(state.tabs)).toEqual([tab.id])
        expect(state.tabs[tab.id]).toEqual(tab)
        expect(state.layouts.workspace).toEqual(layout)
        expect(state.agentComposerDrafts).toEqual({ unrelated: 'original draft' })
      } finally { dispose() }
    })
  }

  it('keeps unknown old ownership, original View and draft when the snapshot fails', async () => {
    useAppStore.setState({ loading: true, restoredWorkbench: { tabs: { [tab.id]: tab }, layouts: { workspace: layout } },
      unclaimedTerminalSessionIds: ['old-terminal'], agentComposerDrafts: { unrelated: 'original draft' } })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockRejectedValue(new Error('Private Runtime observation unavailable'))
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
    const dispose = await useAppStore.getState().initialize()
    try {
      const state = useAppStore.getState()
      expect(stop).not.toHaveBeenCalled()
      expect(state.unclaimedTerminalSessionIds).toEqual(['old-terminal'])
      expect(Object.keys(state.tabs)).toEqual([tab.id])
      expect(state.tabs[tab.id]!.regions['original-region']).toMatchObject({ kind: 'terminal', sessionId: 'old-terminal' })
      expect(state.layouts.workspace).toEqual(layout)
      expect(state.agentComposerDrafts).toEqual({ unrelated: 'original draft' })
      expect(state.error).toContain('Private Runtime observation unavailable')
    } finally { dispose() }
  })

  it('does not create a Tab for a known Terminal that has no saved View', async () => {
    const session = terminal('running')
    useAppStore.setState({ loading: true, restoredWorkbench: null, unclaimedTerminalSessionIds: [session.id] })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
    const dispose = await useAppStore.getState().initialize()
    try {
      expect(useAppStore.getState().sessions).toEqual([session])
      expect(useAppStore.getState().tabs).toEqual({})
      expect(useAppStore.getState().unclaimedTerminalSessionIds).toEqual([session.id])
      expect(stop).not.toHaveBeenCalled()
    } finally { dispose() }
  })
})
