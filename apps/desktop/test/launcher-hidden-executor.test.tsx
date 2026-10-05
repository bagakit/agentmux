// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), originalLauncher = useLauncherState.getState()
const remote = { id: 'remote', kind: 'ssh' as const, label: 'Target Host', hostname: 'target.invalid' }
beforeEach(() => {
  useLauncherState.setState({ sections: { workspace: { agents: 'hidden', terminal: 'hidden', browser: 'hidden', note: 'hidden' } },
    drafts: {}, executors: {}, persistenceIssue: null })
  useAppStore.setState({ config: { ...composerConfig, hosts: [remote], workspaces: [{ ...composerConfig.workspaces[0]!, hostId: remote.id }] },
    activeWorkspaceId: 'workspace', mainSurface: 'workbench', tabs: {}, layouts: { workspace: createWorkspaceLayout('group', []) },
    workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null, warmTerminal: null,
    hostExecutorInventories: {}, executorDetections: {}, hostChecks: {}, recoveryCandidates: [],
    detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn() })
})
afterEach(async () => { await act(async () => useLauncherState.setState(originalLauncher, true)) })

it('a mounted hidden Agents section performs no discovery and restoring it observes the same target without losing input or Run', async () => {
  const stop = vi.spyOn(api.sessions, 'stop'), originalSession = useAppStore.getState().sessions[0]!
  await dom.render(<NewTabSurface tabGroupId="group" />)
  const detect = vi.mocked(useAppStore.getState().detectExecutors)
  expect(dom.container.querySelector('[aria-label="Restore Agents"]')).not.toBeNull()
  expect(detect).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ agentNames: { [originalSession.id]: 'Unrelated change' } }))
  expect(detect).not.toHaveBeenCalled()
  await dom.click('[aria-label="Restore Agents"]')
  expect(detect).toHaveBeenCalledExactlyOnceWith(remote.id)
  expect(dom.container.querySelector('[aria-label="Refresh agents on this host"]')).not.toBeNull()
  await dom.click('[aria-label="Refresh agents on this host"]')
  expect(detect).toHaveBeenCalledTimes(2)
  expect(detect.mock.calls.every(([hostId]) => hostId === remote.id)).toBe(true)
  expect(useAppStore.getState().sessions[0]).toBe(originalSession)
  expect(dom.draft()).toBe('Keep my draft')
  expect(stop).not.toHaveBeenCalled()
})

it('an existing visible Launcher observes a newly selected Host only after Agents is restored', async () => {
  await dom.render(<NewTabSurface tabGroupId="group" />)
  const detect = vi.mocked(useAppStore.getState().detectExecutors), before = useAppStore.getState().config!
  const other = { ...remote, id: 'other', hostname: 'other.invalid' }
  await act(async () => useAppStore.setState({ config: { ...before, hosts: [...before.hosts, other],
    workspaces: before.workspaces.map(workspace => ({ ...workspace, hostId: other.id })) } }))
  expect(detect).not.toHaveBeenCalled()
  await dom.click('[aria-label="Restore Agents"]')
  expect(detect).toHaveBeenCalledExactlyOnceWith(other.id)
})
