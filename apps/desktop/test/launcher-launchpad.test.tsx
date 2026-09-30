// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore, executorDetectionKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const initial = useLauncherState.getState()
beforeEach(async () => { await act(async () => useLauncherState.setState({ sections: { workspace: { agents: 'expanded' } }, drafts: {}, executors: {}, persistenceIssue: null })) })
afterEach(async () => { window.localStorage.setItem('agentmux-launcher', JSON.stringify({ state: { sections: {}, drafts: {}, executors: {} }, version: 0 })); await act(async () => { await useLauncherState.persist.rehydrate(); useLauncherState.setState(initial, true) }) })
async function mount(state: 'ready' | 'error' | 'missing' = 'ready') {
  const host = composerConfig.hosts[0]!, executor = composerConfig.executors.codex!
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'another-project', agentComposerDrafts: { region: 'Preserve the full request\nincluding this second line.' },
    executorDetections: { [executorDetectionKey('local', 'codex')]: { state, input: { executorId: 'codex', providerId: 'codex', command: executor.command, host } } }, recoveryCandidates: [] })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
}

describe('actual Launcher work start', () => {
  it('anchors the real bound workspace, host and directory without welcome copy or fabricated connection', async () => {
    await mount(); const environment = dom.container.querySelector('.launcher-environment')!
    expect(environment.textContent).toContain('Project'); expect(environment.textContent).toContain('This Mac'); expect(environment.textContent).toContain('/repo'); expect(environment.textContent).not.toContain('Ready'); await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={true} />); await dom.click('[aria-label="Runtime environment"]'); expect(document.querySelector('.launcher-environment__panel')?.textContent).toContain('Not tested'); await act(async () => (document.querySelector('[aria-label="Close runtime environment"]') as HTMLButtonElement).click())
    expect(dom.container.textContent).not.toContain('Available Agents'); expect(dom.container.textContent).not.toContain('New session')
    expect(dom.container.querySelector('.agent-pick[aria-pressed="true"] strong')?.textContent).toBe('Codex')
    expect(dom.container.querySelector('[aria-label="Agent name"]')).toBeNull()
  })
  it('discovery failure is a visible unconfirmed state while the actual launch remains usable', async () => {
    await mount('error'); const launch = vi.fn().mockResolvedValue(undefined); await act(async () => useAppStore.setState({ launchAgent: launch }))
    expect(dom.container.textContent).toContain('Agent availability check is unconfirmed')
    const button = dom.container.querySelector<HTMLButtonElement>('.primary-button')!; expect(button.disabled).toBe(false)
    await act(async () => button.click()); expect(launch).toHaveBeenCalledWith('codex', 'Preserve the full request\nincluding this second line.', 'group', { tabId: 'launcher', regionId: 'region' }, {}, { agentName: undefined, tabName: undefined })
  })
  it('only confirmed missing commands disable launch', async () => { await mount('missing'); expect(dom.container.querySelector<HTMLButtonElement>('.primary-button')!.disabled).toBe(true); expect(dom.container.textContent).toContain('not found') })
  it('collapse and close retain the same selected Agent and complete draft, then restore an editable input', async () => {
    await mount(); await dom.click('[aria-label="Collapse Agents"]'); expect(dom.container.querySelector('.launcher-composer')).toBeNull(); expect(dom.container.textContent).toContain('Preserve the full request'); expect(dom.container.querySelector('.primary-button')).toBeNull(); expect(dom.container.querySelector('.launcher-resume-trigger')).not.toBeNull()
    await dom.click('[aria-label="Close Agents"]'); expect(dom.container.querySelector('[aria-label="Launch options"]')).toBeNull(); expect(dom.container.querySelector('.launcher-restore')?.textContent).toContain('Codex')
    await dom.click('.launcher-restore'); expect(dom.draft('region')).toBe('Preserve the full request\nincluding this second line.')
    const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!.editor
    await act(async () => { editor.commands.insertContent('Edited ') }); expect(dom.draft('region')).toContain('Edited ')
    expect(JSON.parse(window.localStorage.getItem('agentmux-launcher')!).state.sections.workspace.agents).toBe('expanded')
  })
  it('malformed durable preferences remain byte-for-byte present and the usable UI announces unsaved state', async () => {
    const saved = '{broken durable user bytes'; window.localStorage.setItem('agentmux-launcher', saved)
    await act(async () => { await useLauncherState.persist.rehydrate() }); await mount(); await dom.click('[aria-label="Collapse Agents"]')
    expect(window.localStorage.getItem('agentmux-launcher')).toBe(saved); expect(dom.container.textContent).toContain('Saved Launcher preferences could not be read'); expect(dom.draft('region')).toContain('second line')
    await dom.click('[aria-label="Expand Note"]')
    const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.launcher-note-composer .tiptap')!.editor
    await act(async () => { editor.commands.insertContent('New unsaved note after the failed read') })
    expect(useLauncherState.getState().drafts['region:region']!.note).toBe('New unsaved note after the failed read')
    expect(window.localStorage.getItem('agentmux-launcher')).toBe(saved)
    expect(dom.container.textContent).toContain('Copy any new drafts before reopening this window')
    expect(dom.container.textContent).not.toContain('edit the draft to retry saving')
  })
  it('a confirmed successful write clears the old write-failure notice from the single persistence owner', async () => {
    await mount()
    const blocked = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage quota unavailable') })
    await dom.click('[aria-label="Collapse Agents"]')
    expect(dom.container.textContent).toContain('Launcher preferences could not be saved')
    expect(dom.draft('region')).toContain('second line')
    blocked.mockRestore()
    await dom.click('[aria-label="Expand Agents"]')
    expect(useLauncherState.getState().persistenceIssue).toBeNull()
    expect(dom.container.textContent).not.toContain('Launcher preferences could not be saved')
    expect(JSON.parse(window.localStorage.getItem('agentmux-launcher')!).state.sections.workspace.agents).toBe('expanded')
  })
})
