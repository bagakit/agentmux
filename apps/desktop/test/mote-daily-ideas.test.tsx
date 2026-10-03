import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, ContinuousProgressLoop, FileDocument, FileReadParams, FileReadResult, ScheduleParamsMap } from '@agentmux/core'
import type { Demand } from '@agentmux/demand'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborTab, customMoteId, customTab, scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { prepareMoteIdeaDraft, prepareMoteIdeaSchedule } from '../src/renderer/src/lib/mote-idea-request'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { MoteIdeaControls } from '../src/renderer/src/components/MoteIdeaControls'
import { CalendarScheduleControl } from '../src/renderer/src/components/CalendarScheduleControl'
import { createClientUiRoot } from './helpers/client-ui-render'

vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => createElement('div', { 'data-original-editor': true }) }))
let app: MoteAppFixture
const originalLaunchAgent = useAppStore.getState().launchAgent
const revision = 'sha256:' + 'a'.repeat(64), correctedRevision = 'sha256:' + 'b'.repeat(64)
const root = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = root + '/idea-source.md'
const material: FileDocument = { path, content: 'Old cached document.', revision }
const scope = (id = PMO_TEAMS_TOPIC_ID) => ({ workspace: scratchWorkspace, topic: moteTopics.find(topic => topic.id === id)!, rootPath: scratchTopicDirectoryName(id) })
const reference = (tab = defaultTab) => ({ displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: tab.id, regionId: tab.layout.activeRegionId })
const input = { direction: 'Explore a useful next experiment.', includeDiscussion: false }
const read = (params: FileReadParams, content = 'A saved, scoped decision.', rev = revision): FileReadResult => {
  const directory = params.zoneId === homeZoneId(directoryIdentity('local', _hygiene_fixturePath("topics/") + root)) ? root : scratchTopicDirectoryName(customMoteId)
  const mapped = directory + '/' + params.path
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: _hygiene_fixturePath("topics/") + directory, path: mapped },
    result: { status: 'read', document: { path: mapped, content, revision: rev } } }
}
const note = (regionId: string) => useAppStore.getState().agentComposerNotes[regionId]!
function deferredRead() {
  let finish!: (value: FileReadResult) => void, params!: FileReadParams
  vi.mocked(api.files.readPublic).mockImplementation(value => { params = value; return new Promise(resolve => { finish = resolve }) })
  return { complete: async () => { await act(async () => finish(read(params))); await settleMoteApp() } }
}
beforeEach(() => {
  app = createMoteApp(); useLauncherState.setState({ drafts: {} })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => read(params))
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  vi.spyOn(api.schedule, 'onChanged').mockImplementation(() => () => {})
})

const ideaPanel = () => app.container.querySelector<HTMLElement>('[data-owning-idea-controls]')!
const ideaButton = (label: string) => ideaPanel().querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')!
async function edit(element: HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }); await settleMoteApp()
}
async function ideaUI(selected: FileDocument | null = material) {
  await app.mount(createElement('div', { 'data-owning-idea-controls': true }, createElement(MoteIdeaControls,
    { scope: scope(), reference: reference(), material: selected, onOpenPath: async () => {} })))
}
function scheduleReceipt(params: ScheduleParamsMap['schedule.create'], overrides: Partial<ContinuousProgressLoop> = {}) {
  return { schedule: { ...params.target, calendar: params.calendar, prompt: params.prompt, loopId: 'original-idea-calendar', intervalMs: 60_000,
    status: 'active' as const, nextCheckAt: Date.parse(_hygiene_fixtureIso(24310800000, "minute")), revision: 1, creationOperationId: params.operationId, futureIntentId: 'original-future-intent', ...overrides },
    diskDurability: 'confirmed' as const, executionScope: 'connected-host' as const }
}

