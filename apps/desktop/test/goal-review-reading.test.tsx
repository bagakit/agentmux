// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DemandAlignmentProposal, DemandGroundingProposal } from '@agentmux/demand/goals'
import type { AppConfig } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { editGoalDraft } from '../src/renderer/src/lib/goal-edit-drafts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { openHostGoalTransport } from './helpers/host-goal-transport'
import { injectedContextCore } from './helpers/injected-context-core'
import { AgentMuxCreationAuthority, type AgentMuxHeadlessRuntime } from '@agentmux/core'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from '../../../packages/core/src/runtime-owner-protocol'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const initial = useAppStore.getState()
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Original Host' }], workspaces: [
  { id: 'repo', name: 'Original repo', path: fixturePath('goal-review-repo'), hostId: 'local', kind: 'folder' },
  { id: SCRATCH_WORKSPACE_ID, name: 'Original Mote', path: fixturePath('goal-review-scratch'), hostId: 'local', kind: 'scratch' }
], executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } }, appearance: { terminalTheme: 'graphite' } } as unknown as AppConfig
const proposal: DemandAlignmentProposal = { summary: 'Keep the same original work.', criteria: [{ id: 'tabs', text: 'The original tabs return.' }, { id: 'draft', text: 'The unsent draft stays exact.' }], openQuestions: [] }
const report = (): DemandGroundingProposal => ({ alignmentRevision: 1, summary: 'The original work was checked.', checks: [
  { criterionId: 'tabs', outcome: 'met', evidence: ['artifacts/tabs.log:12'], note: 'The same Tab identities were read.' },
  { criterionId: 'draft', outcome: 'met', evidence: ['artifacts/draft.log:8'], note: 'Exact spacing was retained.' }
] })
let core: Awaited<ReturnType<typeof injectedContextCore>>, coreRoot: string, host: Awaited<ReturnType<typeof openHostGoalTransport>>, root: Root, container: HTMLDivElement, disposeTheme: () => void
let disposeFixture: () => Promise<void>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  disposeTheme = mountThemeRuntime(window)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ ...initial, config, demands: {}, selectedDemandId: null, sessions: [], tabs: {}, layouts: {}, mainSurface: 'board',
    goalEditDrafts: {}, demandPmoTabIds: {} })
  coreRoot = await mkdtemp(join(tmpdir(), 'amux-goal-review-'))
  const creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: coreRoot, runtimeId: randomUUID() })
  core = await injectedContextCore(coreRoot, undefined, () => ({ creationAuthority }))
  disposeFixture = () => core.dispose()
  const authority = await core.core.agentCreationAuthority()
  // Real Core authority owns the Runtime ID; only this private Host instance identity is controlled.
  const privateOwner = { runtimeId: authority.runtimeId, ownerInstanceId: randomUUID(), protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION,
    processId: process.pid, ctxmux: null, availability: 'connected' as const }
  const runtime = { client: core.core, ownerIdentity: () => privateOwner } as AgentMuxHeadlessRuntime
  host = await openHostGoalTransport({ config: () => useAppStore.getState().config, runtime: () => runtime })
  disposeFixture = () => host.dispose(() => core.dispose())
})
afterEach(async () => {
  try { await act(async () => root.unmount()); expect(core.writes).toEqual([]) }
  finally {
    try { await disposeFixture() }
    finally { await rm(coreRoot, { recursive: true, force: true }); disposeTheme(); container.remove(); vi.restoreAllMocks(); vi.unstubAllEnvs(); useAppStore.setState(initial, true) }
  }
})
async function seed(options: { confirmed?: boolean; grounding?: DemandGroundingProposal; alignment?: DemandAlignmentProposal | null; done?: boolean } = {}) {
  await useAppStore.getState().createDemand({ id: 'review-reading', title: 'Read one current result', description: 'Keep this original intent.  ', status: 'in_progress', projectId: null, projectName: null, sessionIds: [], source: 'session' })
  if (options.alignment !== null) await useAppStore.getState().updateDemand('review-reading', { alignment: options.alignment ?? proposal })
  if (options.confirmed) await useAppStore.getState().confirmDemandGoal('review-reading', 1)
  if (options.grounding) await useAppStore.getState().updateDemand('review-reading', { grounding: options.grounding })
  if (options.done) await useAppStore.getState().updateDemand('review-reading', { status: 'done' })
  useAppStore.setState({ selectedDemandId: 'review-reading' }); host.clear()
}
async function mount() { await act(async () => root.render(<GlobalBoardSurface />)) }
const body = () => container.querySelector<HTMLElement>('.goals-detail')!
const disclosure = () => body().querySelector<HTMLDetailsElement>('.goal-review__disclosure')!
const criteria = () => [...body().querySelectorAll<HTMLElement>('[data-goal-success-criterion]')]
const checks = () => [...body().querySelectorAll<HTMLElement>('[data-goal-criterion-id]')]
const evidence = () => [...body().querySelectorAll<HTMLElement>('.goals-evidence code')]
const action = (selector: string) => body().querySelector<HTMLButtonElement>(selector)!
async function click(node: HTMLElement) { await act(async () => { node.click(); await host.settle() }); await vi.waitFor(() => expect(body().querySelector('button:disabled')?.textContent).not.toBe('Saving…')) }
const current = () => useAppStore.getState().demands['review-reading']!
async function retainedExtraCheck(check: DemandGroundingProposal['checks'][number]) {
  // The public writer correctly rejects unknown criterion IDs. Reading an existing
  // durable report must still retain such a legacy/additional check without authorizing it.
  const snapshot = await host.demands.snapshot()
  snapshot.demands[0]!.grounding!.checks.push(check)
  await writeFile(host.demands.storePath, JSON.stringify(snapshot))
  await useAppStore.getState().refreshDemand('review-reading')
}

