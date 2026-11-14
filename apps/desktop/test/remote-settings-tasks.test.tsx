// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { RemoteExecutionSettingsPane } from '../src/renderer/src/components/settings/RemoteExecutionSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import type { AppConfig } from '../src/shared/contracts'

const dom = composerDOM(), close = vi.fn(), navigate = vi.fn()
let config: AppConfig
beforeEach(() => {
  installNoteCanvasGeometry(); close.mockClear(); navigate.mockClear()
  config = { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'worker', kind: 'ssh', label: 'Compute', hostname: 'compute.invalid' }], workspaces: [] }
  useAppStore.setState({ config, activeWorkspaceId: null })
  vi.spyOn(api.hostRoutes, 'call').mockRejectedValue(new Error('The saved device observation is unavailable.'))
})
const show = (active = true) => dom.render(<RemoteExecutionSettingsPane config={config} active={active} onClose={close} onNavigate={navigate} />)
const task = async (name: 'routes' | 'start' | 'existing') => {
  await act(async () => dom.container.querySelector<HTMLButtonElement>(`[role="tab"][id$="-${name}-tab"]`)!.click())
}

it('opens Routes without requiring a project or preparing or launching work, and retains access after a failed read', async () => {
  const home = vi.spyOn(api.hosts, 'home'), register = vi.spyOn(api.workspaces, 'add'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await show()
  expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Routes')
  expect(dom.container.querySelector('[data-settings-field="prepare"]')?.hasAttribute('hidden')).toBe(true)
  expect(dom.container.textContent).toContain('The saved device observation is unavailable.')
  expect(home).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.remote-work-hosts')!.click())
  expect(navigate).toHaveBeenCalledWith('hosts')
})

it('keeps the original work selection and private input across task and visibility changes, then opens that same workface', async () => {
  const original = { ...composerSession('original-work'), hostId: 'worker', control: { ...composerSession('original-work').control, hostId: 'worker' } }
  const draft = { browser: '', note: 'Keep this Note', prompt: 'Keep this input unsent', opaque: { originalOperation: 'retained-operation' } }
  useAppStore.setState({ sessions: [original], agentComposerDrafts: { 'original-region': 'Original authored input' } })
  const launcherBefore = useLauncherState.getState()
  useLauncherState.setState({ drafts: { retained: draft } })
  const select = vi.spyOn(useAppStore.getState(), 'selectSession').mockReturnValue(true)
  try {
    await show(); await task('existing')
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-resource-row="original-work"]')!.click())
    expect(dom.container.querySelector('[data-remote-session]')?.getAttribute('data-remote-session')).toBe('original-work')
    await task('routes'); await show(false); await show(); await task('existing')
    expect(dom.container.querySelector('[data-remote-session]')?.getAttribute('data-remote-session')).toBe('original-work')
    expect(useAppStore.getState().agentComposerDrafts['original-region']).toBe('Original authored input')
    expect(useLauncherState.getState().drafts.retained).toBe(draft)
    expect(select).not.toHaveBeenCalled()
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-remote-open]')!.click())
    expect(select).toHaveBeenCalledOnce(); expect(select).toHaveBeenCalledWith('original-work'); expect(close).toHaveBeenCalledOnce()
  } finally { useLauncherState.setState(launcherBefore, true) }
})