describe('actual Mote idea controls and original Calendar consumer', () => {
  it('is off for an empty direction and prepares sources only on the actual user action before original human Save', async () => {
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(async params => scheduleReceipt(params)), goal = vi.spyOn(api.demands, 'create')
    await ideaUI(); vi.mocked(api.files.readPublic).mockClear()
    expect(ideaButton('Arrange sourced ideas').disabled).toBe(true); expect(create).not.toHaveBeenCalled(); expect(api.files.readPublic).not.toHaveBeenCalled()
    await edit(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!, 'Find an experiment I can evaluate.')
    const before = useAppStore.getState(); await moteClick(ideaButton('Arrange sourced ideas'))
    const calendar = ideaPanel().querySelector<HTMLElement>('.calendar-schedules')!
    expect(calendar).not.toBeNull()
    const textarea = calendar.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea.value).toBe('Find an experiment I can evaluate.'); expect(textarea.value).not.toContain('Zone:'); expect(create).not.toHaveBeenCalled(); expect(goal).not.toHaveBeenCalled()
    const context = calendar.querySelector<HTMLElement>('.calendar-schedules__context')!.textContent!
    expect(context).toContain(revision); expect(context).toContain('file.read / file.ls')
    await edit(textarea, 'My edited direction to this Agent.')
    expect(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!.value).toBe('My edited direction to this Agent.')
    await moteClick([...calendar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save arrangement')!)
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: 'My edited direction to this Agent.\n\n' + context, operationId: expect.stringMatching(/^schedule-/) }))
    expect(create.mock.calls[0]![0].checkIn).toBeUndefined(); expect(useAppStore.getState().tabs).toBe(before.tabs); expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })
  it('keeps later direction and rejects the real prepare-button read before a Calendar or Launcher appears', async () => {
    await ideaUI(null); const pending = deferredRead(), create = vi.spyOn(api.schedule, 'create')
    await edit(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!, 'Earlier direction')
    const before = useAppStore.getState(); await moteClick(ideaButton('Arrange sourced ideas'))
    await edit(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!, 'Later direction')
    await pending.complete()
    expect(ideaPanel().querySelector('.calendar-schedules')).toBeNull(); expect(ideaPanel().textContent).toContain('later input changed')
    expect(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!.value).toBe('Later direction'); expect(useAppStore.getState().tabs).toBe(before.tabs); expect(create).not.toHaveBeenCalled()
  })
  it('retries the exact original unknown operation after sources and editable direction have changed', async () => {
    const create = vi.spyOn(api.schedule, 'create').mockRejectedValue(new Error('Original create acknowledgement is unknown.'))
    await ideaUI(); await edit(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!, input.direction); await moteClick(ideaButton('Arrange sourced ideas'))
    const calendar = ideaPanel().querySelector<HTMLElement>('.calendar-schedules')!
    await moteClick([...calendar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save arrangement')!)
    const params = create.mock.calls[0]![0]
    vi.mocked(api.files.readPublic).mockImplementation(async value => read(value, 'Changed after original Save.', correctedRevision))
    await edit(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!, 'Later user direction, kept separately')
    const inspect = vi.spyOn(api.schedule, 'inspect').mockResolvedValue({ schedule: scheduleReceipt(params, { status: 'paused', lastOutcome: 'unknown' }).schedule, executionScope: 'connected-host' })
    await moteClick([...calendar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original operation')!)
    expect(inspect).toHaveBeenCalledExactlyOnceWith({ operationId: params.operationId })
    await moteClick([...calendar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry original operation')!)
    expect(create).toHaveBeenCalledTimes(2); expect(create.mock.calls[1]![0]).toEqual(params)
    expect(params.prompt).toContain(revision); expect(params.prompt).not.toContain(correctedRevision); expect(params.prompt).not.toContain('Later user direction')
    expect(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!.value).toBe('Later user direction, kept separately')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  })
  it('uses a one-time seed for a same-tuple rerender and blocks context-only Save when the current message is empty', async () => {
    const container = document.createElement('div'); document.body.append(container); const view = createClientUiRoot(container)
    const target = { hostId: defaultAgent.control.hostId, agentSessionId: defaultAgent.control.agentSessionId, providerId: defaultAgent.providerId, workspacePath: defaultAgent.workspacePath }
    const create = vi.spyOn(api.schedule, 'create').mockImplementation(async params => scheduleReceipt(params))
    try {
      await act(async () => view.render(createElement(CalendarScheduleControl, { target, initialMessage: 'Initial direction', initialMessageContext: 'Original frozen context.' }))); await settleMoteApp()
      await edit(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Later local message')
      await act(async () => view.render(createElement(CalendarScheduleControl, { target: { ...target }, initialMessage: 'Wrong new seed', initialMessageContext: 'Wrong replacement context.' }))); await settleMoteApp()
      expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Later local message'); expect(container.textContent).toContain('Original frozen context.'); expect(container.textContent).not.toContain('Wrong replacement context.')
      await edit(container.querySelector<HTMLTextAreaElement>('textarea')!, '')
      const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save arrangement')!
      expect(save.disabled).toBe(true); await moteClick(save); expect(create).not.toHaveBeenCalled()
    } finally { await act(async () => view.unmount()); container.remove() }
  })
})

if (process.env.AGENTMUX_IDEAS_NATIVE_CASE) it('actual private native idea arrangement uses the original typed service and checks its lost acknowledgement', async () => {
  const native = JSON.parse(process.env.AGENTMUX_IDEAS_NATIVE_CASE!)
  const { connectAgentMuxRpc } = await import('../../../packages/core/src/public-rpc-client')
  const { writeFile } = await import('node:fs/promises')
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: native.endpoint.slice(5) } })
  const calls: { method: string; params: unknown; result: unknown }[] = []
  const session = { ...defaultAgent, providerId: native.target.providerId, workspacePath: native.target.workspacePath,
    control: { ...defaultAgent.control, hostId: native.target.hostId, agentSessionId: native.target.agentSessionId, run: { runId: native.runId } } }
  useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === defaultAgent.id ? session : item) }))
  let params!: ScheduleParamsMap['schedule.create']
  vi.spyOn(api.schedule, 'create').mockImplementation(async input => {
    params = input
    const result = await rpc.call('schedule.create', input); calls.push({ method: 'schedule.create', params: input, result })
    throw new Error('Private lost acknowledgement after the original Host saved this operation.')
  })
  vi.spyOn(api.schedule, 'inspect').mockImplementation(async input => {
    const result = await rpc.call('schedule.inspect', input); calls.push({ method: 'schedule.inspect', params: input, result }); return result
  })
  try {
    await ideaUI(); await edit(ideaPanel().querySelector<HTMLTextAreaElement>('[aria-label="Idea direction"]')!, 'Find a useful next experiment from my saved notes.')
    await moteClick(ideaButton('Arrange sourced ideas'))
    const calendar = ideaPanel().querySelector<HTMLElement>('.calendar-schedules')!, message = calendar.querySelector<HTMLTextAreaElement>('textarea')!.value
    const frozenContext = calendar.querySelector<HTMLElement>('.calendar-schedules__context')!.textContent!
    await moteClick([...calendar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save arrangement')!)
    await vi.waitFor(() => expect(calendar.textContent).toContain('Private lost acknowledgement'), { timeout: 10_000 })
    expect(calendar.textContent).toContain('Private lost acknowledgement'); expect(params.target).toEqual(native.target)
    expect(params.prompt).toBe(message + '\n\n' + frozenContext)
    await moteClick([...calendar.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original operation')!)
    await vi.waitFor(() => expect(calendar.querySelectorAll('[data-schedule-id]')).toHaveLength(1), { timeout: 10_000 })
    expect(calls).toHaveLength(2); expect(calls[1]!.params).toEqual({ operationId: params.operationId })
    expect(calendar.textContent).not.toContain('Private lost acknowledgement'); expect(calendar.querySelectorAll('[data-schedule-id]')).toHaveLength(1)
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
    await writeFile(native.journal, JSON.stringify({ calls, params, message, frozenContext }, null, 2))
  } finally { await rpc.dispose() }
})
afterEach(async () => { await app.dispose() })

describe('original sourced idea intent preparation', () => {
  it('captures the explicitly selected Core target independently of Mote files and creates no arrangement, Goal, Launcher or Run', async () => {
    const before = useAppStore.getState(), session = { ...defaultAgent, workspacePath: _hygiene_fixturePath("other-execution-cwd"), control: { ...defaultAgent.control, agentSessionId: 'core-exact-agent' } }
    useAppStore.setState({ sessions: before.sessions.map(item => item.id === session.id ? session : item) })
    const create = vi.spyOn(api.schedule, 'create'), goal = vi.spyOn(api.demands, 'create')
    const prepared = await prepareMoteIdeaSchedule(scope(), reference(), input, null, () => true)
    expect(prepared.target).toEqual({ hostId: session.control.hostId, agentSessionId: 'core-exact-agent', providerId: session.providerId, workspacePath: _hygiene_fixturePath("other-execution-cwd") })
    expect(prepared.message).toBe(input.direction); expect(Object.keys(prepared).sort()).toEqual(['frozenContext', 'message', 'sources', 'target'])
    expect(prepared.frozenContext).toContain(("Workspace path: " + _hygiene_fixturePath("topics"))); expect(prepared.frozenContext).toContain('Zone: ' + homeZoneId(directoryIdentity('local', _hygiene_fixturePath("topics/") + root)))
    expect(prepared.frozenContext).toContain('File path in this Zone: SOUL.md'); expect(prepared.frozenContext).toContain('Revision observed at preparation: ' + revision)
    expect(prepared.frozenContext).toContain('read the current relevant original files'); expect(prepared.frozenContext).toContain('last-confirmed preparation facts')
    expect(prepared.frozenContext).not.toContain('{"'); expect(prepared.frozenContext).not.toContain('Old cached document.')
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(create).not.toHaveBeenCalled(); expect(goal).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })
  it('rereads the explicitly chosen note and original SOUL rather than transporting cached revision or neighbor content', async () => {
    vi.mocked(api.files.readPublic).mockImplementation(async params => read(params, params.path === 'SOUL.md' ? 'Current SOUL.' : 'Corrected note.', correctedRevision))
    const prepared = await prepareMoteIdeaSchedule(scope(), reference(), input, material, () => true)
    expect(vi.mocked(api.files.readPublic).mock.calls.map(call => call[0].path)).toEqual(['SOUL.md', 'idea-source.md'])
    expect(prepared.sources.map(source => source.path)).toEqual([root + '/SOUL.md', path])
    expect(prepared.sources[1]!.observation.result).toEqual({ status: 'read', document: { path, content: 'Corrected note.', revision: correctedRevision } })
    expect(prepared.frozenContext).toContain(correctedRevision); expect(prepared.frozenContext).not.toContain(revision)
    const manual = await prepareMoteIdeaDraft(scope(), reference(), input, material, () => true)
    expect(useAppStore.getState().agentComposerDrafts[manual.regionId]).toBe(input.direction)
    expect(note(manual.regionId)).toContain('Corrected note.'); expect(note(manual.regionId)).toContain(correctedRevision); expect(note(manual.regionId)).not.toContain('Old cached document.')
  })
  it('preserves unknown original sources without inventing a resource or closing manual useful work', async () => {
    vi.mocked(api.files.readPublic).mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'Original File scope is unconfirmed.' } })
    const prepared = await prepareMoteIdeaSchedule(scope(), reference(), input, material, () => true)
    expect(prepared.sources.map(source => source.path)).toEqual([root + '/SOUL.md', path]); expect(prepared.sources.every(source => source.observation.resource === null)).toBe(true)
    expect(prepared.frozenContext).toContain('Original resource is unconfirmed'); expect(prepared.frozenContext).toContain('Original File scope is unconfirmed.'); expect(prepared.frozenContext).not.toContain('Revision observed at preparation')
    const manual = await prepareMoteIdeaDraft(scope(), reference(), input, material, () => true)
    expect(useAppStore.getState().agentComposerDrafts[manual.regionId]).toBe(input.direction); expect(note(manual.regionId)).toContain('unconfirmed')
    expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent'); expect(app.stop).not.toHaveBeenCalled()
  })
  it('delivers the manual idea context through the actual original Store launch consumer while keeping the visible direction', async () => {
    const prepared = await prepareMoteIdeaDraft(scope(), reference(), input, material, () => true), context = note(prepared.regionId)
    const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Private launch observation is unavailable.'))
    useAppStore.setState({ launchAgent: originalLaunchAgent })
    await expect(useAppStore.getState().launchAgent('fixture', input.direction, prepared.groupId, prepared)).rejects.toThrow('observation is unavailable')
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: input.direction, agentMuxNote: context }))
    expect(context).toContain(path); expect(context).toContain(revision); expect(context).toContain('A saved, scoped decision.')
    expect(useAppStore.getState().agentComposerDrafts[prepared.regionId]).toBe(input.direction); expect(note(prepared.regionId)).toBe(context)
  })
  it('refuses only an invalid source or absent exact schedule executor, without borrowing the first or neighboring Session', async () => {
    await expect(prepareMoteIdeaSchedule(scope(), reference(), input, { ...material, path: scratchTopicDirectoryName(customMoteId) + '/private.md' }, () => true)).rejects.toThrow('original saved material')
    await expect(prepareMoteIdeaSchedule(scope(), reference(customTab), input, null, () => true)).rejects.toThrow('unconfirmed')
    useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== defaultAgent.id) }))
    await expect(prepareMoteIdeaSchedule(scope(), reference(), input, null, () => true)).rejects.toThrow('exact Agent discussion')
    expect(api.files.readPublic).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
  })
  it('keeps opt-in history exact to the Core SID and Goals exact to the Renderer Session association', async () => {
    const old = useAppStore.getState(), session = { ...defaultAgent, control: { ...defaultAgent.control, agentSessionId: 'core-history-exact' } }
    useAppStore.setState({ sessions: old.sessions.map(item => item.id === session.id ? session : item) })
    const page: AgentSessionHistoryPage = { agentSessionId: 'core-history-exact', source: { providerId: session.providerId, nativeSessionId: 'original-native' }, nextCursor: null,
      items: [{ id: 'original-entry', kind: 'user-message', contentParts: [{ kind: 'text', text: 'My original scoped decision.' }] }] }
    const history = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
    const goal = (id: string, sessionIds: string[]): Demand => ({ id, title: id, description: 'Original confirmed goal.', sessionIds, status: 'in_progress', priority: 'normal', projectId: null, projectName: null, executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, activities: [], decisions: [], createdAt: 10, updatedAt: 20 })
    const goals = vi.spyOn(api.demands, 'list').mockResolvedValue([goal('renderer-linked', [session.id]), goal('wrong-core-linked', [session.control.agentSessionId]), goal('neighbor-linked', ['neighbor-agent'])])
    const plain = await prepareMoteIdeaSchedule(scope(), reference(), input, null, () => true)
    expect(history).not.toHaveBeenCalled(); expect(goals).not.toHaveBeenCalled(); expect(plain.frozenContext).toContain('not included')
    const contextual = await prepareMoteIdeaSchedule(scope(), reference(), { ...input, includeDiscussion: true }, null, () => true)
    expect(history).toHaveBeenCalledExactlyOnceWith({ hostId: session.control.hostId, agentSessionId: 'core-history-exact' }, { limit: 8 })
    expect(contextual.frozenContext).toContain('My original scoped decision.'); expect(contextual.frozenContext).toContain('renderer-linked'); expect(contextual.frozenContext).not.toContain('wrong-core-linked'); expect(contextual.frozenContext).not.toContain('neighbor-linked')
  })
  it('does not accept another native history source as confirmed discussion evidence', async () => {
    vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: 'foreign-core', source: { providerId: 'foreign-provider', nativeSessionId: 'foreign-native' }, nextCursor: null,
      items: [{ id: 'foreign-entry', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Foreign history must not leak.' }] }] })
    vi.spyOn(api.demands, 'list').mockResolvedValue([])
    const prepared = await prepareMoteIdeaSchedule(scope(), reference(), { ...input, includeDiscussion: true }, null, () => true)
    expect(prepared.frozenContext).toContain('history source changed'); expect(prepared.frozenContext).not.toContain('Foreign history must not leak.')
  })
  for (const mode of ['schedule', 'manual'] as const) it(`rejects later user input before ${mode} preparation publishes anything`, async () => {
    const pending = deferredRead(); let current = true
    const before = useAppStore.getState(), work = mode === 'schedule' ? prepareMoteIdeaSchedule : prepareMoteIdeaDraft
    const result = work(scope(), reference(), input, null, () => current); const rejected = expect(result).rejects.toThrow('later input changed')
    current = false; await pending.complete(); await rejected
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  for (const change of ['navigation', 'revision', 'target', 'resource'] as const) it(`latches ${change} A→B→A during pending source reads`, async () => {
    const pending = deferredRead(), before = useAppStore.getState()
    const result = prepareMoteIdeaSchedule(scope(), reference(), input, null, () => true), rejected = expect(result).rejects.toThrow('selection or your later input changed')
    if (change === 'navigation') {
      useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id); useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', defaultTab.id)
    } else if (change === 'revision') {
      useAppStore.setState({ workspaceFileRevisions: { [SCRATCH_WORKSPACE_ID]: 1 } }); useAppStore.setState({ workspaceFileRevisions: before.workspaceFileRevisions })
    } else if (change === 'target') {
      useAppStore.setState({ sessions: before.sessions.map(item => item.id === defaultAgent.id ? { ...defaultAgent, control: { ...defaultAgent.control, agentSessionId: 'replacement-core' } } : item) }); useAppStore.setState({ sessions: before.sessions })
    } else {
      useAppStore.setState({ config: { ...before.config!, workspaces: before.config!.workspaces.map(item => item.id === SCRATCH_WORKSPACE_ID ? { ...item, path: _hygiene_fixturePath("other-source-root") } : item) } }); useAppStore.setState({ config: before.config })
    }
    await pending.complete(); await rejected; expect(useAppStore.getState().tabs).toBe(before.tabs); expect(app.launch).not.toHaveBeenCalled()
  })
})