it('the actual workspace reads each current criterion, reported check and original evidence exactly once', async () => {
  await seed({ confirmed: true, grounding: report() }); await mount()
  expect(criteria().map(node => node.textContent)).toEqual(proposal.criteria.map(item => item.text))
  expect(checks().map(node => node.dataset.goalCriterionId)).toEqual(['tabs', 'draft'])
  expect(evidence().map(node => node.title)).toEqual(report().checks.flatMap(item => item.evidence))
  for (const criterion of proposal.criteria) expect(body().textContent!.split(criterion.text)).toHaveLength(2)
  expect(disclosure().open).toBe(true)
  expect(action('[data-goal-accept]')).toBeTruthy()
  expect(host.executed('demand.accept')).toEqual([])
})

it('keeps unconfirmed current standards before Confirm and retains the same evidence tree after the real confirmation receipt', async () => {
  await seed({ grounding: report() }); await mount()
  const confirm = action('[data-goal-confirm]'), held = body().querySelector('.goals-evidence')
  for (const criterion of criteria()) expect(criterion.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(action('[data-goal-accept]')).toBeNull()
  await click(confirm)
  expect(host.bodies('demand.confirm')).toEqual([{ operation: 'demand.confirm', demandId: 'review-reading', expectedRevision: 1 }])
  expect((await host.demands.get('review-reading'))!.alignment!.confirmedAt).toBeGreaterThan(0)
  expect(body().querySelector('.goals-evidence')).toBe(held)
  expect(checks()).toHaveLength(2); expect(evidence()).toHaveLength(2)
})

it('keeps current criteria once and preserves the previous revision report, outcomes and extra evidence independently', async () => {
  await seed({ confirmed: true, grounding: report() })
  await useAppStore.getState().updateDemand('review-reading', { alignment: { ...proposal, criteria: [...proposal.criteria, { id: 'read', text: 'Current reading position survives.' }] } })
  await retainedExtraCheck({ criterionId: 'earlier-extra', outcome: 'unknown', evidence: ['artifacts/earlier.log:9'], note: 'Earlier scope remains unknown.' })
  await mount()
  expect(criteria().map(node => node.textContent)).toEqual([...proposal.criteria.map(item => item.text), 'Current reading position survives.'])
  expect(body().querySelectorAll('[data-goal-outcome="stale"]')).toHaveLength(3)
  const previous = body().querySelector<HTMLDetailsElement>('.goals-previous-report')!
  expect(previous).not.toBeNull()
  expect(previous.querySelector('summary')?.textContent).toContain('v1')
  expect(previous.querySelectorAll('[data-goal-criterion-id]')).toHaveLength(3)
  expect(previous.textContent).toContain('Earlier scope remains unknown.')
  expect(previous.textContent).toContain('Reported criterion: earlier-extra')
  expect([...previous.querySelectorAll('code')].map(node => node.title)).toContain('artifacts/earlier.log:9')
  for (const criterion of proposal.criteria) expect(body().textContent!.split(criterion.text)).toHaveLength(2)
  expect(action('[data-goal-accept], [data-goal-accept-gaps]')).toBeNull()
})

it('shows additional checks, missing current checks, unknown results and absent evidence without granting acceptance', async () => {
  await seed({ confirmed: true, grounding: { ...report(), checks: [
    { criterionId: 'tabs', outcome: 'unknown', evidence: [], note: 'The original source remains unobserved.' }
  ] } })
  await retainedExtraCheck({ criterionId: 'extra', outcome: 'met', evidence: ['artifacts/extra.log:3'], note: 'Additional report retained.' })
  await mount()
  expect(checks().map(node => node.dataset.goalOutcome)).toEqual(['unknown', 'missing', 'met'])
  expect(body().textContent).toContain('No evidence provided.')
  expect(body().textContent).toContain('Missing check')
  expect(body().querySelector('.goal-review__extra-checks')?.textContent).toContain('Reported criterion: extra')
  expect(evidence().map(node => node.title)).toEqual(['artifacts/extra.log:3'])
  expect(action('[data-goal-accept], [data-goal-accept-gaps], [data-goal-finish]')).toBeNull()
  expect((await host.demands.get('review-reading'))!.grounding!.checks).toHaveLength(2)
})

it('keeps a durable report without a definition readable through the public reload, without claiming current criteria', async () => {
  await seed({ confirmed: true, grounding: report() })
  const snapshot = await host.demands.snapshot(); delete snapshot.demands[0]!.alignment
  await writeFile(host.demands.storePath, JSON.stringify(snapshot)); await useAppStore.getState().refreshDemand('review-reading'); await mount()
  expect(criteria()).toHaveLength(0); expect(checks()).toHaveLength(2); expect(evidence()).toHaveLength(2)
  expect(body().textContent).toContain('Define the goal and success criteria before accepting this report.')
  expect(action('[data-goal-accept]')).toBeNull()
})

it('presents a normal confirmed goal without a report as one closed compact reading, preserving its secondary recovery actions', async () => {
  await seed({ confirmed: true }); await mount()
  expect(disclosure().open).toBe(false)
  expect(disclosure().querySelector('summary')?.textContent).toContain('Confirmed by you · 2 success criteria · No report yet')
  expect(body().querySelector('.goal-review--compact')).toBeTruthy()
  expect(body().querySelector('.goals-no-results')?.closest('.goal-review__body')).toBeNull()
  const discussion = body().querySelector<HTMLButtonElement>('.goals-no-results [aria-label="Open discussion for Read one current result"]')!
  expect(discussion).not.toBeNull()
  expect(discussion.closest('details:not([open])')).toBeNull()
  expect(discussion.disabled).toBe(false)
  discussion.focus(); expect(document.activeElement).toBe(discussion)
  expect(body().querySelector('.goals-grounding')).toBeNull()
  expect(action('[data-goal-grounding]').classList.contains('primary-button')).toBe(false)
  expect(action('[data-goal-grounding]').closest('details:not([open])')).toBeNull()
  expect(action('[data-goal-accept]')).toBeNull()
})

it.each(['absent', 'unconfirmed', 'confirmed'] as const)('keeps Done with %s definition and no report visibly unverified', async kind => {
  await seed({ alignment: kind === 'absent' ? null : proposal, confirmed: kind === 'confirmed', done: true }); await mount()
  expect(body().querySelector('.goal-review--compact')).toBeNull()
  expect(body().querySelector('.goals-no-results strong')?.textContent).toBe('Results not verified')
  expect(body().querySelector('.goals-no-results')?.closest('details:not([open])')).toBeNull()
  expect(action('[data-goal-accept], [data-goal-accept-gaps]')).toBeNull()
})

it('keeps evidence nodes, the original editor and its draft while the native reading disclosure closes and reopens', async () => {
  await seed({ confirmed: true, grounding: report() }); await mount()
  await act(async () => editGoalDraft('review-reading', 'description', 'Unsent original review draft.  '))
  const editor = body().querySelector('[aria-label="Goal description"]'), held = body().querySelector('.goals-evidence'), panel = disclosure(), summary = panel.querySelector<HTMLElement>('summary')!
  expect(editor).toBeTruthy(); summary.focus()
  await act(async () => summary.click())
  expect(panel.open).toBe(false); expect(document.activeElement).toBe(summary)
  expect(body().querySelector('.goals-evidence')).toBe(held)
  await act(async () => summary.click())
  expect(panel.open).toBe(true); expect(body().querySelector('.goals-evidence')).toBe(held)
  expect(body().querySelector('[aria-label="Goal description"]')).toBe(editor)
  expect(useAppStore.getState().goalEditDrafts['review-reading']?.description?.value).toBe('Unsent original review draft.  ')
})

it('retains the original public acceptance failure, reloads the same report and requires a new explicit acceptance', async () => {
  await seed({ confirmed: true, grounding: report() }); await mount()
  const submissionId = current().grounding!.submissionId
  host.once('demand.accept', { kind: 'reject', error: new Error('Original acceptance receipt unavailable') })
  await click(action('[data-goal-accept]'))
  expect(body().querySelector('[data-goal-acknowledgement-failure]')?.textContent).toContain('Original acceptance receipt unavailable')
  expect(action('[data-goal-accept]')).toBeNull()
  const reload = [...body().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Reload current proposal')!
  expect(reload.classList.contains('primary-button')).toBe(true)
  await click(reload)
  expect(host.bodies('demand.accept')).toHaveLength(1)
  expect(current().grounding!.acceptedAt).toBeNull()
  await click(action('[data-goal-accept]'))
  expect(host.bodies('demand.accept')).toEqual(Array.from({ length: 2 }, () => ({ operation: 'demand.accept', demandId: 'review-reading', expectedAlignmentRevision: 1, expectedSubmissionId: submissionId, acceptGaps: false })))
  expect((await host.demands.get('review-reading'))!.grounding!.acceptedAt).toBeGreaterThan(0)
})
