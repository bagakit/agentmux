const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '@agentmux/demand'
import type { DemandAlignmentProposal, DemandGroundingProposal } from '@agentmux/demand/goals'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, currentCoreSpatialGraph, prepareRendererUpdate } from '../src/renderer/src/store'
import { readGoalDiscussionBinding } from '../../host/src/goal-discussion-bindings'
import { openHostGoalDiscussionFixture } from './helpers/host-goal-discussion-fixture'
import type { HostGoalTransport } from './helpers/host-goal-transport'

const initial = useAppStore.getState()
let discussion: Awaited<ReturnType<typeof openHostGoalDiscussionFixture>>
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], workspaces: [{ id: 'repo', name: 'Repo', path: _hygiene_fixturePath("repo"), hostId: 'local', kind: 'folder' }, { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: _hygiene_fixturePath("scratch"), hostId: 'local', kind: 'scratch' }], executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } }, appearance: { terminalTheme: 'graphite' } } as unknown as AppConfig
const intent = '  Keep the exact original work.\n  A healthy Agent must remain available.  '
const proposal: DemandAlignmentProposal = { summary: 'Return to the same work after restart.', criteria: [{ id: 'tabs', text: 'The same tabs and splits return.' }, { id: 'agent', text: 'The original healthy Agent can resume.' }], openQuestions: [] }
function report(outcome: 'met' | 'gap' | 'unknown' = 'met'): DemandGroundingProposal { return { alignmentRevision: 1, summary: 'Workspace restored; both criteria were checked.', checks: [{ criterionId: 'tabs', outcome: 'met', evidence: ['artifacts/restart.log:12'], note: 'The saved tab and split identities match.' }, { criterionId: 'agent', outcome, evidence: ['artifacts/session.log:8'], note: outcome === 'gap' ? 'The draft returned, but automatic resume still needs a retry.' : 'The original Session identity is retained.' }] } }
// Exact public Goal acknowledgement requests the renderer sent to the original Host owner.
const confirmed = (...revisions: number[]) => revisions.map(expectedRevision => ({ operation: 'demand.confirm', demandId: 'goal', expectedRevision }))
const accepted = (submission: string, acceptGaps: boolean) => ({ operation: 'demand.accept', demandId: 'goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps })
let disposeTheme: () => void
let host: HostGoalTransport, temporaryRoot: string, owner: HostGoalTransport['demands'], root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  disposeTheme = mountThemeRuntime(window)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ ...initial, config, demands: {}, selectedDemandId: null, sessions: [], tabs: {}, layouts: {}, mainSurface: 'board', demandPmoTabIds: {} })
  discussion = await openHostGoalDiscussionFixture(config)
  host = discussion.host; owner = host.demands; temporaryRoot = owner.root
})
afterEach(async () => { try { await act(async () => root.unmount()); await discussion.dispose() } finally { disposeTheme(); container.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true) } })
async function mount() { await act(async () => root.render(createElement(GlobalBoardSurface))) }
async function save(alignment?: DemandAlignmentProposal, confirmed = false, grounding?: DemandGroundingProposal) {
  await useAppStore.getState().createDemand({ id: 'goal', title: 'Restore my work', description: intent, status: 'in_progress', projectId: workspaceProjectId(config.workspaces[0]!), projectName: 'Repo', sessionIds: ['healthy-run'], source: 'session' })
  // Source is a retained Renderer presentation field; the Host Demand domain has no source field.
  useAppStore.setState(state => ({ demands: { ...state.demands, goal: { ...state.demands.goal!, source: 'session' } } }))
  if (alignment) await useAppStore.getState().updateDemand('goal', { alignment })
  if (confirmed) await useAppStore.getState().confirmDemandGoal('goal', 1)
  if (grounding) await useAppStore.getState().updateDemand('goal', { grounding })
  useAppStore.setState({ selectedDemandId: 'goal' })
  host.clear()
}
function button(label: string) { const action = ['Clarify goal', 'Discuss changes'].includes(label) ? '[data-goal-grill]' : label === 'Ask agent to check work' ? '[data-goal-grounding]' : null; const node = (action ? container.querySelector<HTMLButtonElement>(action) : null) ?? [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label); expect(node, label).toBeDefined(); return node! }
async function click(label: string, waitForTransport = true) { const target = button(label); await act(async () => { target.click(); if (waitForTransport) await host.settle() }); if (waitForTransport) await eventually(() => expect(target.isConnected && target.disabled).toBe(false)) }
async function eventually(assertion: () => unknown | Promise<unknown>) { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); await assertion() }) }
async function openReportedEvidence() {
  const report = container.querySelector<HTMLElement>('.goal-review--report')!
  await act(async () => report.querySelector<HTMLElement>('.goal-review__disclosure > summary')!.click())
  const evidence = [...report.querySelectorAll<HTMLElement>('.goal-review__evidence > summary')]
  expect(evidence.length).toBeGreaterThan(0)
  await act(async () => { for (const item of evidence) item.click() })
  await eventually(() => expect(report.querySelectorAll('.goals-evidence')).toHaveLength(evidence.length))
}
// The Goals list groups rows by whose turn it is; read this Goal's own row, never whichever row is first.
function intentReading() { return container.querySelector('.goals-intent__reading')?.textContent }
function next() { return container.querySelector('[data-demand-id="goal"] .goals-row__next')?.textContent }
function expectReloadOnly() {
  const recovery = container.querySelector('[data-goal-acknowledgement-failure]')
  expect(recovery).toBeTruthy()
  expect([...recovery!.querySelectorAll('button')].map(node => node.textContent?.trim())).toEqual(['Reload current proposal'])
  expect([...container.querySelectorAll('.goals-detail .primary-button')].map(node => node.textContent?.trim())).toEqual(['Reload current proposal'])
  expect(container.querySelector('[data-goal-confirm], [data-goal-accept], [data-goal-accept-gaps]')).toBeNull()
  expect(container.querySelector('[data-demand-id="goal"] .goals-row__next')?.textContent).toBe('Acknowledgement unconfirmed')
  expect(container.querySelector('[data-demand-id="goal"]')?.getAttribute('aria-label')).toBe('Open goal Restore my work. Acknowledgement unconfirmed')
}


