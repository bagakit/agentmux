// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose, requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

// Native pixels belong to the Renderer visual scene; the real Launcher retains this exact Session.
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session }: { session: { id: string } }) => <div data-terminal-session={session.id} />
}))

const dom = composerDOM()
const launcherBefore = useLauncherState.getState()
const tabId = 'space-launcher', regionId = 'space-input', groupId = 'space-group'
const prompt = 'Keep the complete task\nAnd its second line'
const target = { tabId, regionId }
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: fixturePath('space-topics'), kind: 'folder' as const }
const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Project Mote', directoryPath: 'mote', topicPath: 'mote/topic.md', summary: '', collaborators: [],
  soul: { path: 'mote/SOUL.md', content: 'Help with the project', version: 'soul' } }

beforeEach(async () => {
  await act(async () => {
    useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, moteTopicId: null, persistenceIssue: null })
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id, targetTabId: 'mote-tab' })
    requestPmoTeamsTopicFloatingClose()
    useAppStore.setState({
      config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] },
      activeWorkspaceId: 'workspace', tabs: { [tabId]: createWorkbenchTab(tabId, { regionId, kind: 'launcher', workspaceId: 'workspace' }) },
      layouts: { workspace: createWorkspaceLayout(groupId, [tabId]) },
      agentComposerDrafts: { [regionId]: prompt }, launcherNameDrafts: {}, launcherOptionDrafts: {},
      agentSteerQueues: {}, warmTerminals: {}, recoveryCandidates: [], executorDetections: {}, hostChecks: {},
      providerCatalog: [{ id: 'codex', launchOptions: [{ id: 'mode', label: 'Mode', choices: [{ id: 'review', label: 'Review mode' }] }] }] as never,
      scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify([scratch.hostId, scratch.path]), revision: 0, reading: false, error: null, topics: [topic] } },
      detectExecutors: vi.fn().mockResolvedValue(undefined), prewarmTerminal: vi.fn(),
      refreshScratchTopics: vi.fn().mockResolvedValue(undefined), openScratchTopic: vi.fn().mockResolvedValue(undefined),
      flushAgentSteerQueue: vi.fn().mockResolvedValue(undefined), pendingAgentLaunches: {}, error: null, errorNoticeContext: null
    })
  })
})
afterEach(async () => { await act(async () => useLauncherState.setState(launcherBefore, true)) })

const launcher = () => <NewTabSurface tabGroupId={groupId} tabId={tabId} regionId={regionId} />
function promptEditor() {
  const element = dom.container.querySelector<HTMLElement & { editor: Editor }>('.launcher-composer .tiptap')
  expect(element).not.toBeNull()
  return element!.editor
}
async function writeInput(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function closeOptions() {
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close launch options"]')
  expect(close).not.toBeNull()
  await act(async () => close!.click())
}
async function addMote() {
  await act(async () => {
    const mote = { ...createWorkbenchTab('mote-tab', { regionId: 'mote-region', kind: 'agent', phase: 'attached', workspaceId: scratch.id, sessionId: 'mote-agent' }), topicId: topic.id }
    useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [mote.id]: mote },
      layouts: { ...useAppStore.getState().layouts, [scratch.id]: createWorkspaceLayout('mote-group', [mote.id]) },
      sessions: [composerSession('mote-agent')],
      agentComposerDrafts: { ...useAppStore.getState().agentComposerDrafts, 'mote-agent': 'Independent Mote draft' } })
    vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue({} as never)
    vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  })
}

