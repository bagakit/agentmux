// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { useAppStore } from '../src/renderer/src/store'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { allStyleRules } from './helpers/styles'
import { createMoteApp, moteClick, motePointer, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customAgent, customMoteId, customTab, defaultAgent, defaultTab, executionAgent, moteTopics, ordinaryTopicId, quietMoteId, savedMoteKey, scratchWorkspace } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })
function toggle() {
  const found = app.panel().querySelector<HTMLButtonElement>('[aria-label="Show Mote avatars only"]')
  expect(found).not.toBeNull(); return found!
}
function choices() { return Array.from(app.panel().querySelectorAll<HTMLButtonElement>('[data-mote-topic-id]')) }
function choice(id: string) { const found = choices().find(button => button.dataset.moteTopicId === id); expect(found).toBeDefined(); return found! }
function mode(value: 'cards' | 'avatars') {
  expect(app.panel().dataset.moteNavigation).toBe(value)
  expect(toggle().getAttribute('aria-pressed')).toBe(String(value === 'avatars'))
}

describe('actual Mote navigation rail and original Workbench', () => {
  it('presents every real Mote with its own full identity and status in both modes', async () => {
    await app.mount(); await app.hover(); mode('cards')
    expect(choices().map(button => button.dataset.moteTopicId)).toEqual([PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId])
    expect(choices().find(button => button.dataset.moteTopicId === ordinaryTopicId)).toBeUndefined()
    expect(choice(PMO_TEAMS_TOPIC_ID).getAttribute('aria-pressed')).toBe('true')
    expect(choice(PMO_TEAMS_TOPIC_ID).dataset.moteTargetTab).toBe(defaultTab.id)
    expect(choice(customMoteId).dataset.moteTargetTab).toBe(customTab.id)
    expect(choice(customMoteId).dataset.moteStatus).toBe('Needs reply')
    expect(choice(quietMoteId).dataset.moteStatus).toBe('No Agent yet')
    expect(choice(quietMoteId).querySelector('[data-mote-availability="no-agent"] svg')).not.toBeNull()
    const graph = app.panel().querySelector('.mote-chooser')!
    expect(graph.parentElement).toBe(app.panel())
    expect(app.panel().querySelector('.pmo-teams-topic-floating__content')?.querySelectorAll('.workspace-workbench')).toHaveLength(1)
    await moteClick(toggle()); mode('avatars')
    for (const topic of moteTopics.filter(topic => topic.soul)) {
      const button = choice(topic.id), label = topic.title + ' · ' + button.dataset.moteStatus
      expect(button.getAttribute('aria-label')).toBe(label); expect(button.hasAttribute('title')).toBe(false)
      expect(button.querySelector('.mote-chooser__name img, .space-object-icon')).not.toBeNull()
    }
    const icon = topicSpaceIconTarget(scratchWorkspace, moteTopics.find(topic => topic.id === customMoteId)!)
    await act(async () => useAppStore.setState({ spaceObjectIcons: { [icon.key]: 'compass' } }))
    expect(choice(customMoteId).querySelector('[data-space-icon="compass"]')).not.toBeNull()
    await moteClick(choice(customMoteId))
    expect(choice(customMoteId).getAttribute('aria-pressed')).toBe('true')
    expect(app.panel().dataset.moteTargetTopic).toBe(customMoteId)
    expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
  })

  it('shows the full current avatar identity on hover and keyboard focus without a second native title', async () => {
    await app.mount(); await app.hover(); await moteClick(toggle()); mode('avatars')
    const button = choice(customMoteId), label = button.getAttribute('aria-label')!
    expect(label).toContain('Analyst with a long persistent name'); expect(label).toContain('Needs reply')
    expect(button.hasAttribute('title')).toBe(false)
    await motePointer(button, 'over'); await settleMoteApp()
    expect(app.panel().querySelector('.mote-chooser__identity[role="tooltip"]')?.textContent).toBe(label)
    await motePointer(button, 'out'); await settleMoteApp()
    expect(app.panel().querySelector('.mote-chooser__identity')).toBeNull()
    await act(async () => button.focus()); await settleMoteApp()
    expect(app.panel().querySelector('.mote-chooser__identity')?.textContent).toBe(label)
    await act(async () => {
      const state = useAppStore.getState(), snapshot = state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!
      useAppStore.setState({
        sessions: state.sessions.map(session => session.id === customAgent.id ? { ...customAgent, status: { ...customAgent.status, state: 'running' } } : session),
        workspaceFileRevisions: { ...state.workspaceFileRevisions, [SCRATCH_WORKSPACE_ID]: 1 },
        scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [SCRATCH_WORKSPACE_ID]: { ...snapshot, revision: 1,
          topics: snapshot.topics!.map(topic => topic.id === customMoteId ? { ...topic, title: 'Renamed Analyst identity' } : topic) } }
      })
    })
    await settleMoteApp()
    expect(app.panel().querySelector('.mote-chooser__identity')?.textContent).toBe(button.getAttribute('aria-label'))
    expect(app.panel().querySelector('.mote-chooser__identity')?.textContent).toBe('Renamed Analyst identity · Status unknown')
    expect(button.dataset.moteStatus).toBe('Status unknown')
  })

  it.each(['pointer', 'keyboard'] as const)('shows a wide card identity only when its actual name is truncated, using %s', async via => {
    await app.mount(); await app.hover(); mode('cards')
    const button = choice(customMoteId), name = button.querySelector<HTMLElement>('.mote-chooser__name > strong')!
    expect(name).not.toBeNull()
    // Supply the DOM layout boundary absent from happy-dom; actual Chromium
    // visual acceptance measures these same original name nodes independently.
    Object.defineProperties(name, { scrollWidth: { configurable: true, value: 300 }, clientWidth: { configurable: true, value: 90 } })
    if (via === 'pointer') await motePointer(button, 'over')
    else await act(async () => button.focus())
    await settleMoteApp()
    expect(app.panel().querySelector('.mote-chooser__identity')?.textContent).toBe(button.getAttribute('aria-label'))
    if (via === 'pointer') await motePointer(button, 'out')
    else await act(async () => button.blur())
    Object.defineProperty(name, 'scrollWidth', { configurable: true, value: 80 })
    if (via === 'pointer') await motePointer(button, 'over')
    else await act(async () => button.focus())
    await settleMoteApp()
    expect(app.panel().querySelector('.mote-chooser__identity')).toBeNull()
  })

  it('changes only the UI preference in a pinned surface and retains original input, draft, selection and owners', async () => {
    await app.mount(); await app.hover(); await moteClick(choice(customMoteId))
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); await moteType(input, 'Original Analyst draft with selection')
    const before = useAppStore.getState(), ensureCalls = app.ensureMote.mock.calls.length, directoryReads = app.listTopics.mock.calls.length
    const range = document.createRange(); range.selectNodeContents(input); range.collapse(false)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const anchorNode = selection.anchorNode, anchorOffset = selection.anchorOffset
    const view = input.closest('.retained-workbench-view')!
    await moteClick(toggle()); mode('avatars')
    await moteClick(toggle()); mode('cards')
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(input.closest('.retained-workbench-view')).toBe(view)
    expect(input.textContent).toBe('Original Analyst draft with selection')
    expect(selection.anchorNode).toBe(anchorNode); expect(selection.anchorOffset).toBe(anchorOffset)
    expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
    expect(app.panel().dataset.moteTargetSession).toBe(customAgent.id)
    const after = useAppStore.getState()
    expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
    expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(after.agentFocus).toBe(before.agentFocus); expect(after.viewModes).toBe(before.viewModes)
    expect(after.agentSteerQueues).toBe(before.agentSteerQueues); expect(after.sessions).toBe(before.sessions)
    expect(app.ensureMote.mock.calls).toHaveLength(ensureCalls); expect(app.listTopics.mock.calls).toHaveLength(directoryReads)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
    expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
  })

  it('pins a preview once on explicit toggle and restores its preference and exact target from the same UI owner', async () => {
    await app.mount(); const stored = window.localStorage.getItem(savedMoteKey)
    const before = useAppStore.getState()
    await app.hover(); mode('cards')
    expect(window.localStorage.getItem(savedMoteKey)).toBe(stored)
    expect(app.ensureMote).not.toHaveBeenCalled()
    await moteClick(toggle()); mode('avatars')
    expect(app.panel().dataset.motePresentation).toBe('pinned')
    expect(app.ensureMote).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
    const durable = JSON.parse(window.localStorage.getItem(savedMoteKey)!)
    expect(durable).toEqual({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, railMode: 'avatars' })
    expect(durable.preview).toBeUndefined()
    await moteClick(app.panel().querySelector<HTMLButtonElement>('[aria-label="Close Mote"]')!)
    await app.hover(); mode('avatars')
    await moteClick(app.entry()); await app.remount(); mode('avatars')
    expect(app.panel().dataset.motePresentation).toBe('pinned')
    expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
    expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(useAppStore.getState().agentSteerQueues).toBe(before.agentSteerQueues)
    expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
  })

  it('keeps restoring and no-Agent shapes distinct when names are hidden', async () => {
    const { [defaultTab.id]: _tab, ...tabs } = useAppStore.getState().tabs
    useAppStore.setState({ tabs })
    window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, railMode: 'avatars' }))
    await app.mount(); await app.hover(); mode('avatars')
    const restoring = choice(PMO_TEAMS_TOPIC_ID), empty = choice(quietMoteId)
    expect(restoring.dataset.moteStatus).toBe('Restoring context')
    expect(restoring.querySelector('[data-mote-availability="restoring"]')?.textContent).toBe('?')
    expect(empty.querySelector('[data-mote-availability="no-agent"] svg')).not.toBeNull()
    expect(restoring.getAttribute('aria-label')).toContain('Restoring context'); expect(empty.getAttribute('aria-label')).toContain('No Agent yet')
    expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBeNull()
    expect(app.warm).not.toHaveBeenCalled(); expect(app.ensureMote).not.toHaveBeenCalled()
  })

  it('does not rescan Tabs or reread the directory for 35 unrelated output updates in either mode', async () => {
    const tabs = useAppStore.getState().tabs, values = Object.values
    let scans = 0
    vi.spyOn(Object, 'values').mockImplementation((value: object) => {
      if (value === tabs && new Error().stack?.includes('pmoTeamsTopicFloatingTargetTabId')) scans++
      return values(value)
    })
    await app.mount(); await app.hover(); await moteClick(toggle())
    const before = useAppStore.getState(), initialScans = scans, directoryReads = app.listTopics.mock.calls.length
    expect(initialScans).toBeGreaterThan(0)
    const choiceNode = choice(customMoteId), input = app.panel().querySelector('[aria-label="Message Agent"]')
    expect(input).not.toBeNull()
    for (let index = 0; index < 35; index++) await act(async () => {
      useAppStore.setState({
        sessions: useAppStore.getState().sessions.map(session => session.id === executionAgent.id ? { ...session, latestOutputBytes: index * 4096 } : session),
        timelines: { [executionAgent.id]: { agentSessionId: executionAgent.id, revision: index, items: [] } },
        agentNames: { ...before.agentNames, [executionAgent.id]: 'output-' + index }
      })
    })
    expect(scans).toBe(initialScans)
    expect(app.listTopics.mock.calls).toHaveLength(directoryReads)
    expect(choice(customMoteId)).toBe(choiceNode)
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
    expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    await act(async () => useAppStore.setState({ tabs: { ...before.tabs, [customTab.id]: { ...customTab, name: 'Related rename' } } }))
    expect(choice(customMoteId).dataset.moteTargetTab).toBe(customTab.id)
    // The same resolver remains live when its actual navigation inputs change.
    // Count the current Tab object rather than giving a changed map a free pass.
    const currentTabs = useAppStore.getState().tabs
    let relatedScans = 0
    vi.mocked(Object.values).mockImplementation((value: object) => {
      if (value === currentTabs && new Error().stack?.includes('pmoTeamsTopicFloatingTargetTabId')) relatedScans++
      return values(value)
    })
    await moteClick(choice(customMoteId))
    expect(relatedScans).toBeGreaterThan(0)
    expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
  })

  it('keeps the identity above the original workface and restores the same Composer rows only when its body is narrow', async () => {
    await app.mount(); await app.hover(); mode('cards')
    const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull()
    const composer = input.closest('.composer')!, toolbar = composer.querySelector('.composer__toolbar')!
    expect(toolbar).not.toBeNull(); expect(composer.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe('collapsed')
    const controls = Array.from(toolbar.querySelectorAll('button'))
    expect(controls.length).toBeGreaterThan(3)
    const rules = allStyleRules(), blocks = [...rules.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    const tip = blocks.filter(match => match[1]!.trim() === '.mote-chooser__identity')
    expect(tip).toHaveLength(1); expect(tip[0]![2]).toContain('z-index: var(--layer-tooltip)')
    const layers = [...rules.matchAll(/--layer-tooltip:\s*(\d+)\s*;/g)]
    expect(layers.length).toBeGreaterThan(0); expect(Number(layers[0]![1])).toBeGreaterThan(37)
    const content = blocks.filter(match => match[1]!.trim() === '.pmo-teams-topic-floating__content')
    expect(content).toHaveLength(1); expect(content[0]![2]).toContain('container-type: inline-size')
    const name = content[0]![2].match(/container-name:\s*([\w-]+)\s*;/)
    expect(name).not.toBeNull()
    const query = new RegExp('@container\\s+' + name![1] + '\\s*\\(max-width:\\s*(\\d+)px\\)\\s*\\{')
    const found = [...rules.matchAll(new RegExp(query.source, 'g'))]
    expect(found).toHaveLength(1); expect(Number(found[0]![1])).toBe(320)
    const start = rules.search(query), end = rules.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
    const narrow = rules.slice(start, end + 2)
    expect(narrow).toContain(".pmo-teams-topic-floating .composer:has(.composer-tools[data-mode='collapsed']) { display: block; }")
    expect(narrow).toContain(".pmo-teams-topic-floating .composer:has(.composer-tools[data-mode='collapsed']) .composer__toolbar { display: flex; }")
    expect(narrow).not.toContain('display: none'); expect(narrow).not.toContain('grid-template-columns')
    await moteType(input, 'The same original draft remains readable')
    expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(input)
    expect(composer.querySelector('.composer__toolbar')).toBe(toolbar)
    expect(Array.from(toolbar.querySelectorAll('button'))).toEqual(controls)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('The same original draft remains readable')
    mode('cards')
  })

  it('uses a bounded vertical rail and retains the explicit mode under narrow CSS', async () => {
    await app.mount(); await app.hover(); await moteClick(toggle()); mode('avatars')
    const rules = allStyleRules()
    const rail = [...rules.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(match => match[1]!.trim() === '.mote-chooser__choices')
    expect(rail).toHaveLength(1)
    expect(rail[0]![2]).toContain('flex-direction: column')
    expect(rail[0]![2]).toContain('overflow-y: auto'); expect(rail[0]![2]).toContain('min-height: 0')
    const floatingStart = rules.indexOf('.pmo-teams-topic-floating')
    expect(floatingStart).toBeGreaterThan(-1)
    const narrowStart = rules.indexOf('@media (max-width: 560px)', floatingStart)
    expect(narrowStart).toBeGreaterThan(-1)
    const narrowRail = rules.slice(narrowStart).match(/\.pmo-teams-topic-floating\[data-mote-navigation="cards"\] \.mote-chooser\s*\{([^}]+)\}/)
    expect(narrowRail).not.toBeNull(); expect(narrowRail![1]).toContain('flex-basis: 136px')
    await motePointer(app.panel(), 'out'); await settleMoteApp(); mode('avatars')
    expect(app.panel().dataset.motePresentation).toBe('pinned')
  })
})
