// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), launcherBefore = useLauncherState.getState()
afterEach(() => useLauncherState.setState(launcherBefore, true))

async function fixture() {
  const detect = vi.fn(async () => {}), launch = vi.fn(async () => {})
  useLauncherState.setState({ sections: {}, drafts: { 'group:group': { browser: '', note: '', prompt: 'Keep the original task' } }, executors: {} })
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace', tabs: {},
    layouts: { workspace: createWorkspaceLayout('group') }, sessions: [composerSession('healthy-neighbor')],
    hostChecks: {}, executorDetections: {}, hostExecutorInventories: {}, recoveryCandidates: [],
    prewarmTerminal: vi.fn(), releaseWarmTerminal: vi.fn(), detectExecutors: detect, launchAgent: launch,
    workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null })
  await dom.render(<NewTabSurface tabGroupId="group" />)
  return { detect, launch }
}

it('the actual initial page groups execution placement with its project and preserves its existing input and read budget', async () => {
  const f = await fixture()
  const header = dom.container.querySelector<HTMLElement>('.launcher-environment')!
  const entry = header.querySelector<HTMLButtonElement>('[aria-label="Agent location"]')!
  expect(entry).not.toBeNull()
  expect(header.textContent).toContain('Run mode')
  expect(header.querySelector('h2')?.textContent).toBe('Project')
  expect(dom.container.querySelector('.launcher-agents-head [aria-label="Agent location"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Refresh agents on this device"]')).not.toBeNull()
  const before = useAppStore.getState(), draft = useLauncherState.getState().drafts['group:group'], reads = f.detect.mock.calls.length
  await dom.render(<NewTabSurface tabGroupId="group" />)
  expect(useLauncherState.getState().drafts['group:group']).toEqual(draft)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(f.detect).toHaveBeenCalledTimes(reads)
  expect(f.launch).not.toHaveBeenCalled()
})

it('collapsing the configuration keeps the same original placement visibility and retained task', async () => {
  const f = await fixture(), draft = useLauncherState.getState().drafts['group:group']
  await act(async () => { useLauncherState.getState().setSection('workspace', 'agents', 'collapsed') })
  expect(dom.container.querySelector('.launcher-environment h2')?.textContent).toBe('Project')
  expect(dom.container.querySelector('[aria-label="Agent location"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Expand Agents"]')).not.toBeNull()
  await act(async () => { useLauncherState.getState().setSection('workspace', 'agents', 'expanded') })
  expect(dom.container.querySelector('.launcher-environment [aria-label="Agent location"]')).not.toBeNull()
  expect(useLauncherState.getState().drafts['group:group']).toEqual(draft)
  expect(f.launch).not.toHaveBeenCalled()
})