describe('the shared Space Launcher through its original consumers', () => {
  it('hosts a writable form in SurfaceState without announcing the entire input as status', async () => {
    await dom.render(launcher())
    const surface = dom.container.querySelector('.launch-surface.surface-state')
    expect(surface).not.toBeNull()
    const body = surface!.querySelector(':scope > .surface-state__content > .surface-state__body')
    expect(body).not.toBeNull()
    expect(body!.querySelector('.launcher-composer')).not.toBeNull()
    expect(body!.querySelector('.launcher-launch-button')).not.toBeNull()
    expect(body!.querySelector('.launcher-environment__host [data-semantic-icon="object.host"]')).not.toBeNull()
    expect(body!.querySelector('.launcher-environment__host [data-semantic-icon="object.terminal"]')).toBeNull()
    const input = dom.container.querySelector('[aria-label="Agent prompt"]')!
    expect(input.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
    await act(async () => promptEditor().commands.setContent('<p>Edited task</p><p>Complete second line</p>'))
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Edited task\nComplete second line')
    await dom.click('[aria-label="Launch options"]')
    expect(dom.container.querySelector('[aria-label="Agent prompt"]')).toBe(input)
    await closeOptions()
    await dom.click('[aria-label="Collapse Agents"]')
    await dom.click('[aria-label="Expand Agents"]')
    expect(promptEditor().getText({ blockSeparator: '\n' })).toBe('Edited task\nComplete second line')
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Edited task\nComplete second line')
  })

  it('submits the original target and Provider choices through the real launch owner and keeps every input after a confirmed refusal', async () => {
    const other = { ...composerConfig.workspaces[0]!, id: 'other-space', name: 'Other project', path: fixturePath('other-space') }
    useAppStore.setState({ config: { ...useAppStore.getState().config!, workspaces: [...useAppStore.getState().config!.workspaces, other] }, activeWorkspaceId: other.id })
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Object.assign(new Error('Original launch was not applied'), {
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
    }))
    await dom.render(launcher())
    await dom.click('[aria-label="Launch options"]')
    await writeInput('[aria-label="Agent name"]', 'Task reviewer')
    await writeInput('[aria-label="Tab name"]', 'Project review')
    const mode = document.querySelector<HTMLButtonElement>('.selection-field[aria-label="Mode"]')
    expect(mode).not.toBeNull()
    await act(async () => mode!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false })))
    const choice = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="review"]')
    expect(choice).not.toBeNull()
    await act(async () => choice!.click())
    expect(useAppStore.getState().launcherOptionDrafts[regionId]).toEqual({ codex: { mode: 'review' } })
    await closeOptions()
    await dom.click('.launcher-launch-button')
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      hostId: composerConfig.workspaces[0]!.hostId, workspacePath: composerConfig.workspaces[0]!.path,
      prompt, executorId: 'codex', launchOptions: { mode: 'review' }
    }), undefined)
    expect(useAppStore.getState().tabs[tabId]?.regions[regionId]).toMatchObject({ kind: 'launcher', workspaceId: 'workspace' })
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe(prompt)
    expect(useAppStore.getState().launcherNameDrafts[regionId]).toEqual({ agentName: 'Task reviewer', tabName: 'Project review' })
    expect(useAppStore.getState().launcherOptionDrafts[regionId]).toEqual({ codex: { mode: 'review' } })
    expect(dom.container.textContent).toContain('Original launch was not applied')
  })

  it.each(['', '   '])('an empty Mote request opens the selected original conversation without submitting: %j', async draft => {
    await addMote()
    useAppStore.getState().setAgentComposerDraft(regionId, draft)
    const send = vi.spyOn(useAppStore.getState(), 'send'), launch = vi.spyOn(api.sessions, 'launchAgent')
    await dom.render(launcher())
    expect(dom.container.querySelector('.launcher-mote__create')?.textContent).toBe('Discuss with')
    await dom.click('.launcher-mote__create')
    expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTopicId: topic.id, targetTabId: 'mote-tab' })
    expect(api.scratch.ensureMote).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe(draft)
    expect(useAppStore.getState().agentComposerDrafts['mote-agent']).toBe('Independent Mote draft')
  })

  it('a complete Mote request queues once through the original input owner and preserves both drafts', async () => {
    await addMote()
    await dom.render(launcher())
    expect(dom.container.querySelector('.launcher-mote__create')?.textContent).toBe('Discuss with')
    await dom.click('.launcher-mote__create')
    const queue = useAppStore.getState().agentSteerQueues['mote-agent']
    expect(queue).toHaveLength(1)
    expect(queue![0]).toMatchObject({ runId: 'run-mote-agent', origin: 'manual' })
    expect(queue![0]!.text).toContain(`Project: Project\nHost: local\nWorking directory: ${composerConfig.workspaces[0]!.path}\n\n${prompt}`)
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe(prompt)
    expect(useAppStore.getState().agentComposerDrafts['mote-agent']).toBe('Independent Mote draft')
    expect(dom.container.querySelector('.launcher-mote__create')?.textContent).toBe('Request queued')
    await dom.click('.launcher-mote__create')
    expect(useAppStore.getState().agentSteerQueues['mote-agent']).toHaveLength(1)
    expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTopicId: topic.id, targetTabId: 'mote-tab' })
  })

  it('rehydrates explicit utility preferences and keeps Terminal, Browser and Note actions on the original Launcher', async () => {
    const saved = { sections: { workspace: { terminal: 'expanded', browser: 'expanded', note: 'hidden' } },
      drafts: { [`region:${regionId}`]: { browser: 'Saved project search', note: 'Independent note draft' } }, executors: {} }
    window.localStorage.setItem('agentmux-launcher', JSON.stringify({ state: saved, version: 0 }))
    await act(async () => useLauncherState.persist.rehydrate())
    const session = { ...composerSession('original-shell'), kind: 'terminal' as const, providerId: null,
      control: { kind: 'terminal' as const, hostId: 'local', runId: 'original-shell-run', run: { runId: 'original-shell-run' } } }
    const key = warmTerminalKey('local', composerConfig.workspaces[0]!.path)
    const promote = vi.fn().mockResolvedValue(undefined), browser = vi.fn().mockResolvedValue(undefined)
    const note = vi.fn().mockResolvedValue({ status: 'written', revealed: false })
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    useAppStore.setState({ warmTerminals: { [key]: [{ key, ownerLauncherId: `region:${regionId}`, session, ready: Promise.resolve(session) }] },
      promoteWarmTerminal: promote, createBrowser: browser, createNote: note })
    await dom.render(launcher())
    expect(dom.container.querySelector('[data-terminal-session]')?.getAttribute('data-terminal-session')).toBe('original-shell')
    expect(dom.container.querySelector('.launch-terminal .launcher-utility__head strong')?.textContent).toBe('Terminal')
    expect(dom.container.querySelector('.launch-terminal .launcher-utility__head small')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Restore Note"]')).not.toBeNull()
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')?.value).toBe('Saved project search')
    expect(useLauncherState.getState().sections).toEqual(saved.sections)
    await dom.click('[aria-label="Open reusable Terminal in tab"]')
    expect(promote).toHaveBeenCalledExactlyOnceWith(groupId, target)
    await dom.click('[aria-label="Go to Browser address or search"]')
    expect(browser).toHaveBeenCalledExactlyOnceWith(groupId, target, 'Saved project search')
    await dom.click('[aria-label="Restore Note"]')
    expect(dom.container.querySelector('.launcher-note-composer .tiptap')?.textContent).toBe('Independent note draft')
    await dom.click('[aria-label="Save and open note draft"]')
    expect(note).toHaveBeenCalledExactlyOnceWith(groupId, target, 'Independent note draft', undefined)
    await dom.click('[aria-label="Collapse Terminal"]')
    await dom.click('[aria-label="Expand Terminal"]')
    expect(useAppStore.getState().warmTerminals[key]![0]!.session).toBe(session)
    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe(prompt)
    expect(useLauncherState.getState().drafts[`region:${regionId}`]).toMatchObject(saved.drafts[`region:${regionId}`])
  })
})
