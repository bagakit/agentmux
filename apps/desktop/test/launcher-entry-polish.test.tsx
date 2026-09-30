// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConfig } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-warm-run /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const original = useLauncherState.getState()
beforeEach(async () => {
  window.localStorage.setItem('agentmux-launcher', JSON.stringify({ state: { sections: {}, drafts: {}, executors: {} }, version: 0 }))
  await act(async () => {
    await useLauncherState.persist.rehydrate()
    useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null })
  })
})
afterEach(async () => { await act(async () => useLauncherState.setState(original, true)) })

async function mount({ path = '/Users/alice/project', home = '/Users/alice', host = composerConfig.hosts[0], absolute = false, visible = false }: {
  path?: string; home?: string; host?: HostConfig; absolute?: boolean; visible?: boolean
} = {}) {
  const session = { ...composerSession('warm-shell'), kind: 'terminal' as const, providerId: null,
    control: { kind: 'terminal' as const, hostId: host!.id, runId: 'original-shell', run: { runId: 'original-shell' } } }
  useAppStore.setState({ config: { ...composerConfig, copyPathsAsAbsolute: absolute, hosts: [host!],
    workspaces: [{ ...composerConfig.workspaces[0]!, path, hostId: host!.id }] }, localHome: home,
    tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Complete task\nPreserve this second line.' },
    warmTerminal: { key: warmTerminalKey(host!.id, path), ownerLauncherId: 'region:region', session, ready: Promise.resolve(session) },
    recoveryCandidates: [], executorDetections: {}, hostChecks: {}, detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn() })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={visible} />)
}
async function openEnvironment() {
  // A retained Launcher cannot open a Portal. Activate this exact original mount first.
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={true} />)
  const warmCalls = vi.mocked(useAppStore.getState().prewarmTerminal).mock.calls.length
  await dom.click('[aria-label="Runtime environment"]')
  const panel = document.querySelector<HTMLElement>('.launcher-environment__panel')
  expect(panel).not.toBeNull()
  expect(vi.mocked(useAppStore.getState().prewarmTerminal).mock.calls).toHaveLength(warmCalls)
  return panel!
}
async function closeEnvironment() { await act(async () => (document.querySelector('[aria-label="Close runtime environment"]') as HTMLButtonElement).click()) }

