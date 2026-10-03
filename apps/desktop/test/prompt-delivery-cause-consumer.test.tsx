const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { AgentMuxError } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import { renderComponentBoundary } from './helpers/render-component-boundary'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ state: {
  sessions: [] as SessionSnapshot[], providerCatalog: [],
  config: { workspaces: [{ id: 'workspace', name: 'Private', hostId: 'local', path: _hygiene_fixturePath("private/cause"), kind: 'folder' }], composerShortcuts: [] },
  lastActiveFileByWorkspace: {}, viewModes: {}, scratchTopicSnapshots: {}, agentComposerDrafts: {}, noticeReadReceipts: {},
  agentSteerQueues: {} as Record<string, Array<{ operationId: string; runId: string; text: string; status: 'deferred'; promptCondition: unknown; error: string; errorCode: string }>>,
  agentSteerInFlight: {}, agentSteerExecutionStates: {},
  setAgentComposerDraft: vi.fn(), clearAgentComposerDraftIfUnchanged: vi.fn(), enqueueAgentSteer: vi.fn(() => true),
  send: vi.fn(), flushAgentSteerQueue: vi.fn(), interrupt: vi.fn(), setPosture: vi.fn(), reportError: vi.fn()
} }))
vi.mock('../src/renderer/src/store.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state }) }
})
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: { ui: { chooseFiles: vi.fn(), savePastedImage: vi.fn() } } }))
import { humanizePromptDeliveryError } from '../src/main/prompt-readiness-diagnostics'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { queuedMessageState, type ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'

const failure = { disposition: 'unknown' as const, confirmedInputBytes: 0 }
it.each(['AGENT_PROMPT_INPUT_UNCONFIRMED', 'AGENT_PROMPT_SUBMISSION_BUSY', 'AGENT_PROMPT_READINESS_CONFLICT', 'AGENT_TURN_END_UNCONFIRMED'])(
  'retains original structured control facts when humanizing %s', code => {
    const original = new AgentMuxError('Original refusal', code, 'original machine detail', failure)
    const translated = humanizePromptDeliveryError(original) as AgentMuxError
    expect(translated.code).toBe(code); expect(translated.detail).toBe(original.detail)
    expect(translated.controlFailure).toEqual(original.controlFailure)
  })
it('retains an unmapped preparation failure by original identity', () => {
  const original = new AgentMuxError('Read-only preparation', 'AGENT_PROMPT_PREPARATION_FAILED', 'original preparation cause', { disposition: 'not_applied', confirmedInputBytes: 0 })
  expect(humanizePromptDeliveryError(original)).toBe(original)
})
afterEach(() => { fixture.state.sessions = []; fixture.state.agentSteerQueues = {} })
it.each([
  ['AGENT_PROMPT_INPUT_UNCONFIRMED', "Delivery unknown. Diagnostic: code=AGENT_PROMPT_INPUT_UNCONFIRMED original diagnostic\noriginal machine detail", '发送结果待核实'],
  ['AGENT_PROMPT_PREPARATION_FAILED', 'Read-only preparation ended.\noriginal preparation cause', '本次准备未完成'],
  ['AGENT_PROMPT_INPUT_UNCONFIRMED', 'An original refusal without a Diagnostic suffix.\nOriginal second line.', '发送结果待核实']
])('passes the original queue cause through the actual Composer → Mail boundary: %s', (code, error, label) => {
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
    id: 'private-agent', kind: 'agent', providerId: 'private-provider', executorId: 'private-executor',
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: _hygiene_fixturePath("private/cause"), label: 'Private', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'private-agent', run: { runId: 'original-run' } }
  }
  fixture.state.sessions = [session]
  fixture.state.agentSteerQueues = { 'private-agent': [{ operationId: 'original-operation', runId: 'original-run', text: 'original payload',
    status: 'deferred', promptCondition: { expectedRun: { runId: 'original-run' }, afterSubmissionId: null }, error, errorCode: code }] }
  const boundary = renderComponentBoundary(AgentSessionComposer, { sessionId: 'private-agent' }) as unknown as {
    type: unknown; props: { queued: ComposerQueuedMessage[] }
  }
  expect(boundary.type).toBe(SessionMailbox)
  const projected = boundary.props.queued[0]!
  expect(projected.id).toBe('original-operation'); expect(projected.text).toBe('original payload')
  expect(projected.error).toBe(error); expect(projected.errorCode).toBe(code)
  expect(projected.unconfirmed).toBe(true); expect(projected.editable).toBe(false)
  const presented = queuedMessageState(projected)
  expect(presented.label).toBe(label); expect(presented.detail).toContain(error)
})
