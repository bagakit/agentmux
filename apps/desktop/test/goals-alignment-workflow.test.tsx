// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '@agentmux/demand'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { DemandAlignmentProposal, DemandGroundingProposal } from '@agentmux/demand/goals'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { createWorkbenchTab, documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], workspaces: [{ id: 'repo', name: 'Repo', path: '/repo', hostId: 'local', kind: 'folder' }, { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: '/scratch', hostId: 'local', kind: 'scratch' }], executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } }, appearance: { terminalTheme: 'graphite' } } as unknown as AppConfig
const intent = '  Keep the exact original work.\n  A healthy Agent must remain available.  '
const proposal: DemandAlignmentProposal = { summary: 'Return to the same work after restart.', criteria: [{ id: 'tabs', text: 'The same tabs and splits return.' }, { id: 'agent', text: 'The original healthy Agent can resume.' }], openQuestions: [] }
function report(outcome: 'met' | 'gap' | 'unknown' = 'met'): DemandGroundingProposal { return { alignmentRevision: 1, summary: 'Workspace restored; both criteria were checked.', checks: [{ criterionId: 'tabs', outcome: 'met', evidence: ['artifacts/restart.log:12'], note: 'The saved tab and split identities match.' }, { criterionId: 'agent', outcome, evidence: ['artifacts/session.log:8'], note: outcome === 'gap' ? 'The draft returned, but automatic resume still needs a retry.' : 'The original Session identity is retained.' }] } }
const activeTransport = new Set<Promise<unknown>>()
function transport<T>(request: Promise<T>): Promise<T> { activeTransport.add(request); void request.finally(() => activeTransport.delete(request)).catch(() => {}); return request }
let temporaryRoot: string, owner: ReturnType<typeof openDemandStore>, root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  temporaryRoot = await mkdtemp(join(tmpdir(), 'amux-goal-ui-')); owner = openDemandStore({ root: temporaryRoot })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ ...initial, config, demands: {}, selectedDemandId: null, sessions: [], tabs: {}, layouts: {}, mainSurface: 'board', demandPmoTabIds: {} })
  // Only transport is substituted. UI invokes the production store methods and unique durable owner.
  vi.spyOn(api.demands, 'create').mockImplementation(input => transport(owner.create({ ...input, id: 'goal' })))
  vi.spyOn(api.demands, 'list').mockImplementation(() => transport(owner.list()))
  vi.spyOn(api.demands, 'update').mockImplementation((id, patch) => transport(owner.update(id, patch)))
  vi.spyOn(api.demands, 'confirmAlignment').mockImplementation((id, revision) => transport(owner.confirmAlignment(id, revision)))
  vi.spyOn(api.demands, 'acceptGrounding').mockImplementation((id, revision, submission, gaps) => transport(owner.acceptGrounding(id, revision, submission, gaps)))
  vi.spyOn(api.demands, 'activity').mockImplementation((id, activity) => transport(owner.addActivity(id, activity)))
  vi.spyOn(api.demands, 'decision').mockImplementation((id, decision) => transport(owner.addDecision(id, decision)))
  vi.spyOn(api.demands, 'linkSession').mockImplementation((id, session) => transport(owner.linkSession(id, session)))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true); await rm(temporaryRoot, { recursive: true, force: true }) })
async function mount() { await act(async () => root.render(createElement(GlobalBoardSurface))) }
async function save(alignment?: DemandAlignmentProposal, confirmed = false, grounding?: DemandGroundingProposal) {
  await useAppStore.getState().createDemand({ title: 'Restore my work', description: intent, status: 'in_progress', projectId: 'repo', projectName: 'Repo', sessionIds: ['healthy-run'], source: 'session' })
  if (alignment) await useAppStore.getState().updateDemand('goal', { alignment })
  if (confirmed) await useAppStore.getState().confirmDemandGoal('goal', 1)
  if (grounding) await useAppStore.getState().updateDemand('goal', { grounding })
  useAppStore.setState({ selectedDemandId: 'goal' })
  vi.mocked(api.demands.confirmAlignment).mockClear(); vi.mocked(api.demands.acceptGrounding).mockClear()
}
function button(label: string) { const node = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label); expect(node, label).toBeDefined(); return node! }
async function click(label: string, waitForTransport = true) { await act(async () => { button(label).click(); for (let i = 0; waitForTransport && i < 4; i++) { await Promise.resolve(); await Promise.allSettled([...activeTransport]) } }) }
async function eventually(assertion: () => unknown | Promise<unknown>) { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); await assertion() }) }
function next() { return container.querySelector('.goals-row__next')?.textContent }