describe('the mounted Launcher entry polish', () => {
  it('a fresh Space shows the same warm Terminal and compact Agent/Resume while other tools remain collapsed', async () => {
    await mount()
    expect(dom.container.querySelector('.launch-surface')?.getAttribute('data-agent-section')).toBe('collapsed')
    expect([...dom.container.querySelectorAll('[data-section]')].map(node => [node.getAttribute('data-section'), node.getAttribute('data-mode')])).toEqual([
      ['terminal', 'expanded'], ['browser', 'collapsed'], ['note', 'collapsed']
    ])
    expect(dom.container.querySelector('[data-warm-run]')).not.toBeNull()
    expect(dom.container.querySelector('[aria-label="Expand Agents"]')?.textContent).toContain('Codex')
    expect(dom.container.querySelector('.launcher-resume-trigger')).not.toBeNull()
    expect(dom.container.querySelector('.launcher-composer')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Launch options"]')).toBeNull()
    expect(dom.container.querySelector('.launcher-mote')).toBeNull()
    expect(dom.container.querySelector('.launcher-launch-button')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Browser address or search"]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Note draft"]')).toBeNull()
    expect(useLauncherState.getState().sections).toEqual({})
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('original-shell')
  })

  it('explicit durable preferences and drafts outrank the fresh defaults without clearing or migrating them', async () => {
    const saved = { sections: { workspace: { agents: 'expanded', terminal: 'hidden', browser: 'expanded', note: 'collapsed' } },
      drafts: { 'region:region': { browser: 'kept search', note: 'kept note' } }, executors: { workspace: 'codex' } }
    window.localStorage.setItem('agentmux-launcher', JSON.stringify({ state: saved, version: 0 }))
    await act(async () => { await useLauncherState.persist.rehydrate() })
    await mount()
    expect(dom.container.querySelector('.launcher-composer')).not.toBeNull()
    expect(dom.container.querySelector('[aria-label="Restore Terminal"]')).not.toBeNull()
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')?.value).toBe('kept search')
    expect(JSON.parse(window.localStorage.getItem('agentmux-launcher')!).state).toEqual(saved)
    expect(dom.draft('region')).toBe('Complete task\nPreserve this second line.')
  })

  it.each([
    { path: '/Users/alice/project', expected: '~/project' },
    { path: '/Users/alice', expected: '~' },
    { path: '/Users/alice/project', absolute: true, expected: '/Users/alice/project' },
    { path: '/Users/bob/project', expected: '/Users/bob/project' },
    { path: '/Users/alice-other/project', expected: '/Users/alice-other/project' },
    { path: '/Users/alice/project', home: '', expected: '/Users/alice/project' },
    { path: '/Users/alice/project', host: { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'host.example', user: 'alice' }, expected: '/Users/alice/project' }
  ])('the visible summary and anchored details share the project path representation: $expected', async ({ expected, ...input }) => {
    await mount(input)
    const summary = dom.container.querySelector('.launcher-environment__path')!
    expect(summary.textContent).toBe(expected)
    expect(summary.getAttribute('title')).toBe(input.path)
    const panel = await openEnvironment()
    expect(panel.querySelector('.launcher-environment__directory')?.textContent).toBe(expected)
    expect(panel.querySelector('.launcher-environment__directory')?.getAttribute('title')).toBe(input.path)
    expect(panel.textContent).toContain('Not tested')
    expect(panel.textContent).not.toContain('Ready')
    expect(dom.container.querySelector('.launcher-environment details')).toBeNull()
    expect(useAppStore.getState().config?.workspaces[0]?.path).toBe(input.path)
    await closeEnvironment()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Runtime environment"]'))
  })

  it('opening or closing Host details preserves the original Run and gives an honest check failure', async () => {
    await mount()
    const host = composerConfig.hosts[0]!
    await act(async () => useAppStore.setState({ hostChecks: { local: { state: 'error', input: host, detail: 'Diagnostic unavailable' } } }))
    const panel = await openEnvironment()
    expect(panel.textContent).toContain('Check failed')
    expect(panel.textContent).toContain('Diagnostic unavailable')
    expect(panel.textContent).toContain('Isolated environments are not supported yet.')
    await closeEnvironment()
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('original-shell')
  })

  it('an absent Host configuration does not claim a configured shell or abbreviate an unconfirmed local path', async () => {
    await mount()
    await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, hosts: [] } }))
    expect(dom.container.querySelector('.launcher-environment__path')?.textContent).toBe('/Users/alice/project')
    const panel = await openEnvironment()
    expect(panel.textContent).toContain('Host unconfirmed')
    expect(panel.textContent).toContain('Host not configured')
    expect(panel.textContent).not.toContain('Configured host shell')
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('original-shell')
  })

  it('expanding the real editing context locates Options with input tools and groups Launch/Resume without altering the original resource parameters', async () => {
    await mount()
    const launch = vi.fn().mockResolvedValue(undefined)
    await act(async () => useAppStore.setState({ launchAgent: launch }))
    await dom.click('[aria-label="Expand Agents"]')
    expect(dom.container.querySelector('.launcher-tools [aria-label="Launch options"]')).not.toBeNull()
    expect(dom.container.querySelector('.launch-surface__footer .launcher-mote__create')).not.toBeNull()
    const actions = dom.container.querySelector('.launcher-primary-actions')!
    expect([...actions.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Resume', 'Launch'])
    await dom.click('.launcher-launch-button')
    expect(launch).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledWith('codex', 'Complete task\nPreserve this second line.', 'group', { tabId: 'launcher', regionId: 'region' }, {}, { agentName: undefined, tabName: undefined })
    expect(useAppStore.getState().config?.workspaces[0]?.path).toBe('/Users/alice/project')
    expect(useAppStore.getState().warmTerminal?.key).toBe(warmTerminalKey('local', '/Users/alice/project'))
    await dom.click('[aria-label="Collapse Agents"]')
    expect(dom.container.querySelector('.launch-surface__footer')).toBeNull()
    expect(dom.draft('region')).toBe('Complete task\nPreserve this second line.')
  })

  it('Browser collapse saves the preference immediately, disables its exiting input and cancels a stale completion after reopening', async () => {
    await mount({ visible: true })
    vi.useFakeTimers()
    try {
      await dom.click('[aria-label="Expand Browser"]')
      dom.container.querySelector<HTMLElement>('.launcher-browser')!.style.setProperty('--dur-enter', '120ms')
      await dom.click('[aria-label="Collapse Browser"]')
      expect(useLauncherState.getState().sections.workspace!.browser).toBe('collapsed')
      expect(JSON.parse(window.localStorage.getItem('agentmux-launcher')!).state.sections.workspace.browser).toBe('collapsed')
      expect(dom.container.querySelector('.launcher-browser')?.getAttribute('data-closing')).toBe('true')
      expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')?.disabled).toBe(true)
      expect(dom.container.querySelector('.launcher-browser-field')?.hasAttribute('inert')).toBe(true)
      await act(async () => useLauncherState.getState().setSection('workspace', 'browser', 'expanded'))
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(useLauncherState.getState().sections.workspace!.browser).toBe('expanded')
      expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')?.disabled).toBe(false)
      await dom.click('[aria-label="Collapse Browser"]')
      await dom.click('[aria-label="Close Browser"]')
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(useLauncherState.getState().sections.workspace!.browser).toBe('hidden')
      expect(dom.container.querySelector('[data-section="browser"]')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('hiding and unmounting during the Browser exit retains the explicit collapsed preference and complete drafts', async () => {
    await mount({ visible: true })
    await act(async () => useLauncherState.getState().setDraft('region:region', 'browser', 'Unsent search'))
    vi.useFakeTimers()
    try {
      await dom.click('[aria-label="Expand Browser"]')
      await dom.click('[aria-label="Collapse Browser"]')
      await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
      await dom.render(null)
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(JSON.parse(window.localStorage.getItem('agentmux-launcher')!).state.sections.workspace.browser).toBe('collapsed')
      expect(useLauncherState.getState().drafts['region:region']!.browser).toBe('Unsent search')
      expect(dom.draft('region')).toBe('Complete task\nPreserve this second line.')
      expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('original-shell')
    } finally { vi.useRealTimers() }
  })

  it('Browser expands into one working row, submits through the existing owner and retains its exact draft across collapse/close', async () => {
    await mount()
    await act(async () => useLauncherState.getState().setDraft('region:region', 'browser', 'Local runtime search'))
    const create = vi.fn().mockResolvedValue(undefined)
    await act(async () => useAppStore.setState({ createBrowser: create }))
    await dom.click('[aria-label="Expand Browser"]')
    const row = dom.container.querySelector('[data-section="browser"]')!
    expect(row.querySelectorAll('form')).toHaveLength(1)
    expect(row.querySelectorAll('input')).toHaveLength(1)
    expect(row.querySelector('.launcher-utility__head')).toBeNull()
    expect(row.querySelector('form [aria-label="Collapse Browser"]')).not.toBeNull()
    expect(row.querySelector('form [aria-label="Close Browser"]')).not.toBeNull()
    expect(row.querySelector('form [aria-label="Go to Browser address or search"]')).not.toBeNull()
    await dom.click('[aria-label="Go to Browser address or search"]')
    expect(create).toHaveBeenCalledWith('group', { tabId: 'launcher', regionId: 'region' }, 'Local runtime search')
    await dom.click('[aria-label="Collapse Browser"]')
    await dom.click('[aria-label="Expand Browser"]')
    expect(row.querySelector<HTMLInputElement>('input')?.value).toBe('Local runtime search')
    await dom.click('[aria-label="Close Browser"]')
    await dom.click('[aria-label="Restore Browser"]')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')?.value).toBe('Local runtime search')
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('original-shell')
  })
})
