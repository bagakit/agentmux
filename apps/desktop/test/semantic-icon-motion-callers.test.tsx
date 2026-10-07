// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountThemeRuntime, GRAPHITE_THEME, previewTheme } from '@agentmux/client-ui/theme'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { RecordedStepsCard, RecordedToolRow, WorkflowStatusGlyph as ObservationStatusGlyph } from '@agentmux/client-ui/components/WorkflowObservation'
import { AgentAvatar, ResolvedAgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { FocusContextStateMark } from '../src/renderer/src/components/FocusContextState'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { BrowserOperationStatus, BrowserOperationHistory, BrowserOperationTimeline, BrowserReplayPreview } from '../src/renderer/src/components/BrowserOperationSurface'
import { WorkflowStatusGlyph } from '../src/renderer/src/components/workflow/WorkflowStatusGlyph'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import type { BrowserActivityState, BrowserOperation } from '../src/shared/browser-operation'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'

const dom = composerDOM()
let release: () => void
beforeEach(() => { release = mountThemeRuntime(window) })
afterEach(() => release())

const animated = (node: ParentNode = dom.container) => Array.from(node.querySelectorAll<HTMLElement>('[data-icon-animation]'))
const presets = (node: ParentNode = dom.container) => animated(node).map(element => element.dataset.iconAnimation)

it('animates only the confirmed working avatar and Focus item while the real Working category heading stays static', async () => {
  const now = Date.now(), session = composerSession('working-motion')
  session.status = { state: 'working', source: 'native-hook', observedAt: now }
  session.semanticStatus = { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now - 1000 }
  useAppStore.setState({ sessions: [session], timelines: {}, providerCatalog: [], agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, mainSurface: 'agents', loading: false })
  const state = useAppStore.getState()
  const contexts = createFocusProjectionSelector()({ sessions: state.sessions, config: state.config, timelines: state.timelines, agentNames: state.agentNames, scratchTopicSnapshots: state.scratchTopicSnapshots }).contexts
  expect(contexts).toHaveLength(1); expect(contexts[0]!.bucket).toBe('working')
  await dom.render(<><AgentAvatar label="Current original Agent" sessionId={session.id} /><FocusContextStateMark context={contexts[0]!} /><GlobalFocusSurface /></>)
  const avatar = dom.container.querySelector('.agent-avatar__status')!, item = dom.container.querySelector('.focus-state-mark')!, heading = dom.container.querySelector('.focus-context-group__header[data-bucket="working"]')!
  expect(avatar).not.toBeNull(); expect(item).not.toBeNull(); expect(heading).not.toBeNull()
  expect(presets(avatar)).toEqual(['work']); expect(presets(item)).toEqual(['work'])
  expect(heading.querySelector('[data-semantic-icon="status.working"]')).not.toBeNull(); expect(presets(heading)).toEqual([])
  expect(avatar.querySelector('svg')?.style.strokeWidth).toBe('2.4')
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.motion-callers'; custom.name = 'Original drawings with explicit motion'; custom.icons['status.working'] = { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(presets(heading)).toEqual([]); expect(presets(avatar)).toEqual(['work']); expect(dom.container.querySelector('.agent-avatar__status')).toBe(avatar)
  expect(useAppStore.getState().sessions[0]).toBe(session)
})

it('stops live avatar and Focus motion for current unknown, paused and terminal presentation facts', async () => {
  const now = Date.now(), select = createFocusProjectionSelector()
  for (const status of ['running', 'waiting', 'done', 'error', 'exited', 'disconnected'] as const) {
    const session = composerSession(`motion-${status}`)
    session.status = { state: status, source: status === 'running' ? 'run-process' : 'native-hook', observedAt: now }
    const state = useAppStore.getState()
    const contexts = select({ sessions: [session], config: state.config, timelines: {}, agentNames: state.agentNames, scratchTopicSnapshots: state.scratchTopicSnapshots }).contexts
    expect(contexts, `nonempty ${status} projection`).toHaveLength(1)
    await dom.render(<><ResolvedAgentAvatar label="Original Agent" providerId="codex" state={status} /><FocusContextStateMark context={contexts[0]!} /></>)
    expect(presets(), status).toEqual([])
    expect(dom.container.querySelector('.focus-state-mark'), status).not.toBeNull()
  }
})

it('does not animate a retained working label on an expired, ended or unobserved Agent, or on a read-only resolved avatar', async () => {
  const now = Date.now(), session = composerSession('original-avatar-observation')
  session.status = { state: 'working', source: 'native-hook', observedAt: now }
  session.semanticStatus = session.status
  useAppStore.setState({ sessions: [session] })
  await dom.render(<><AgentAvatar sessionId={session.id} /><ResolvedAgentAvatar label="Recorded working identity" providerId="codex" state="working" /></>)
  const badges = () => dom.container.querySelectorAll('.agent-avatar__status--working')
  expect(badges()).toHaveLength(2); expect(presets()).toEqual(['work'])
  for (const retained of [
    { ...session, status: { ...session.status, observedAt: now - 24 * 60 * 60_000 }, semanticStatus: { ...session.status, observedAt: now - 24 * 60 * 60_000 } },
    { ...session, processState: 'exited' as const },
    { ...session, status: { ...session.status, source: 'run-process' as const } }
  ]) {
    await act(async () => { useAppStore.setState({ sessions: [retained] }) })
    expect(badges(), 'retained working shape remains present').toHaveLength(2)
    expect(presets()).toEqual([])
  }
  await act(async () => { useAppStore.setState({ sessions: [session] }) }); expect(presets()).toEqual(['work'])
})

const operation: BrowserOperation = {
  id: 'original-motion-operation', browserId: 'original-browser', operator: { id: 'original-operator', name: 'Original operator' },
  startedAt: _historyTailFixtureEpoch(0, 1), phase: 'running', summary: 'Original operation', url: 'https://example.invalid/',
  steps: [{ sequence: 1, method: 'click', label: 'Original action', startedAt: _historyTailFixtureEpoch(0, 1, 1), status: 'running' }]
}

it('plays only the current agent-owned Browser operation and keeps the same running record, preparing history and step timeline static', async () => {
  const history = [operation, { ...operation, id: 'recorded-preparing', phase: 'preparing' as const }]
  const render = (activity: BrowserActivityState) => dom.render(<><BrowserOperationStatus activity={activity} /><BrowserOperationHistory operations={history} /><BrowserOperationTimeline operation={operation} /></>)
  await render({ control: 'agent', operation })
  const toolbar = () => dom.container.querySelector('.browser-operation-status')!
  expect(presets(toolbar())).toEqual(['execute'])
  expect(dom.container.querySelector('.browser-rsi-history [data-semantic-icon="status.browser-running"]')).not.toBeNull()
  expect(dom.container.querySelector('.browser-rsi-timeline [data-semantic-icon="status.loading"]')).not.toBeNull()
  expect(presets(dom.container.querySelector('.browser-rsi-history')!)).toEqual([])
  expect(presets(dom.container.querySelector('.browser-rsi-timeline')!)).toEqual([])
  expect(dom.container.querySelectorAll('.spin, .wf-streaming-glyph')).toHaveLength(0)
  await render({ control: 'agent', operation: { ...operation, phase: 'preparing' } }); expect(presets(toolbar())).toEqual(['spin'])
  for (const phase of ['waiting', 'completed', 'failed', 'indeterminate', 'stopped'] as const) {
    await render({ control: 'agent', operation: { ...operation, phase } }); expect(presets(toolbar()), phase).toEqual([])
  }
  await render({ control: 'human', operation }); expect(presets(toolbar())).toEqual([]); expect(toolbar().getAttribute('data-phase')).toBe('human')
  await render({ control: 'agent', operation: null }); expect(presets(toolbar())).toEqual([]); expect(toolbar().getAttribute('data-phase')).toBe('unknown')
  expect(operation.phase).toBe('running'); expect(history[1]!.phase).toBe('preparing')
})

it('uses the original local replay busy receipt for loading motion and removes it when preparation ends', async () => {
  const props = { plan: { schema: 'agentmux.browser-replay.v1' as const, operationId: operation.id, url: operation.url, steps: [] }, onPreview: vi.fn() }
  await dom.render(<BrowserReplayPreview {...props} busy />); expect(presets()).toEqual(['spin'])
  await dom.render(<BrowserReplayPreview {...props} busy={false} />); expect(presets()).toEqual([])
  await dom.click('.browser-rsi-replay__actions button'); expect(props.onPreview).toHaveBeenCalledOnce()
})

it('animates the original Activity working indicator and removes it on the original confirmed state transitions', async () => {
  const props = { sessionId: 'agent-1', items: [], capability: 'streaming' as const, describeSpeaker: () => ({ name: 'Original speaker' }) }
  await dom.render(<ActivityView {...props} displayState="working" activitySemantic="active" />)
  const indicator = dom.container.querySelector('.activity-working')!
  expect(indicator).not.toBeNull(); expect(presets(indicator)).toEqual(['work']); expect(indicator.getAttribute('aria-live')).toBe('polite')
  for (const activitySemantic of ['unknown', 'unsupported', 'idle', 'awaiting-input', undefined] as const) {
    await dom.render(<ActivityView {...props} displayState="working" {...(activitySemantic ? { activitySemantic } : {})} />)
    const retained = dom.container.querySelector('.activity-working')!
    expect(retained).not.toBeNull(); expect(retained.textContent).toContain('Working'); expect(presets(retained)).toEqual([])
  }
  for (const displayState of ['running', 'waiting', 'done', 'error', 'disconnected'] as const) {
    await dom.render(<ActivityView {...props} displayState={displayState} />)
    expect(dom.container.querySelector('.activity-working'), displayState).toBeNull(); expect(presets()).toEqual([])
  }
  expect(dom.draft()).toBe('Keep my draft')
})

it('uses the original Activity read-state loading fact for spin and returns to a static readable surface when it completes or fails', async () => {
  const props = { sessionId: 'agent-1', items: [], capability: 'complete-events' as const, displayState: 'done' as const }
  const read = { loading: true, error: null as Error | null, hasMore: false, onRetry: vi.fn(), onReadEarlier: vi.fn() }
  await dom.render(<ActivityView {...props} userMessageRead={read} />)
  const status = dom.container.querySelector('.activity-feed__reading-status')!
  expect(status).not.toBeNull(); expect(status.textContent).toContain('Reading records')
  expect(presets(status)).toEqual(['spin']); expect(status.querySelector('[data-semantic-icon="status.loading"]')).not.toBeNull()
  for (const error of [null, Error('Original read failure')]) {
    await dom.render(<ActivityView {...props} userMessageRead={{ ...read, loading: false, error }} />)
    expect(dom.container.querySelector('.activity-feed__loading-layer')).toBeNull(); expect(presets()).toEqual([])
  }
  expect(dom.container.textContent).toContain('Original read failure'); expect(dom.draft()).toBe('Keep my draft')
})

it('keeps recorded streaming, recorded running and unknown observations static while explicit live workflow glyphs can animate', async () => {
  await dom.render(<>
    <section data-current-workflow><ObservationStatusGlyph status="running" /><WorkflowStatusGlyph status="running" /></section>
    <section data-recorded-workflow><ObservationStatusGlyph status="running" recorded /><WorkflowStatusGlyph status="running" recorded />
      <RecordedStepsCard observation={{ id: 'original-records', stepCount: 2, status: 'running', streaming: true, counts: { complete: 0, streaming: 1, failed: 0, unknown: 1 } }} expanded onExpandedChange={() => {}}><p>Original retained content</p></RecordedStepsCard>
      <RecordedToolRow observation={{ id: 'original-streaming-record', title: 'Original last recorded stream', status: 'streaming', source: 'native-transcript', persistentSource: true }} className="original-record-row" icon={<SemanticIcon name="object.tools" />} />
      <RecordedToolRow observation={{ id: 'original-unknown-record', title: 'Original unknown', source: 'native-transcript', persistentSource: true }} className="original-record-row" icon={<SemanticIcon name="object.tools" />} />
    </section>
  </>)
  expect(presets(dom.container.querySelector('[data-current-workflow]')!)).toEqual(['work', 'spin'])
  const recorded = dom.container.querySelector('[data-recorded-workflow]')!
  expect(recorded.querySelector('[data-semantic-icon="status.streaming"]')).not.toBeNull()
  expect(recorded.textContent).toContain('Recorded running'); expect(recorded.textContent).toContain('Status not recorded')
  expect(presets(recorded)).toEqual([])
  await dom.render(<><ObservationStatusGlyph status="completed" /><WorkflowStatusGlyph status="completed" /></>)
  expect(presets()).toEqual([])
})
