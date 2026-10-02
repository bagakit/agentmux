import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { launcherResumeRows } from '../src/renderer/src/lib/launcher-resume'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const regionId = 'quality-input', tabId = 'quality-tab'
beforeEach(() => {
  useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, moteTopicId: null })
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace',
    tabs: { [tabId]: createWorkbenchTab(tabId, { regionId, kind: 'launcher', workspaceId: 'workspace' }) },
    layouts: { workspace: createWorkspaceLayout('quality-group', [tabId]) },
    agentComposerDrafts: { [regionId]: 'Keep my complete request' }, launcherNameDrafts: {}, launcherOptionDrafts: {},
    warmTerminal: null, detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn(),
    providerCatalog: [], recoveryCandidates: [], error: null, errorNoticeContext: null })
})
const launcher = () => <NewTabSurface tabGroupId="quality-group" tabId={tabId} regionId={regionId} />

describe('Launcher exact presentation and action targets', () => {
  it('derives actual Mote and Survey defaults without saving a preference or remounting the input', async () => {
    await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, surface: 'space' }}>{launcher()}</WorkbenchPresentationContext.Provider>)
    const editor = dom.container.querySelector('[aria-label="Agent prompt"]')
    expect(dom.container.querySelector('.launch-terminal')?.getAttribute('data-mode')).toBe('expanded')
    for (const surface of ['mote', 'survey'] as const) {
      await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, surface }}>{launcher()}</WorkbenchPresentationContext.Provider>)
      expect(dom.container.querySelector('.launch-terminal')?.getAttribute('data-mode')).toBe('collapsed')
      expect(dom.container.querySelector('[aria-label="Agent prompt"]')).toBe(editor)
      expect(useLauncherState.getState().sections).toEqual({})
      expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Keep my complete request')
    }
    await act(async () => useLauncherState.getState().setSection('workspace', 'terminal', 'expanded'))
    expect(dom.container.querySelector('.launch-terminal')?.getAttribute('data-mode')).toBe('expanded')
    await act(async () => useLauncherState.getState().setSection('workspace', 'terminal', 'hidden'))
    expect(dom.container.querySelector('.launch-terminal')).toBeNull()
    expect(useLauncherState.getState().sections.workspace).toEqual({ terminal: 'hidden' })
  })

  it('returns Agents keyboard focus to the same local expand and restore controls while preserving the draft', async () => {
    await dom.render(launcher())
    const collapse = dom.container.querySelector<HTMLButtonElement>('[aria-label="Collapse Agents"]')!
    collapse.focus()
    await dom.click('[aria-label="Collapse Agents"]')
    expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Expand Agents"]'))
    const close = dom.container.querySelector<HTMLButtonElement>('[aria-label="Close Agents"]')!
    close.focus()
    await dom.click('[aria-label="Close Agents"]')
    expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Restore Agents"]'))
    await dom.click('[aria-label="Restore Agents"]')
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Keep my complete request')
  })

  it('offers the existing Agent settings route when no Executor is configured', async () => {
    useAppStore.setState({ config: { ...composerConfig, executors: {} } })
    const open = vi.fn()
    await dom.render(<SettingsNavigation.Provider value={{ open }}>{launcher()}</SettingsNavigation.Provider>)
    expect(dom.container.querySelector<HTMLButtonElement>('.launcher-launch-button')?.disabled).toBe(true)
    const button = [...dom.container.querySelectorAll('button')].find(item => item.textContent === 'Configure an Agent')!
    await act(async () => button.click())
    expect(open).toHaveBeenCalledExactlyOnceWith('agents')
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Keep my complete request')
  })

  it('keeps a late file-picker reply out of a different input owner', async () => {
    let resolve!: (paths: string[]) => void
    vi.spyOn(api.ui, 'chooseFiles').mockImplementation(() => new Promise(done => { resolve = done }))
    await dom.render(launcher())
    const editor = dom.container.querySelector('.tiptap')
    await dom.click('[aria-label="Reference files for the Agent"]')
    await act(async () => useAppStore.getState().setAgentComposerDraft('other-input', 'Other complete request'))
    await dom.render(<NewTabSurface tabGroupId="quality-group" tabId={tabId} regionId="other-input" />)
    expect(dom.container.querySelector('.tiptap')).toBe(editor)
    await act(async () => resolve([_hygiene_fixturePath("repo/previous-target.ts")]))
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Keep my complete request')
    expect(useAppStore.getState().agentComposerDrafts['other-input']).toBe('Other complete request')
  })

  it.each([false, true])('attributes an old archived Restore failure after retarget, late reply=%s', async late => {
    const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' as const }
    const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Main Mote', directoryPath: 'main', topicPath: 'main/topic.md', summary: '', collaborators: [],
      soul: { path: 'main/SOUL.md', content: 'Help', version: 's1' }, moteArchive: { state: 'active' as const, version: 'a1' } }
    const archived = { ...topic, id: 'quality:archived', title: 'Archived reviewer', directoryPath: 'archived', moteArchive: { state: 'archived' as const, version: 'r1' } }
    useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] },
      scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', _hygiene_fixturePath("scratch")]), revision: 0, reading: false, error: null, topics: [topic, archived] } } })
    useLauncherState.getState().selectMote(archived.id)
    let reject!: (cause: Error) => void
    vi.spyOn(useAppStore.getState(), 'setMoteArchived').mockImplementation(() => new Promise((_done, fail) => { reject = fail }))
    await dom.render(launcher())
    expect(dom.container.querySelector('.launcher-mote__archive')?.textContent).toContain('You can still create')
    expect(dom.container.querySelector<HTMLButtonElement>('.launcher-mote__create')?.disabled).toBe(false)
    await dom.click('.launcher-mote__archive button')
    if (late) await act(async () => useLauncherState.getState().selectMote(topic.id))
    await act(async () => reject(new Error('Restore denied for the archived reviewer')))
    if (!late) await act(async () => useLauncherState.getState().selectMote(topic.id))
    expect(dom.container.querySelector('.launcher-mote__target')?.textContent).toBe('Main Mote')
    expect(dom.container.querySelector('.launcher-mote__archive')).toBeNull()
    expect(dom.container.querySelector('.launcher-mote')?.textContent).toContain('Restore for Archived reviewer was not confirmed')
    expect(dom.container.querySelector('.launcher-mote')?.textContent).not.toContain('Main Mote archive state is unconfirmed')
    expect(dom.container.querySelector<HTMLButtonElement>('.launcher-mote__create')?.disabled).toBe(false)
  })

  it('presents running and saved recovery facts without native hook or Runtime implementation terms', () => {
    const session = composerSession('running-session')
    session.status.detail = 'PreToolUse'
    const candidate = { agentSessionId: session.id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: 'Saved work', updatedAt: 1 }
    const rows = launcherResumeRows({ candidates: [candidate] as any, config: composerConfig, workspace: composerConfig.workspaces[0], timelines: {}, agentNames: {}, sessions: [session], nativeRecaps: {} })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.stateLabel).toBe('Running')
    expect(rows[0]!.stateDetail).toContain('process is running')
    expect(rows[0]!.stateDetail).not.toMatch(/PreToolUse|Runtime|Run\b|Core/)
    const saved = launcherResumeRows({ candidates: [candidate] as any, config: composerConfig, workspace: composerConfig.workspaces[0], timelines: {}, agentNames: {}, sessions: [], nativeRecaps: {} })
    expect(saved[0]!.stateDetail).toContain('check its connection')
  })
})
