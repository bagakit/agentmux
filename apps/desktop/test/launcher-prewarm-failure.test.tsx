import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { warmCandidates } from './helpers/reusable-shell-candidates'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), originalLauncher = useLauncherState.getState()
const originalPrewarm = useAppStore.getState().prewarmTerminal
const shell = (id: string) => ({ ...composerSession(id), kind: 'terminal' as const, providerId: null,
  control: { kind: 'terminal' as const, hostId: 'local', runId: id, run: { runId: id } } })
beforeEach(() => {
  useAppStore.setState({ activeWorkspaceId: 'workspace', mainSurface: 'workbench', warmTerminals: {},
    tabs: {}, layouts: { workspace: createWorkspaceLayout('original-group', []) },
    workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
    prewarmTerminal: originalPrewarm, detectExecutors: vi.fn().mockResolvedValue(undefined) })
  useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null })
})
afterEach(() => useLauncherState.setState(originalLauncher, true))

describe('original Launcher after speculative shell failure', () => {
  it('bounds the failed automatic request and keeps the original input and explicit Terminal action', async () => {
    // A second unresolved reply keeps an unguarded mutant finite so its real extra
    // request fails the count assertion rather than starving the test process.
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(new Error('Host warm unavailable'))
      .mockImplementation(() => new Promise(() => {}))
    const promote = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ promoteWarmTerminal: promote })
    await dom.render(<NewTabSurface tabGroupId="original-group" />)
    const input = dom.container.querySelector('.composer__editor')
    expect(input).not.toBeNull()
    await act(async () => { useAppStore.setState({ agentNames: { original: 'Still healthy' } }); await Promise.resolve() })
    expect(launch).toHaveBeenCalledOnce()
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.issue?.message).toBe('Host warm unavailable')
    expect(dom.container.querySelector('.composer__editor')).toBe(input)
    await dom.click('[aria-label="Open Terminal"]')
    expect(promote).toHaveBeenCalledWith('original-group', undefined)
    expect(useAppStore.getState().sessions[0]!.control).toEqual(composerSession().control)
    expect(dom.draft()).toBe('Keep my draft')
    // Another project gets its own preview without displacing the original unknown request.
    launch.mockResolvedValue(shell('new-host-shell') as never)
    await act(async () => useAppStore.setState({ config: { ...composerConfig,
      workspaces: [{ ...composerConfig.workspaces[0]!, path: _hygiene_fixturePath("another-project") }] } }))
    expect(launch).toHaveBeenCalledTimes(2)
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.request.workspacePath).toBe(_hygiene_fixturePath("repo"))
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.issue?.message).toBe('Host warm unavailable')
    expect(warmCandidates(_hygiene_fixturePath("another-project"))[0]?.session?.id).toBe('new-host-shell')
  })

  it('can fill an empty slot again after the original warm successfully became available', async () => {
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(shell('first-shell') as never)
    await dom.render(<NewTabSurface tabGroupId="original-group" />)
    expect(launch).toHaveBeenCalledOnce()
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.session?.id).toBe('first-shell')
    launch.mockResolvedValue(shell('second-shell') as never)
    await act(async () => useAppStore.setState({ warmTerminals: {} }))
    expect(launch).toHaveBeenCalledTimes(2)
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.session?.id).toBe('second-shell')
    expect(dom.draft()).toBe('Keep my draft')
  })
})
