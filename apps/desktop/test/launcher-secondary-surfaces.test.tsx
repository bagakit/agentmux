// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-warm-preview /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { LauncherMoteAction } from '../src/renderer/src/components/LauncherMoteAction'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), initial = useLauncherState.getState()
beforeEach(async () => { await act(async () => { useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null }); requestPmoTeamsTopicFloatingClose() }) })
afterEach(async () => { await act(async () => useLauncherState.setState(initial, true)) })
async function mount() {
  const tab = createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ tabs: { launcher: tab }, layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }, activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'The complete request\nwith a second line' }, recoveryCandidates: [], warmTerminal: null, detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn(), executorDetections: {} })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
}
async function input(selector: string, value: string) {
  const element = dom.container.querySelector<HTMLInputElement>(selector)!; expect(element).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
function noteEditor() { return dom.container.querySelector<HTMLElement & { editor: Editor }>('.launcher-note-composer .tiptap')!.editor }

describe('actual Launcher utility surfaces', () => {
  it('Browser submits the exact address or search to the existing create action and keeps its draft after failure/close', async () => {
    await mount(); await dom.click('[aria-label="Expand Browser"]'); const browser = vi.fn().mockRejectedValue(new Error('Navigation unavailable')); await act(async () => useAppStore.setState({ createBrowser: browser }))
    await input('[aria-label="Browser address or search"]', 'localhost:4310/path'); await dom.click('[aria-label="Go to Browser address or search"]')
    expect(browser).toHaveBeenCalledWith('group', { tabId: 'launcher', regionId: 'region' }, 'localhost:4310/path'); expect(dom.container.textContent).toContain('Navigation unavailable')
    await dom.click('[aria-label="Close Browser"]'); expect(dom.container.querySelector('[aria-label="Browser address or search"]')).toBeNull()
    await dom.click('[aria-label="Restore Browser"]'); expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')!.value).toBe('localhost:4310/path')
    await input('[aria-label="Browser address or search"]', 'local agent runtime'); await dom.click('[aria-label="Go to Browser address or search"]'); expect(browser).toHaveBeenLastCalledWith('group', { tabId: 'launcher', regionId: 'region' }, 'local agent runtime')
  })
  it('Note edits use the real rich input and save complete Markdown through the existing file create/write owner', async () => {
    await mount(); await dom.click('[aria-label="Expand Note"]'); await act(async () => { noteEditor().commands.insertContent('## Keep this note\nComplete second line') })
    const write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved' }), open = vi.fn().mockResolvedValue(undefined)
    await act(async () => useAppStore.setState({ openFile: open }))
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Save & open note'))!
    await act(async () => button.click())
    expect(write).toHaveBeenCalledWith('workspace', { path: expect.stringMatching(/^note-.*\.md$/), content: '## Keep this note\nComplete second line', expectedRevision: null })
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^note-.*\.md$/), 'group', undefined, 'workspace'); expect(useLauncherState.getState().drafts['region:region'].note).toBe('')
  })
  it('Note save failure and closing preserve the complete original draft', async () => {
    await mount(); await dom.click('[aria-label="Expand Note"]'); await act(async () => { noteEditor().commands.insertContent('Do not lose me\nSecond line') })
    await act(async () => useAppStore.setState({ createNote: vi.fn().mockRejectedValue(new Error('Note write unavailable')) }))
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Save & open note'))!; await act(async () => button.click())
    expect(dom.container.textContent).toContain('Note write unavailable'); await dom.click('[aria-label="Close Note"]'); await dom.click('[aria-label="Restore Note"]'); expect(noteEditor().getText({ blockSeparator: '\n' })).toBe('Do not lose me\nSecond line')
  })
  it('Terminal collapsing/closing never stops the healthy warm Run, and expanding reuses the same original shell', async () => {
    await mount(); const session = { ...composerSession('warm'), kind: 'terminal' as const, providerId: null, control: { kind: 'terminal' as const, hostId: 'local', run: { runId: 'healthy-warm-run' } } }
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    await act(async () => useAppStore.setState({ warmTerminal: { key: warmTerminalKey('local', '/repo'), ownerLauncherId: 'region:region', session, ready: Promise.resolve(session) } }))
    expect(dom.container.querySelector('[data-warm-preview]')).not.toBeNull(); await dom.click('[aria-label="Collapse Terminal"]'); expect(dom.container.querySelector('[data-warm-preview]')).toBeNull()
    await dom.click('[aria-label="Expand Terminal"]'); expect(dom.container.querySelector('[data-warm-preview]')).not.toBeNull(); await dom.click('[aria-label="Close Terminal"]'); await dom.click('[aria-label="Restore Terminal"]')
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('healthy-warm-run'); expect(stop).not.toHaveBeenCalled()
  })
  it('Mote creation delegates through its original Launcher while preserving both drafts and navigation', async () => {
    await mount(); const mote = { ...createWorkbenchTab('mote', { regionId: 'mote-input', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: '/scratch', hostId: 'local', kind: 'scratch' as const }
    await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] }, tabs: { ...useAppStore.getState().tabs, mote }, layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [mote.id]) }, agentComposerDrafts: { region: 'The complete request\nwith a second line', 'mote-input': 'Existing Mote draft' }, openScratchTopic: vi.fn().mockResolvedValue(undefined), refreshScratchTopics: vi.fn().mockResolvedValue(undefined) }))
    const ensure = vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue({} as never), launch = vi.fn().mockResolvedValue(undefined)
    await act(async () => useAppStore.setState({ launchAgent: launch }))
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Create with Mote'))!; expect(button).toBeDefined(); await act(async () => button.click())
    expect(ensure).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID); expect(useAppStore.getState().agentComposerDrafts['mote-input']).toBe('Existing Mote draft')
    expect(dom.draft('region')).toBe('The complete request\nwith a second line'); expect(useAppStore.getState().activeWorkspaceId).toBe('workspace'); expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: 'mote' }); expect(launch).toHaveBeenCalledWith('codex', expect.stringContaining('Project: Project\nHost: local\nWorking directory: /repo\n\nThe complete request\nwith a second line'), 'mote-group', { tabId: 'mote', regionId: 'mote-input' })
  })
  it.each(['ensure', 'open'] as const)('Mote does not write a late %s result after the source project changes', async (waitingFor) => {
    await mount()
    const mote = { ...createWorkbenchTab('mote', { regionId: 'mote-input', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: '/scratch', hostId: 'local', kind: 'scratch' as const }
    const other = { id: 'other', name: 'Another project', path: '/other', hostId: 'local', kind: 'directory' as const }
    let release!: () => void
    const late = new Promise<void>(resolve => { release = resolve })
    const open = vi.fn().mockImplementation(() => waitingFor === 'open' ? late : Promise.resolve())
    await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch, other] }, tabs: { ...useAppStore.getState().tabs, mote }, layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [mote.id]) }, agentComposerDrafts: { region: 'The complete request\nwith a second line', 'mote-input': 'Original Mote draft' }, openScratchTopic: open, refreshScratchTopics: vi.fn().mockResolvedValue(undefined) }))
    vi.spyOn(api.scratch, 'ensureMote').mockImplementation(async () => { if (waitingFor === 'ensure') await late; return {} as never })
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Create with Mote'))!
    await act(async () => button.click())
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, launcher: { ...useAppStore.getState().tabs.launcher, workspaceId: 'other' } } }))
    await act(async () => release())
    expect(useAppStore.getState().agentComposerDrafts['mote-input']).toBe('Original Mote draft')
    expect(dom.draft('region')).toBe('The complete request\nwith a second line')
    expect(readPmoTeamsTopicFloatingState().open).toBe(false)
    expect(open).toHaveBeenCalledTimes(waitingFor === 'ensure' ? 0 : 1)
  })
  it('Mote preparation never writes a different Region of the same target Tab after awaiting', async () => {
    await mount()
    let mote = { ...createWorkbenchTab('mote', { regionId: 'original-mote-input', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    mote = addWorkbenchRegion(mote, 'original-mote-input', 'right', { regionId: 'other-mote-input', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'other-mote-session' }) as typeof mote
    mote = { ...mote, layout: { ...mote.layout, activeRegionId: 'original-mote-input' } }
    const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'No Project', path: '/scratch', hostId: 'local', kind: 'folder' as const }
    let release!: () => void
    const late = new Promise<void>(resolve => { release = resolve })
    await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] }, tabs: { ...useAppStore.getState().tabs, mote }, layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [mote.id]) }, agentComposerDrafts: { region: 'The complete request', 'original-mote-input': 'Original target request', 'other-mote-session': 'Other target request' }, openScratchTopic: vi.fn().mockImplementation(() => late), refreshScratchTopics: vi.fn().mockResolvedValue(undefined) }))
    vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue({} as never)
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Create with Mote'))!
    await act(async () => button.click())
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, mote: { ...mote, layout: { ...mote.layout, activeRegionId: 'other-mote-input' } } } }))
    await act(async () => release())
    expect(useAppStore.getState().agentComposerDrafts).toMatchObject({ region: 'The complete request', 'original-mote-input': 'Original target request', 'other-mote-session': 'Other target request' })
    expect(readPmoTeamsTopicFloatingState().open).toBe(false)
  })

  it('the selected Mote input cannot prepare its own request into itself', async () => {
    await mount()
    const mote = { ...createWorkbenchTab('mote', { regionId: 'mote-input', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'No Project', path: '/scratch', hostId: 'local', kind: 'folder' as const }
    await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] }, tabs: { ...useAppStore.getState().tabs, mote }, layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [mote.id]) }, agentComposerDrafts: { 'mote-input': 'Original coordinator request' }, refreshScratchTopics: vi.fn().mockResolvedValue(undefined) }))
    await dom.render(<NewTabSurface tabGroupId="mote-group" tabId="mote" regionId="mote-input" visible={false} />)
    expect(dom.container.querySelector('.launcher-mote')).toBeNull()
    expect(dom.draft('mote-input')).toBe('Original coordinator request')
  })
  it('Mote output does not add detail work to retained Launcher handoff actions', async () => {
    await mount()
    const mote = { ...createWorkbenchTab('mote', { regionId: 'mote-input', kind: 'agent', phase: 'attached', sessionId: 'mote-session', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'No Project', path: '/scratch', hostId: 'local', kind: 'folder' as const }
    const session = composerSession('mote-session'), paints = vi.fn()
    const recap = (content: string) => ({ agentSessionId: session.id, revision: 1, items: [{ id: 'message', agentSessionId: session.id, kind: 'user_message' as const, status: 'complete' as const, source: 'user' as const, content, createdAt: 1, updatedAt: 1 }] })
    await act(async () => useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] }, tabs: { ...useAppStore.getState().tabs, mote }, layouts: { ...useAppStore.getState().layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [mote.id]) }, sessions: [session], timelines: { [session.id]: recap('Original coordinator task') }, refreshScratchTopics: vi.fn().mockResolvedValue(undefined) }))
    await dom.render(<Profiler id="retained-launcher-handoff" onRender={paints}><LauncherMoteAction workspace={composerConfig.workspaces[0]} prompt="Original project request" sourceTabId="launcher" sourceRegionId="region" /></Profiler>)
    expect(dom.container.querySelector('.launcher-mote')?.textContent).toContain('Create with Mote')
    paints.mockClear()
    await act(async () => useAppStore.setState({ timelines: { [session.id]: recap('New coordinator output') } }))
    await act(async () => useAppStore.setState({ sessions: [{ ...session, latestOutputBytes: 2048 }] }))
    await act(async () => useAppStore.setState({ timelines: { ...useAppStore.getState().timelines, unrelated: recap('Unrelated streaming output') } }))
    expect(paints).not.toHaveBeenCalled()
  })
})