describe('mounted Goals → actual Renderer store → durable Demand owner', () => {
  it('prioritizes the proposal, waits for human confirmation and accepts the exact current report without forging business status', async () => {
    await save(proposal); await mount()
    expect(container.querySelector('[data-goal-summary]')?.textContent).toBe(proposal.summary)
    expect([...container.querySelectorAll('[data-goal-success-criterion]')].map(node => node.textContent)).toEqual(proposal.criteria.map(criterion => criterion.text))
    // The original intent follows the proposal as rendered reading; Edit opens the exact original text.
    expect(container.querySelector('.goals-original-intent .goals-intent__reading')?.textContent).toContain('Keep the exact original work.')
    await click('Edit goal description', false)
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal description"]')?.value).toBe(intent)
    await click('Done', false)
    expect(next()).toContain('Goal ready for confirmation'); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull()
    let finish!: () => void
    finish = host.once('demand.confirm', { kind: 'hold-request' }).release
    await click('Confirm goal', false)
    expect(button('Saving…').disabled).toBe(true); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull()
    expect(useAppStore.getState().demands.goal!.alignment!.confirmedAt).toBeNull()
    await act(async () => { finish(); await host.settle() }); await eventually(() => expect(container.querySelector('[data-goal-confirmation-state]')?.getAttribute('data-goal-confirmation-state')).toBe('confirmed'))
    expect(host.bodies('demand.confirm')).toEqual(confirmed(1))
    expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0); expect(next()).toContain('Goal agreed')
    await act(async () => useAppStore.getState().updateDemand('goal', { grounding: report() }))
    const submission = (await owner.get('goal'))!.grounding!.submissionId
    expect([...container.querySelectorAll('[data-goal-outcome]')].map(node => node.getAttribute('data-goal-outcome'))).toEqual(['met', 'met'])
    expect(container.textContent).toContain('Agent report · Not accepted yet'); expect(next()).toContain('Results ready for review')
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    const accept = button('Accept results')
    expect(accept.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.accept-results'))
    expect([...container.querySelectorAll('[data-goal-outcome="met"] [data-semantic-icon="status.completed"] use')].map(use => use.getAttribute('href'))).toEqual([semanticIconHref('status.completed'), semanticIconHref('status.completed')])
    const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.goal-review'; custom.name = 'Goal review'
    custom.icons = { 'action.accept-results': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }, 'status.completed': { kind: 'paths', paths: [{ d: 'M12 3L21 20H3Z' }] } }
    await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
    expect(button('Accept results')).toBe(accept)
    expect(document.getElementById(semanticIconHref('action.accept-results').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
    expect(document.getElementById(semanticIconHref('status.completed').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M12 3L21 20H3Z')
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    await click('Accept results'); await eventually(async () => expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeGreaterThan(0))
    expect(host.bodies('demand.accept')).toEqual([accepted(submission, false)])
    const restored = (await openDemandStore({ root: temporaryRoot }).get('goal'))!
    expect(restored).toMatchObject({ description: intent, status: 'in_progress', sessionIds: ['healthy-run'], alignment: { revision: 1, confirmedAt: expect.any(Number) }, grounding: { submissionId: submission, acceptedAt: expect.any(Number), checks: report().checks } })
    expect(container.querySelector('[data-goal-result-state]')?.getAttribute('data-goal-result-state')).toBe('accepted'); expect(next()).toBe('Accepted')
  })

  it('shows the original intent and one clarification block without empty proposal or result sections', async () => {
    await save(); await mount()
    const artwork = container.querySelector<HTMLImageElement>('.goals-request-action img')!
    expect(artwork?.src).toContain('demand-dialogue.png')
    expect(artwork.alt).toBe(''); expect(artwork.getAttribute('aria-hidden')).toBe('true')
    expect(artwork.closest('button')).toBeNull()
    await act(async () => artwork.dispatchEvent(new Event('error')))
    expect(artwork.hidden).toBe(true)
    expect(button('Clarify goal').disabled).toBe(false)
    expect(host.executed('demand.confirm')).toEqual([])
    expect(intentReading()).toContain('A healthy Agent must remain available.')
    expect(container.querySelectorAll('.goals-clarification')).toHaveLength(1)
    expect(container.querySelector('.goals-alignment')).toBeNull(); expect(container.querySelector('.goals-grounding')).toBeNull()
    expect(container.querySelector('[data-goal-result-state]')).toBeNull(); expect(next()).toBe('Goal needs an outline')
    expect(button('Clarify goal').parentElement?.textContent).toContain('Starts a dedicated discussion in your primary Mote')
    expect(container.querySelector('[data-demand-id]')?.getAttribute('aria-label')).toBe('Open goal Restore my work. Goal needs an outline')
    expect(container.querySelector('.goals-row__facts')?.textContent).toBe('Repo')
    expect(container.querySelector('.goals-row__next svg')).toBeNull()
    expect((await owner.get('goal'))!).toMatchObject({ description: intent, status: 'in_progress', sessionIds: ['healthy-run'] })
  })

  it('states that an agreed goal has no report yet and keeps checking secondary to the current work', async () => {
    await save(proposal, true); await mount()
    expect(next()).toBe('Goal agreed · No result report')
    expect(container.querySelector('.goals-no-results')?.textContent).toContain('Agents work on this goal next. Ask for a result check when the work is ready.')
    expect(container.querySelector('.goals-grounding')).toBeNull()
    expect(button('Ask agent to check work').classList.contains('primary-button')).toBe(false)
    expect(button('Open discussion for Restore my work').classList.contains('primary-button')).toBe(false)
    expect(container.querySelector('[data-goal-finite-start]')).toBeTruthy()
    expect(container.querySelector('[data-goal-accept]')).toBeNull()
    expect(container.textContent).not.toContain('Start work')
    expect((await owner.get('goal'))!).toMatchObject({ status: 'in_progress', alignment: { confirmedAt: expect.any(Number) } })
    expect((await owner.get('goal'))!.grounding).toBeUndefined()
  })

  it.each([
    ['absent proposal', undefined, false], ['unconfirmed proposal', proposal, false], ['confirmed proposal', proposal, true],
  ] as const)('calls a done goal with %s unverified when no report exists', async (_label, alignment, confirmed) => {
    await save(alignment, confirmed); await useAppStore.getState().updateDemand('goal', { status: 'done' }); await mount(); await click('Show finished')
    expect([...container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id'))).toEqual(['goal'])
    expect(next()).toBe('Marked done · No verification report')
    expect(container.querySelector(confirmed ? '[data-goal-grounding]' : alignment ? '[data-goal-confirm]' : '[data-goal-grill]')?.classList.contains('primary-button')).toBe(true)
    expect(container.querySelector('[data-goal-accept], [data-goal-accept-gaps]')).toBeNull()
    const restored = (await openDemandStore({ root: temporaryRoot }).get('goal'))!
    expect(restored.status).toBe('done'); expect(restored.grounding).toBeUndefined()
    if (alignment) expect(restored.alignment!.confirmedAt).toEqual(confirmed ? expect.any(Number) : null)
  })

  it('keeps a report without a proposal directly readable while explaining why it cannot be accepted', async () => {
    await save(proposal, true, report())
    // Existing incomplete durable record: normal submission requires a goal; reading must still preserve its report.
    const snapshot = await owner.snapshot(); delete snapshot.demands[0]!.alignment
    await writeFile(owner.storePath, JSON.stringify(snapshot)); await useAppStore.getState().refreshDemand('goal'); await mount()
    await click('Read results')
    expect(document.activeElement).toBe(container.querySelector('[data-goal-grounding-submission]'))
    expect(container.querySelector('[data-goal-result-summary]')?.textContent).toBe(report().summary)
    expect([...container.querySelectorAll('[data-goal-outcome]')].map(node => node.getAttribute('data-goal-outcome'))).toEqual(['met', 'met'])
    await openReportedEvidence()
    expect([...container.querySelectorAll('.goals-evidence code')].map(node => node.getAttribute('title'))).toEqual(report().checks.flatMap(check => check.evidence))
    expect(container.querySelector('.goals-grounding')?.textContent).toContain('Define the goal and success criteria before accepting this report.')
    expect(container.querySelector('[data-goal-accept], [data-goal-accept-gaps]')).toBeNull()
    expect(container.querySelector('[data-goal-grill]')?.textContent).toContain('Clarify goal'); expect(container.textContent).not.toContain('vundefined')
    expect(host.executed('demand.accept')).toEqual([])
    expect((await owner.get('goal'))!).toMatchObject({ description: intent, grounding: { checks: report().checks, acceptedAt: null } })
  })

  it('keeps the original Goal and input after Host preparation fails and distinguishes request from navigation failure', async () => {
    await save(); await mount()
    const held = host.once('demand.discuss', { kind: 'hold-request' })
    const configured = useAppStore.getState().config!, originalGoal = await owner.get('goal')
    await click('Clarify goal', false); await held.reached
    expect(button('Sending request…').disabled).toBe(true)
    await act(async () => { useAppStore.setState({ config: { ...configured, executors: {} } }); held.release(); await host.settle() })
    await eventually(() => expect(container.querySelector('.goals-detail')?.textContent).toContain('Goal request delivery is unconfirmed. Your goal and current work are kept.'))
    expect(await owner.get('goal')).toEqual(originalGoal)
    expect(readGoalDiscussionBinding(currentCoreSpatialGraph()!, 'goal')).toBeNull()
    expect(discussion.core.start).toHaveBeenCalledTimes(1) // Only the already-existing primary Mote.
    expect(intentReading()).toContain('A healthy Agent must remain available.')
    await click('Open discussion for Restore my work')
    await eventually(() => expect(container.querySelector('.goals-detail')?.textContent).toContain('The discussion could not be opened.'))
    expect(button('Retry opening discussion')).toBeTruthy()
    expect(container.querySelector('[data-goal-grill]')).toBeTruthy()
    await act(async () => useAppStore.setState({ config: configured }))
    await click('Retry opening discussion')
    await eventually(() => expect(readGoalDiscussionBinding(currentCoreSpatialGraph()!, 'goal')?.recipient.kind).toBe('agent'))
    expect(container.querySelector('.goals-detail')?.textContent).not.toContain('The discussion could not be opened.')
    expect(discussion.core.start).toHaveBeenCalledTimes(2)
    const bound = readGoalDiscussionBinding(currentCoreSpatialGraph()!, 'goal')!
    if (bound.recipient.kind !== 'agent') throw new Error('The original discussion Agent is not confirmed')
    const created = await discussion.core.core.inspectAgentCreation(bound.recipient.agentSessionId)
    expect(created.creation?.initialPrompt).toBe('not-requested') // Opening does not silently send the failed clarification.
  })

  it('accepts a real reported gap only through the explicit action and keeps the gap and its evidence', async () => {
    await save(proposal, true, report('gap')); await mount()
    expect(container.querySelector('[data-goal-accept]')).toBeNull(); expect(next()).toContain('Results have known gaps')
    expect(container.textContent).toContain('Reported gap'); expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    const submission = (await owner.get('goal'))!.grounding!.submissionId
    await click('Accept results, keep gaps'); await eventually(() => expect(next()).toBe('Accepted with gaps'))
    expect(host.bodies('demand.accept')).toEqual([accepted(submission, true)])
    expect((await owner.get('goal'))!.grounding!.checks).toEqual(report('gap').checks)
    expect(container.querySelector('[data-goal-result-state]')?.getAttribute('data-goal-result-state')).toBe('accepted-with-gaps')
    expect(container.textContent).toContain('Those gaps remain part of the record')
  })

  it.each([
    ['unknown', report('unknown'), 'Results need checking'],
    ['missing check', { ...report(), checks: [report().checks[0]!] }, 'Results need checking'],
    ['missing evidence', { ...report(), checks: report().checks.map(check => ({ ...check, evidence: [] })) }, 'Results need checking'],
    ['unlocatable evidence', { ...report(), checks: report().checks.map(check => ({ ...check, evidence: ['trust me'] })) }, 'Results need checking'],
    ['unexplained gap', { ...report('gap'), checks: report('gap').checks.map(check => ({ ...check, note: '' })) }, 'Results need checking'],
    ['empty checks', { ...report(), checks: [] }, 'Results need checking'],
  ] as const)('keeps %s reported and cannot accept it as a normal result or a gap', async (_label, grounding, expected) => {
    await save(proposal, true, { ...grounding, checks: [...grounding.checks] }); await mount()
    expect(container.querySelectorAll('[data-goal-criterion-id]')).toHaveLength(2)
    expect(container.querySelector('[data-goal-accept]')).toBeNull(); expect(container.querySelector('[data-goal-accept-gaps]')).toBeNull()
    expect(next()).toBe(expected); expect(host.executed('demand.accept')).toEqual([]); expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
  })

  it.each([
    ['open questions', { ...proposal, openQuestions: ['Should resume happen automatically or after a click?'] }, 'Decision needed'],
    ['empty criteria', { ...proposal, criteria: [] }, 'Success criteria needed'],
  ] as const)('shows %s before confirmation without letting status manufacture acknowledgement', async (_label, alignment, expected) => {
    await save({ ...alignment, criteria: [...alignment.criteria], openQuestions: [...alignment.openQuestions] }); await mount()
    expect(container.querySelector('[data-goal-confirm]')).toBeNull(); expect(container.querySelector('[data-goal-accept]')).toBeNull()
    expect(container.querySelector('[data-goal-alignment-revision]')?.getAttribute('data-goal-alignment-revision')).toBe('1')
    expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull(); expect(host.executed('demand.confirm')).toEqual([])
    expect(next()).toBe(expected); expect(container.querySelector('.goals-alignment .goals-section-heading .goals-caption')?.textContent).toBe(_label === 'open questions' ? 'Decisions needed' : 'Define success criteria')
    expect([...container.querySelectorAll('.goals-detail .primary-button')].map(node => node.textContent?.trim())).toEqual(['Discuss changes in goal discussion'])
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
    expect(container.textContent).toContain('previous acceptance does not apply'); expect(next()).toContain('Goal ready for confirmation')
    await click('Confirm goal'); await eventually(() => expect(next()).toBe('Results need updating'))
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBe(before.grounding!.acceptedAt)
  })

  it('rejects an unread concurrent goal revision, reloads through the owner, and requires another human confirmation', async () => {
    await save(proposal); await mount()
    const unchanged = useAppStore.getState().demands.goal
    await openDemandStore({ root: temporaryRoot }).proposeAlignment('goal', { ...proposal, summary: 'A different target from another caller.' })
    await click('Confirm goal'); await eventually(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('changed'))
    expect(host.bodies('demand.confirm')).toEqual(confirmed(1)); expect(useAppStore.getState().demands.goal).toEqual(unchanged); expectReloadOnly()
    // Reload reads the exact Goal from its original owner (demand.show); that read fails once before reaching it.
    host.once('demand.show', { kind: 'reject', error: new Error('Owner unavailable') })
    await click('Reload current proposal'); await eventually(() => expect(container.textContent).toContain('Reload failed: Owner unavailable'))
    expect(useAppStore.getState().demands.goal).toEqual(unchanged); expectReloadOnly()
    await click('Reload current proposal'); await eventually(() => expect(container.querySelector('[data-goal-summary]')?.textContent).toBe('A different target from another caller.'))
    expect(host.executed('demand.confirm')).toHaveLength(1); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull()
    expect(useAppStore.getState().demands.goal).toMatchObject({ description: intent, source: 'session', sessionIds: ['healthy-run'], alignment: { revision: 2, confirmedAt: null } })
    await click('Confirm goal'); await eventually(async () => expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0))
    expect(host.bodies('demand.confirm')).toEqual(confirmed(1, 2))
  })

  it('rejects an unread report submission and never retries approval of the replacement during reload', async () => {
    await save(proposal, true, report()); await mount(); const oldSubmission = (await owner.get('goal'))!.grounding!.submissionId
    await openDemandStore({ root: temporaryRoot }).proposeGrounding('goal', { ...report('gap'), summary: 'A newly reported gap.' })
    await click('Accept results'); await eventually(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('changed'))
    expect(host.bodies('demand.accept')).toEqual([accepted(oldSubmission, false)]); expectReloadOnly()
    expect(useAppStore.getState().demands.goal!.grounding!.acceptedAt).toBeNull()
    await click('Reload current proposal'); await eventually(() => expect(container.querySelector('[data-goal-result-summary]')?.textContent).toBe('A newly reported gap.'))
    expect(host.executed('demand.accept')).toHaveLength(1); expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    expect(container.querySelector('[data-goal-accept]')).toBeNull()
    await click('Accept results, keep gaps'); await eventually(async () => expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeGreaterThan(0))
    expect(host.bodies('demand.accept').at(-1)).toEqual(accepted((await owner.get('goal'))!.grounding!.submissionId, true))
  })

  it('retains an unconfirmed receipt, reloads and requires a new explicit acceptance of the same reviewed report', async () => {
    await save(proposal, true, report()); await mount(); const submission = (await owner.get('goal'))!.grounding!.submissionId
    host.once('demand.accept', { kind: 'reject', error: new Error('Receipt unavailable') })
    await click('Accept results'); await eventually(() => expect(container.textContent).toContain('Result acceptance is unconfirmed'))
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull(); expect(useAppStore.getState().demands.goal!.grounding!.acceptedAt).toBeNull()
    expectReloadOnly(); await click('Reload current proposal')
    expect(host.executed('demand.accept')).toHaveLength(1); expect(button('Accept results')).toBeTruthy()
    await click('Accept results'); await eventually(() => expect(next()).toBe('Accepted'))
    expect(host.bodies('demand.accept')).toEqual([accepted(submission, false), accepted(submission, false)])
  })

  it('keeps recovery primary when changed owner facts arrive while its receipt failure is retained', async () => {
    await save(proposal); await mount()
    host.once('demand.confirm', { kind: 'reject', error: new Error('Receipt unavailable') })
    await click('Confirm goal'); expectReloadOnly()
    await act(async () => useAppStore.getState().updateDemand('goal', { alignment: { ...proposal, openQuestions: ['Should the original Agent resume automatically?'] } }))
    expectReloadOnly(); expect(button('Discuss changes').classList.contains('primary-button')).toBe(false)
    expect(button('Discuss changes').disabled).toBe(false)
    await owner.proposeAlignment('goal', proposal); await owner.confirmAlignment('goal', 3)
    // Another caller changed the original Goal; the Host owner fences writes on updatedAt, so this write carries the owner's current one.
    await act(async () => useAppStore.getState().updateDemand('goal', { description: intent }, undefined, (await owner.get('goal'))!.updatedAt))
    expectReloadOnly(); expect(button('Open discussion for Restore my work').classList.contains('primary-button')).toBe(false)
    expect(button('Open discussion for Restore my work').disabled).toBe(false)
    await click('Reload current proposal')
    expect(container.querySelector('[data-goal-acknowledgement-failure]')).toBeNull()
    expect(next()).toBe('Goal agreed · No result report'); expect(button('Open discussion for Restore my work').classList.contains('primary-button')).toBe(false)
    expect(host.bodies('demand.confirm')).toEqual(confirmed(1))
    expect((await owner.get('goal'))!).toMatchObject({ description: intent, sessionIds: ['healthy-run'], alignment: { revision: 3, confirmedAt: expect.any(Number) } })
  })

  it.each(['confirm', 'accept'] as const)('reads a durable successful %s after a lost receipt without sending a second acknowledgement', async (kind) => {
    await save(proposal, kind === 'accept', kind === 'accept' ? report() : undefined)
    const healthyRun = { id: 'healthy-run', label: 'Original Agent', hostId: 'local', providerId: 'codex', workspacePath: config.workspaces[0]!.path, kind: 'agent', control: { kind: 'agent', hostId: 'local', agentSessionId: 'healthy-run', run: { runId: 'original-healthy-run' } }, processState: 'running', status: { state: 'working', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' } } as SessionSnapshot
    useAppStore.setState({ sessions: [healthyRun] }); await mount()
    const reviewed = useAppStore.getState().demands.goal!
    // The original Host owner commits; only the receipt back to the renderer is lost.
    const readsBefore = host.executed('demand.show').length
    const lost = host.once(kind === 'confirm' ? 'demand.confirm' : 'demand.accept', { kind: 'lose-receipt', error: new Error('Receipt lost after the owner committed') })
    await click(kind === 'confirm' ? 'Confirm goal' : 'Accept results')
    await eventually(() => expect(container.querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('is unconfirmed'))
    expectReloadOnly()
    expect((await lost.committed).operation).toBe(kind === 'confirm' ? 'demand.confirm' : 'demand.accept')
    const committed = (await openDemandStore({ root: temporaryRoot }).get('goal'))!
    const savedAt = kind === 'confirm' ? committed.alignment!.confirmedAt : committed.grounding!.acceptedAt
    expect(savedAt).toBeGreaterThan(0)
    const observed = useAppStore.getState().demands.goal!
    const observedAt = kind === 'confirm' ? observed.alignment?.confirmedAt : observed.grounding?.acceptedAt
    if (observedAt != null) {
      // A separate authenticated Host read is allowed to observe its real commit, never a fabricated ACK.
      expect(observedAt).toBe(savedAt)
      expect(observed.updatedAt).toBe(committed.updatedAt)
      expect(observed.activities).toEqual(committed.activities)
      expect(host.executed('demand.show').length).toBeGreaterThan(readsBefore)
      expect(kind === 'confirm' ? { ...observed.alignment!, confirmedAt: null } : observed.alignment).toEqual(reviewed.alignment)
      expect(kind === 'accept' ? { ...observed.grounding!, acceptedAt: null } : observed.grounding).toEqual(reviewed.grounding)
      expect({ id: observed.id, title: observed.title, description: observed.description, sessionIds: observed.sessionIds, status: observed.status })
        .toEqual({ id: reviewed.id, title: reviewed.title, description: reviewed.description, sessionIds: reviewed.sessionIds, status: reviewed.status })
    } else expect(observed).toEqual(reviewed)
    expect(kind === 'confirm' ? reviewed.alignment!.confirmedAt : reviewed.grounding!.acceptedAt).toBeNull()
    await click('Reload current proposal')
    expect(container.querySelector('[data-goal-acknowledgement-failure]')).toBeNull()
    expect(kind === 'confirm' ? useAppStore.getState().demands.goal!.alignment!.confirmedAt : useAppStore.getState().demands.goal!.grounding!.acceptedAt).toBe(savedAt)
    expect(next()).toBe(kind === 'confirm' ? 'Goal agreed · No result report' : 'Accepted')
    expect(container.textContent).toContain(kind === 'confirm' ? 'Goal confirmed' : 'Accepted by you')
    expect(container.querySelector('[data-goal-confirm], [data-goal-accept], [data-goal-accept-gaps]')).toBeNull()
    expect(host.executed('demand.confirm')).toHaveLength(kind === 'confirm' ? 1 : 0)
    expect(host.executed('demand.accept')).toHaveLength(kind === 'accept' ? 1 : 0)
    expect(useAppStore.getState().sessions).toEqual([healthyRun])
    expect((await owner.get('goal'))!).toMatchObject({ description: intent, status: 'in_progress', sessionIds: ['healthy-run'] })
    if (kind === 'accept') expect((await owner.get('goal'))!.grounding!.submissionId).toBe(reviewed.grounding!.submissionId)
  })

  it.each(['grill', 'grounding'] as const)('keeps the exact canonical discussion Run and original %s input when readiness is unavailable', async mode => {
    await save(mode === 'grounding' ? proposal : undefined, mode === 'grounding'); await mount()
    await click('Open discussion for Restore my work')
    const binding = readGoalDiscussionBinding(currentCoreSpatialGraph()!, 'goal')!
    if (binding.recipient.kind !== 'agent') throw new Error('The original discussion Agent is not confirmed')
    const original = discussion.core.core.agentSession(binding.recipient.agentSessionId)
    const native = (discussion.core.core as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence
    vi.mocked(native.wait).mockRejectedValueOnce(new Error('Prompt readiness not observed'))
    await click(mode === 'grill' ? 'Clarify goal' : 'Ask agent to check work')
    await eventually(() => expect(container.querySelector('.goals-detail')?.textContent).toContain('Prompt readiness not observed'))
    const request = host.executed('demand.discuss').at(-1)!, writes = [...discussion.core.writes]
    const key = { kind: 'prompt' as const, agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: request.requestId }
    const retained = await discussion.core.core.inspectAgentPromptSubmission(key)
    expect(retained).not.toBeNull()
    expect(retained?.admission?.intent?.message).toMatchObject({ userContent: mode === 'grill' ? 'Clarify this existing Goal.' : 'Inspect this existing Goal and its actual results.', systemContext: expect.stringContaining('goal inspect --goal "goal"') })
    expect(retained?.admission?.acknowledged).not.toBe(true)
    await expect(host.hostGoals.execute(request, {})).rejects.toBeTruthy()
    expect(discussion.core.writes).toEqual(writes) // Reconciliation never repeats the unknown original input.
    expect(readGoalDiscussionBinding(currentCoreSpatialGraph()!, 'goal')).toEqual(binding)
    expect(discussion.core.core.agentSession(original.agentSessionId).run).toEqual(original.run)
    expect((await owner.get('goal'))!.description).toBe(intent)
    if (mode === 'grounding') expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
    expect((await owner.get('goal'))!.grounding).toBeUndefined()
  })

  it('keeps unbound local evidence readable and copyable without guessing its Project workspace', async () => {
    await save(proposal, true, report())
    const read = vi.spyOn(api.files, 'read'), publicRead = vi.spyOn(api.files, 'readPublic')
    const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    await mount()
    await openReportedEvidence()
    expect(container.querySelectorAll('.goals-evidence__open')).toHaveLength(0)
    expect(container.textContent).toContain('Original reference · File source not recorded')
    await click('Copy evidence location artifacts/restart.log:12')
    expect(copy).toHaveBeenCalledExactlyOnceWith('artifacts/restart.log:12')
    expect(read).not.toHaveBeenCalled(); expect(publicRead).not.toHaveBeenCalled()
    expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
    expect(useAppStore.getState().selectedDemandId).toBe('goal'); expect((await owner.get('goal'))!.sessionIds).toEqual(['healthy-run'])
  })

  it('keeps a failed acknowledgement attached across navigation, then reloads before a new explicit acceptance', async () => {
    await save(proposal, true, report()); await owner.create({ id: 'other', title: 'Another real goal' }); await useAppStore.getState().refreshDemand('other'); await mount()
    const submission = (await owner.get('goal'))!.grounding!.submissionId
    host.once('demand.accept', { kind: 'reject', error: new Error('Receipt unavailable') })
    await click('Accept results'); await eventually(() => expect(container.textContent).toContain('Result acceptance is unconfirmed'))
    expectReloadOnly(); await click('Back to goals')
    expect(container.querySelector('.goals-detail')).toBeNull()
    expect(container.querySelector('[data-demand-id="goal"] .goals-row__next')?.textContent).toBe('Acknowledgement unconfirmed')
    expect(host.executed('demand.accept')).toHaveLength(1)
    await act(async () => (container.querySelector('[data-demand-id="goal"]') as HTMLElement).click())
    expectReloadOnly(); expect(host.executed('demand.accept')).toHaveLength(1)
    await act(async () => (container.querySelector('[data-demand-id="other"]') as HTMLElement).click())
    expect(container.querySelector('[data-goal-acknowledgement-failure]')).toBeNull()
    await act(async () => (container.querySelector('[data-demand-id="goal"]') as HTMLElement).click())
    expect(container.querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('Receipt unavailable')
    expectReloadOnly(); await click('Reload current proposal')
    expect(host.executed('demand.accept')).toHaveLength(1); expect(button('Accept results')).toBeTruthy()
    await click('Accept results'); await eventually(() => expect(next()).toBe('Accepted'))
    expect(host.bodies('demand.accept')).toEqual([accepted(submission, false), accepted(submission, false)])
  })

  it('keeps pending acknowledgement attached to its Goal and prevents duplicate requests when returning to it', async () => {
    await save(proposal); await owner.create({ id: 'other', title: 'Another real goal' }); await useAppStore.getState().refreshDemand('other'); await mount()
    let finish!: () => void
    finish = host.once('demand.confirm', { kind: 'hold-request' }).release
    await click('Confirm goal', false)
    await act(async () => (container.querySelector('[data-demand-id="other"]') as HTMLElement).click())
    await act(async () => (container.querySelector('[data-demand-id="goal"]') as HTMLElement).click())
    expect(button('Saving…').disabled).toBe(true); await click('Saving…', false)
    expect(host.bodies('demand.confirm')).toEqual(confirmed(1))
    await act(async () => { finish(); await host.settle() })
    expect(next()).toBe('Goal agreed · No result report'); expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
  })

  it('does no default render work for unrelated Session output while a current report is visible', async () => {
    await save(proposal, true, report()); const related = { id: 'healthy-run', kind: 'agent', hostId: 'local', providerId: 'codex', control: { kind: 'agent', hostId: 'local', agentSessionId: 'healthy-run', run: { runId: 'original-healthy-run' } }, label: 'Original Agent', status: { state: 'waiting' }, workspacePath: _hygiene_fixturePath("repo"), capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' } } as SessionSnapshot
    const unrelated = { ...related, id: 'unrelated', control: { kind: 'agent', hostId: 'local', agentSessionId: 'unrelated', run: { runId: 'unrelated-run' } } } as SessionSnapshot; useAppStore.setState({ sessions: [related, unrelated] })
    const commits = vi.fn(); await act(async () => root.render(createElement(Profiler, { id: 'goals', onRender: commits }, createElement(GlobalBoardSurface))))
    expect(container.querySelectorAll('[data-goal-criterion-id]')).toHaveLength(2); expect(container.querySelector('[data-demand-id]')?.textContent).toContain('1 linked · waiting')
    await act(async () => { await host.settle(); await prepareRendererUpdate() })
    const count = commits.mock.calls.length; expect(count).toBeGreaterThan(0)
    await act(async () => useAppStore.setState({ sessions: [related, { ...unrelated, latestOutputBytes: 99999, updatedAt: _reshape_fixtureEpoch(0, 0, 9) }], tabs: { ...useAppStore.getState().tabs } }))
    expect(commits.mock.calls.length).toBe(count)
  })
})