describe('mounted Goals → actual Renderer store → durable Demand owner', () => {
  it('prioritizes the proposal, waits for human confirmation and accepts the exact current report without forging business status', async () => {
    await save(proposal); await mount()
    expect(container.querySelector('[data-goal-summary]')?.textContent).toBe(proposal.summary)
    expect([...container.querySelectorAll('[data-goal-success-criterion]')].map(node => node.textContent)).toEqual(proposal.criteria.map(criterion => criterion.text))
    expect(container.querySelector<HTMLDetailsElement>('.goals-original-intent')?.open).toBe(false)
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal description"]')?.value).toBe(intent)
    expect(next()).toContain('Confirm goal'); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull()
    let finish!: () => void
    vi.mocked(api.demands.confirmAlignment).mockImplementationOnce((id, revision) => transport((async () => { await new Promise<void>(resolve => { finish = resolve }); return owner.confirmAlignment(id, revision) })()))
    await click('Confirm goal', false)
    expect(button('Saving…').disabled).toBe(true); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull()
    expect(useAppStore.getState().demands.goal!.alignment!.confirmedAt).toBeNull()
    await act(async () => { finish(); await Promise.allSettled([...activeTransport]) }); await eventually(() => expect(container.querySelector('[data-goal-confirmation-state]')?.getAttribute('data-goal-confirmation-state')).toBe('confirmed'))
    expect(api.demands.confirmAlignment).toHaveBeenCalledExactlyOnceWith('goal', 1)
    expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0); expect(next()).toContain('Ground results')
    await act(async () => useAppStore.getState().updateDemand('goal', { grounding: report() }))
    const submission = (await owner.get('goal'))!.grounding!.submissionId
    expect([...container.querySelectorAll('[data-goal-outcome]')].map(node => node.getAttribute('data-goal-outcome'))).toEqual(['met', 'met'])
    expect(container.textContent).toContain('Agent report · not accepted'); expect(next()).toContain('Review results')
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    await click('Accept results'); await eventually(async () => expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeGreaterThan(0))
    expect(api.demands.acceptGrounding).toHaveBeenCalledExactlyOnceWith('goal', 1, submission, false)
    const restored = (await openDemandStore({ root: temporaryRoot }).get('goal'))!
    expect(restored).toMatchObject({ description: intent, status: 'in_progress', sessionIds: ['healthy-run'], alignment: { revision: 1, confirmedAt: expect.any(Number) }, grounding: { submissionId: submission, acceptedAt: expect.any(Number), checks: report().checks } })
    expect(container.querySelector('[data-goal-result-state]')?.getAttribute('data-goal-result-state')).toBe('accepted'); expect(next()).toBe('Accepted')
  })

  it('accepts a real reported gap only through the explicit action and keeps the gap and its evidence', async () => {
    await save(proposal, true, report('gap')); await mount()
    expect(container.querySelector('[data-goal-accept]')).toBeNull(); expect(next()).toContain('Review gaps')
    expect(container.textContent).toContain('Reported gap'); expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    const submission = (await owner.get('goal'))!.grounding!.submissionId
    await click('Accept results, keep gaps'); await eventually(() => expect(next()).toBe('Accepted · gaps kept'))
    expect(api.demands.acceptGrounding).toHaveBeenCalledExactlyOnceWith('goal', 1, submission, true)
    expect((await owner.get('goal'))!.grounding!.checks).toEqual(report('gap').checks)
    expect(container.querySelector('[data-goal-result-state]')?.getAttribute('data-goal-result-state')).toBe('accepted-with-gaps')
    expect(container.textContent).toContain('Those gaps remain part of the record')
  })

  it.each([
    ['unknown', report('unknown'), 'Resolve unknowns'],
    ['missing check', { ...report(), checks: [report().checks[0]!] }, 'Complete checks'],
    ['missing evidence', { ...report(), checks: report().checks.map(check => ({ ...check, evidence: [] })) }, 'Complete checks'],
    ['unlocatable evidence', { ...report(), checks: report().checks.map(check => ({ ...check, evidence: ['trust me'] })) }, 'Complete checks'],
    ['unexplained gap', { ...report('gap'), checks: report('gap').checks.map(check => ({ ...check, note: '' })) }, 'Complete checks'],
    ['empty checks', { ...report(), checks: [] }, 'Complete checks'],
  ] as const)('keeps %s reported and cannot accept it as a normal result or a gap', async (_label, grounding, expected) => {
    await save(proposal, true, grounding); await mount()
    expect(container.querySelectorAll('[data-goal-criterion-id]')).toHaveLength(2)
    expect(container.querySelector('[data-goal-accept]')).toBeNull(); expect(container.querySelector('[data-goal-accept-gaps]')).toBeNull()
    expect(next()).toBe(expected); expect(api.demands.acceptGrounding).not.toHaveBeenCalled(); expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
  })

  it.each([
    ['open questions', { ...proposal, openQuestions: ['Should resume happen automatically or after a click?'] }, 'Resolve choices'],
    ['empty criteria', { ...proposal, criteria: [] }, 'Define success'],
  ] as const)('shows %s before confirmation without letting status manufacture acknowledgement', async (_label, alignment, expected) => {
    await save(alignment); await useAppStore.getState().updateDemand('goal', { status: 'done' }); await mount()
    expect(container.querySelector('[data-goal-confirm]')).toBeNull(); expect(container.querySelector('[data-goal-accept]')).toBeNull()
    expect(container.querySelector('[data-goal-alignment-revision]')?.getAttribute('data-goal-alignment-revision')).toBe('1')
    expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull(); expect(api.demands.confirmAlignment).not.toHaveBeenCalled()
    await click('Show finished'); expect(next()).toBe(expected)
  })

  it('keeps an earlier accepted report visible but stale when the target changes, and preserves same-content acknowledgements', async () => {
    await save(proposal, true, report()); const submission = (await owner.get('goal'))!.grounding!.submissionId
    await useAppStore.getState().acceptDemandResult('goal', 1, submission)
    const before = (await owner.get('goal'))!
    await useAppStore.getState().updateDemand('goal', { alignment: proposal, grounding: report() })
    expect((await owner.get('goal'))!.alignment).toEqual(before.alignment); expect((await owner.get('goal'))!.grounding).toEqual(before.grounding)
    await useAppStore.getState().updateDemand('goal', { alignment: { ...proposal, criteria: [...proposal.criteria, { id: 'draft', text: 'Unsent drafts return exactly.' }] } }); await mount()
    expect(container.querySelectorAll('[data-goal-outcome="stale"]')).toHaveLength(3)
    expect(container.querySelector('[data-goal-result-state]')?.getAttribute('data-goal-result-state')).toBe('stale')
    expect(container.querySelector('[data-goal-accept]')).toBeNull(); expect(container.querySelector('[data-goal-accept-gaps]')).toBeNull()
    expect(container.textContent).toContain('previous acceptance does not apply'); expect(next()).toContain('Confirm goal')
    await click('Confirm goal'); await eventually(() => expect(next()).toBe('Update results'))
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBe(before.grounding!.acceptedAt)
  })

  it('rejects an unread concurrent goal revision, reloads through the owner, and requires another human confirmation', async () => {
    await save(proposal); await mount()
    const unchanged = useAppStore.getState().demands.goal
    await openDemandStore({ root: temporaryRoot }).proposeAlignment('goal', { ...proposal, summary: 'A different target from another caller.' })
    await click('Confirm goal'); await eventually(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('changed'))
    expect(api.demands.confirmAlignment).toHaveBeenCalledExactlyOnceWith('goal', 1); expect(useAppStore.getState().demands.goal).toEqual(unchanged)
    vi.mocked(api.demands.list).mockRejectedValueOnce(new Error('Owner unavailable'))
    await click('Reload current proposal'); await eventually(() => expect(container.textContent).toContain('Reload failed: Owner unavailable'))
    expect(useAppStore.getState().demands.goal).toEqual(unchanged)
    await click('Reload current proposal'); await eventually(() => expect(container.querySelector('[data-goal-summary]')?.textContent).toBe('A different target from another caller.'))
    expect(api.demands.confirmAlignment).toHaveBeenCalledTimes(1); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull()
    expect(useAppStore.getState().demands.goal).toMatchObject({ description: intent, source: 'session', sessionIds: ['healthy-run'], alignment: { revision: 2, confirmedAt: null } })
    await click('Confirm goal'); await eventually(async () => expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0))
    expect(api.demands.confirmAlignment.mock.calls).toEqual([['goal', 1], ['goal', 2]])
  })

  it('rejects an unread report submission and never retries approval of the replacement during reload', async () => {
    await save(proposal, true, report()); await mount(); const oldSubmission = (await owner.get('goal'))!.grounding!.submissionId
    await openDemandStore({ root: temporaryRoot }).proposeGrounding('goal', { ...report('gap'), summary: 'A newly reported gap.' })
    await click('Accept results'); await eventually(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('changed'))
    expect(api.demands.acceptGrounding).toHaveBeenCalledExactlyOnceWith('goal', 1, oldSubmission, false)
    expect(useAppStore.getState().demands.goal!.grounding!.acceptedAt).toBeNull()
    await click('Reload current proposal'); await eventually(() => expect(container.querySelector('[data-goal-result-summary]')?.textContent).toBe('A newly reported gap.'))
    expect(api.demands.acceptGrounding).toHaveBeenCalledTimes(1); expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    expect(container.querySelector('[data-goal-accept]')).toBeNull()
    await click('Accept results, keep gaps'); await eventually(async () => expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeGreaterThan(0))
    expect(api.demands.acceptGrounding.mock.calls.at(-1)).toEqual(['goal', 1, (await owner.get('goal'))!.grounding!.submissionId, true])
  })

  it('retains a failed acknowledgement and retries the exact reviewed tokens after transport recovery', async () => {
    await save(proposal, true, report()); await mount(); const submission = (await owner.get('goal'))!.grounding!.submissionId
    vi.mocked(api.demands.acceptGrounding).mockRejectedValueOnce(new Error('Receipt unavailable'))
    await click('Accept results'); await eventually(() => expect(container.textContent).toContain('Result acceptance is unconfirmed'))
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull(); expect(useAppStore.getState().demands.goal!.grounding!.acceptedAt).toBeNull()
    await click('Retry acceptance'); await eventually(() => expect(next()).toBe('Accepted'))
    expect(api.demands.acceptGrounding.mock.calls).toEqual([['goal', 1, submission, false], ['goal', 1, submission, false]])
  })

  it('uses the mapped healthy Mote Run for both stages and keeps real deferred input when readiness is unavailable', async () => {
    await save(proposal, true)
    const session = { id: 'mote-session', kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: 'mote-session', run: { runId: 'original-run' } }, status: { state: 'working', observedAt: 1 }, processState: 'running', promptSubmissionPredecessor: null } as SessionSnapshot
    const tab = { ...createWorkbenchTab('mote-tab', { regionId: 'mote-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.id }, 'Mote'), topicId: PMO_TEAMS_TOPIC_ID }
    vi.spyOn(api.scratch, 'readTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session); vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('Prompt readiness not observed'))
    useAppStore.setState({ sessions: [session], demandPmoTabIds: { goal: tab.id }, tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('scratch-group', [tab.id]) } })
    await mount(); await click('Discuss the goal')
    await eventually(() => expect(useAppStore.getState().agentSteerQueues[session.id]?.[0]?.status).toBe('deferred'))
    const first = useAppStore.getState().agentSteerQueues[session.id]![0]!
    expect(first.text).toContain('Grill:'); expect(first.text).toContain(JSON.stringify(intent)); expect(first.runId).toBe('original-run')
    submit.mockResolvedValue(undefined); await act(async () => useAppStore.getState().flushAgentSteerQueue(session.id)); await click('Check results')
    await eventually(() => expect(submit.mock.calls.at(-1)?.[1]).toContain('Grounding:'))
    expect(submit.mock.calls.at(-1)?.[1]).toContain(proposal.criteria[0]!.text)
    expect(submit.mock.calls.at(-1)?.[1]).toContain('\"revision\": 1')
    expect(Object.keys(useAppStore.getState().tabs)).toEqual([tab.id]); expect(useAppStore.getState().sessions).toEqual([session])
    expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
    expect((await owner.get('goal'))!.grounding).toBeUndefined()
  })

  it('opens evidence through the actual file pipeline at its exact line, copies full locations and preserves failed contents honestly', async () => {
    await save(proposal, true, report())
    await mkdir(join(temporaryRoot, 'artifacts')); await writeFile(join(temporaryRoot, 'artifacts/restart.log'), 'The same saved tab identities returned.\n')
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    const read = vi.spyOn(api.files, 'read').mockImplementation((_workspace, path) => transport((async () => ({ status: 'read' as const, document: { path, content: await readFile(join(temporaryRoot, path), 'utf8'), revision: 'evidence-r1' } }))()))
    const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    await mount(); await click('restart.log:12')
    expect(read).toHaveBeenCalledExactlyOnceWith('repo', 'artifacts/restart.log')
    expect(useAppStore.getState().documents[documentKey('repo', 'artifacts/restart.log')]).toEqual({ path: 'artifacts/restart.log', content: 'The same saved tab identities returned.\n', revision: 'evidence-r1' })
    expect(useAppStore.getState().documentRevealTargets[documentKey('repo', 'artifacts/restart.log')]).toEqual({ line: 12 })
    expect(useAppStore.getState().tabs[fileTabId('repo', 'artifacts/restart.log')]?.workspaceId).toBe('repo')
    await click('Copy evidence location artifacts/restart.log:12'); expect(copy).toHaveBeenCalledExactlyOnceWith('artifacts/restart.log:12')
    await click('session.log:8'); expect(container.textContent).toContain('its contents have not been verified here')
    expect([...container.querySelectorAll('[data-goal-outcome]')].map(node => node.getAttribute('data-goal-outcome'))).toEqual(['met', 'met'])
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    expect(useAppStore.getState().selectedDemandId).toBe('goal'); expect((await owner.get('goal'))!.sessionIds).toEqual(['healthy-run'])
  })

  it('keeps a failed acknowledgement attached to its Goal across navigation and retries only its reviewed report', async () => {
    await save(proposal, true, report()); await owner.create({ id: 'other', title: 'Another real goal' }); await useAppStore.getState().refreshDemand('other'); await mount()
    const submission = (await owner.get('goal'))!.grounding!.submissionId
    vi.mocked(api.demands.acceptGrounding).mockRejectedValueOnce(new Error('Receipt unavailable'))
    await click('Accept results'); await eventually(() => expect(container.textContent).toContain('Result acceptance is unconfirmed'))
    await act(async () => (container.querySelector('[data-demand-id="other"]') as HTMLElement).click())
    expect(container.querySelector('[data-goal-acknowledgement-failure]')).toBeNull()
    await act(async () => (container.querySelector('[data-demand-id="goal"]') as HTMLElement).click())
    expect(container.querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('Receipt unavailable')
    await click('Retry acceptance'); await eventually(() => expect(next()).toBe('Accepted'))
    expect(api.demands.acceptGrounding.mock.calls).toEqual([['goal', 1, submission, false], ['goal', 1, submission, false]])
  })

  it('keeps pending acknowledgement attached to its Goal and prevents duplicate requests when returning to it', async () => {
    await save(proposal); await owner.create({ id: 'other', title: 'Another real goal' }); await useAppStore.getState().refreshDemand('other'); await mount()
    let finish!: () => void
    vi.mocked(api.demands.confirmAlignment).mockImplementationOnce((id, revision) => transport((async () => { await new Promise<void>(resolve => { finish = resolve }); return owner.confirmAlignment(id, revision) })()))
    await click('Confirm goal', false)
    await act(async () => (container.querySelector('[data-demand-id="other"]') as HTMLElement).click())
    await act(async () => (container.querySelector('[data-demand-id="goal"]') as HTMLElement).click())
    expect(button('Saving…').disabled).toBe(true); await click('Saving…', false)
    expect(api.demands.confirmAlignment).toHaveBeenCalledExactlyOnceWith('goal', 1)
    await act(async () => { finish(); await Promise.allSettled([...activeTransport]) })
    expect(next()).toBe('Ground results'); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
  })

  it('does no default render work for unrelated Session output while a current report is visible', async () => {
    await save(proposal, true, report()); const related = { id: 'healthy-run', label: 'Original Agent', status: { state: 'waiting' }, workspacePath: '/repo' } as SessionSnapshot
    const unrelated = { ...related, id: 'unrelated' }; useAppStore.setState({ sessions: [related, unrelated] })
    const commits = vi.fn(); await act(async () => root.render(createElement(Profiler, { id: 'goals', onRender: commits }, createElement(GlobalBoardSurface))))
    expect(container.querySelectorAll('[data-goal-criterion-id]')).toHaveLength(2); expect(container.querySelector('[data-demand-id]')?.textContent).toContain('1 linked · waiting')
    const count = commits.mock.calls.length; expect(count).toBeGreaterThan(0)
    await act(async () => useAppStore.setState({ sessions: [related, { ...unrelated, latestOutputBytes: 99999, updatedAt: 9 }], tabs: {} }))
    expect(commits.mock.calls.length).toBe(count)
  })
})
