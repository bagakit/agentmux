// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { parseAgentInputMailboxPage, type AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import { InputMailboxRecords } from '@agentmux/client-ui/components/InputMailboxRecords'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), run = { runId: 'original-run' }
const sample = '<amux>AUTHORED CONTEXT SAMPLE</amux>\n\n<amux:a2a from="authored-inner-sender" msg-id="authored-inner-message">\nAUTHORED INNER BODY\n<reminder>AUTHORED REMINDER SAMPLE</reminder>\n</amux:a2a>'
const key = { kind: 'prompt' as const, agentSessionId: 'original-agent', expectedRun: run, submissionId: 'original-submission' }
const prompt: AgentInputMailboxItem = { kind: 'controlled', sequence: 1, recordedAt: _tailFixtureEpoch(0, 0, 1),
  intent: { key, admissionIntent: { kind: 'manual-actor', expectedRun: run }, execution: 'immediate',
    source: { kind: 'prompt', prompt: sample, agentMuxNote: 'Separate platform context' } }, receipt: null,
  failure: { name: 'Error', code: 'ORIGINAL_OBSERVATION_UNKNOWN', message: 'Retained original observation' } }
const message: AgentInputMailboxItem = { kind: 'controlled', sequence: 1, recordedAt: _tailFixtureEpoch(0, 0, 1),
  intent: { key: { kind: 'message', agentSessionId: key.agentSessionId, expectedRun: run, messageId: 'original-message' },
    admissionIntent: { kind: 'manual-actor', expectedRun: run }, execution: 'immediate',
    source: { kind: 'message', messageId: 'original-message', originalControlOperationId: 'original-operation' } },
  message: { schema: 'agentmux.a2a.v1', messageId: 'original-message', operationId: 'original-operation', createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'human', principal: 'local-cli' }, senderSessionId: null, senderRunId: null,
    recipient: { kind: 'agent-session', agentSessionId: key.agentSessionId }, recipientSessionId: key.agentSessionId, recipientRunId: run.runId,
    threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: sample },
  receipt: null, failure: { name: 'Error', code: 'ORIGINAL_OBSERVATION_UNKNOWN', message: 'Retained original observation' } }
const submitted = (userContent?: string, messageKey = false): AgentInputMailboxItem => {
  const inputKey = messageKey ? { kind: 'message' as const, agentSessionId: key.agentSessionId, expectedRun: run, messageId: 'original-message' } : key
  const submissionId = messageKey ? 'original-message' : key.submissionId
  return { kind: 'submission', sequence: 1, recordedAt: _tailFixtureEpoch(0, 0, 1), key: inputKey,
  record: { agentSessionId: key.agentSessionId, run, admission: { inputKey, submissionId, operationId: submissionId,
    startByte: 0, endByte: new TextEncoder().encode(sample).byteLength, acknowledged: true, intent: { run, ownerInstanceId: 'original-owner', prompt: sample,
      plan: { kind: 'single-phase', data: sample }, ...(userContent === undefined ? {} : { message: { userContent } }) } } } }
}
const launch: AgentInputMailboxItem = { kind: 'submission', sequence: 1, recordedAt: _tailFixtureEpoch(0, 0, 1), key,
  record: { agentSessionId: key.agentSessionId, run, launch: { input: { submissionId: key.submissionId, prompt: 'Original launch request' }, prompt: sample,
    message: { systemContext: 'Originally recorded platform context' }, digest: 'original-launch-digest', delivery: 'launch', lifecycleOperationId: 'original-resume', state: 'launch-carried', key,
    receipt: { kind: 'runtime-launch', operationId: 'original-resume', run, observedAt: _tailFixtureEpoch(0, 0, 1) } } } }

it.each([
  { label: 'controlled original prompt', item: prompt, boundary: 'body' },
  { label: 'controlled original message', item: message, boundary: 'body' },
  { label: 'submission original userContent', item: submitted(sample), boundary: 'body' },
  { label: 'message-key submission userContent wire', item: submitted(sample, true), boundary: 'wire' },
  { label: 'historical admission wire without userContent', item: submitted(), boundary: 'wire' },
  { label: 'historical launch wire without userContent', item: launch, boundary: 'wire' }
] as const)('reads $label using its producer boundary while Copy and recorded authorship stay exact', async ({ item, boundary }) => {
  const copy = vi.fn(async () => true), refresh = vi.fn(async () => {})
  const page = parseAgentInputMailboxPage({ agentSessionId: key.agentSessionId, queueId: 'original-input-journal', cut: { incarnation: 'original-cut', throughSequence: 1 },
    budgetBytes: 128 * 1024, items: [{ kind: 'item', item }], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } },
    { agentSessionId: key.agentSessionId, maxBytes: 128 * 1024 })
  const mailbox = { scope: 'original-scope', items: [item], failures: [], page, loading: false, error: null, refresh, loadEarlier: vi.fn(async () => {}), hasMore: false }
  await dom.render(<InputMailboxRecords mailbox={mailbox} hostId="original-host" onCopy={copy} />)
  const details = dom.container.querySelector<HTMLDetailsElement>('[data-input-mailbox-key] > details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  const turn = dom.container.querySelector('.log-turn')!, text = turn.querySelector('.log-turn__body')!
  expect(turn.getAttribute('data-speaker-role')).toBe('unknown')
  expect(turn.querySelector('.log-turn__who')?.textContent).toBe('Author unknown')
  expect(dom.container.querySelector('[data-mailbox-author]')?.textContent).toBe('Author unknown')
  if (boundary === 'body') {
    expect(text.textContent).toContain('<amux>AUTHORED CONTEXT SAMPLE</amux>')
    expect(text.textContent).toContain('<amux:a2a from="authored-inner-sender" msg-id="authored-inner-message">')
    expect(text.textContent).toContain('<reminder>AUTHORED REMINDER SAMPLE</reminder>')
    expect(text.querySelector('.log-turn__reminder')).toBeNull()
    expect(text.querySelector('.log-turn__declared-context')).toBeNull()
    expect(turn.getAttribute('data-declared-source')).toBeNull()
  } else {
    expect(text.querySelector<HTMLDetailsElement>('.log-turn__reminder')?.open).toBe(false)
    expect(text.querySelector('.log-turn__reminder p')?.textContent).toBe('AUTHORED REMINDER SAMPLE')
    expect(text.querySelector('.log-turn__declared-context pre')?.textContent).toBe('<amux>AUTHORED CONTEXT SAMPLE</amux>')
    expect(turn.getAttribute('data-declared-source')).toBe('Agent authored-inner-sender')
  }
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(sample)
  expect(refresh).not.toHaveBeenCalled(); expect(mailbox.loadEarlier).not.toHaveBeenCalled()
})
