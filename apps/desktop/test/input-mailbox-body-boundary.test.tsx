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

it.each(([
  { label: 'controlled original prompt', item: prompt, boundary: 'body' },
  { label: 'controlled original message', item: message, boundary: 'body' },
  { label: 'submission original userContent', item: submitted(sample), boundary: 'body' },
  { label: 'message-key submission userContent wire', item: submitted(sample, true), boundary: 'wire' },
  { label: 'historical admission wire without userContent', item: submitted(), boundary: 'wire' },
  { label: 'historical launch wire without userContent', item: launch, boundary: 'wire' }
] as const).flatMap(fixture => [false,true].map(compact => ({ ...fixture, compact }))))('reads $label with compact=$compact using its producer boundary while Copy and recorded authorship stay exact', async ({ item, boundary, compact }) => {
  const copy = vi.fn(async () => true), refresh = vi.fn(async () => {})
  const page = parseAgentInputMailboxPage({ agentSessionId: key.agentSessionId, queueId: 'original-input-journal', cut: { incarnation: 'original-cut', throughSequence: 1 },
    budgetBytes: 128 * 1024, items: [{ kind: 'item', item }], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } },
    { agentSessionId: key.agentSessionId, maxBytes: 128 * 1024 })
  const mailbox = { scope: 'original-scope', items: [item], failures: [], page, loading: false, error: null, refresh, loadEarlier: vi.fn(async () => {}), hasMore: false }
  await dom.render(<InputMailboxRecords compact={compact} mailbox={mailbox} hostId="original-host" onCopy={copy} />)
  if (compact) {
    const row = dom.container.querySelector<HTMLButtonElement>('.composer-mailbox__row')!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(row.getAttribute('aria-controls')!)?.hidden).toBe(true)
    expect(dom.container.querySelector('.log-turn')).toBeNull()
    expect(row.querySelector('.composer-mailbox__preview')?.textContent).toBe(boundary === 'body' ? sample.slice(0,240) : 'AUTHORED INNER BODY')
    await dom.click('.composer-mailbox__row')
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(row.getAttribute('aria-controls')!)?.hidden).toBe(false)
    expect(row.querySelectorAll('button, details, .log-turn')).toHaveLength(0)
  } else {
    const details = dom.container.querySelector<HTMLDetailsElement>('[data-input-mailbox-key] > details')!
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  }
  const turn = dom.container.querySelector('.log-turn')!, text = turn.querySelector('.log-turn__body')!
  expect(turn.getAttribute('data-speaker-role')).toBe('unknown')
  expect(turn.querySelector('.log-turn__who')?.textContent).toBe('Author unknown')
  expect(dom.container.querySelector(compact ? '.composer-mailbox__row strong' : '[data-mailbox-author]')?.textContent).toBe('Author unknown')
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
  if (compact) {
    await dom.click('.composer-mailbox__row')
    expect(dom.container.querySelector('.log-turn')).toBeNull()
    expect(dom.container.querySelector('.composer-mailbox__row')?.getAttribute('aria-expanded')).toBe('false')
  }
})

function originalMailbox(item: AgentInputMailboxItem, failures: AgentInputMailboxItem[] = []) {
  const page = parseAgentInputMailboxPage({ agentSessionId: key.agentSessionId, queueId: 'original-input-journal', cut: { incarnation: 'original-cut', throughSequence: item.sequence },
    budgetBytes: 128 * 1024, items: [{ kind: 'item', item }], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } },
    { agentSessionId: key.agentSessionId, maxBytes: 128 * 1024 })
  return { scope: 'original-scope', items: [item], failures, page, loading: false, error: null,
    refresh: vi.fn(async () => {}), loadEarlier: vi.fn(async () => {}), hasMore: false }
}

it('keeps the compact body prefix bounded while its single shared Copy retains the complete original prompt wire', async () => {
  const body = sample + '\n' + 'Original authored body '.repeat(30) + 'ORIGINAL BODY TAIL'
  const wire = '<amux>ORIGINAL PLATFORM CONTEXT</amux>\n\n' + body + '\nORIGINAL WIRE TAIL'
  const item: AgentInputMailboxItem = { ...prompt, intent: { ...prompt.intent, source: { kind: 'prompt', prompt: body, promptWire: wire } } }
  const copy = vi.fn(async () => true), mailbox = originalMailbox(item)
  await dom.render(<InputMailboxRecords compact mailbox={mailbox} hostId="original-host" onCopy={copy} />)
  expect(dom.container.querySelector('.composer-mailbox__preview')?.textContent).toBe(body.slice(0,240))
  expect(dom.container.textContent).not.toContain('ORIGINAL BODY TAIL')
  expect(dom.container.textContent).not.toContain('ORIGINAL WIRE TAIL')
  await dom.click('.composer-mailbox__row')
  expect(dom.container.querySelectorAll('.log-turn')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[aria-label="Copy message"]')).toHaveLength(1)
  expect(dom.container.querySelector('.log-turn__body')?.textContent).toContain('ORIGINAL BODY TAIL')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire)
  expect(mailbox.refresh).not.toHaveBeenCalled(); expect(mailbox.loadEarlier).not.toHaveBeenCalled()
})

it('keeps an incomplete wire prefix instead of reading beyond its budget and uses the exact recorded peer presentation', async () => {
  const item = submitted(undefined,true)
  if (item.kind !== 'submission' || !item.record?.admission?.intent) throw new Error('Original submission fixture exists')
  const wire = `<amux:a2a from="${'long-recorded-declaration-'.repeat(14)}" msg-id="inner-message">\nWIRE BODY AFTER PREFIX\n</amux:a2a>`
  item.record.admission.intent.prompt = wire
  item.record.admission.intent.message = { authorAgentSessionId: 'recorded-peer' }
  item.record.admission.intent.plan = { kind: 'single-phase', data: wire }
  const mailbox = originalMailbox(item), copy = vi.fn(async () => true)
  const describeSpeaker = vi.fn(() => ({ name: 'Current peer name', avatar: <span data-recorded-avatar="recorded-peer">Peer avatar</span> }))
  await dom.render(<InputMailboxRecords compact mailbox={mailbox} hostId="original-host" reading={{ describeSpeaker }} onCopy={copy} />)
  const row = dom.container.querySelector<HTMLButtonElement>('.composer-mailbox__row')!
  expect(describeSpeaker).toHaveBeenCalledExactlyOnceWith({ role: 'agent', id: 'recorded-peer' },18)
  expect(row.querySelector('strong')?.textContent).toBe('Current peer name')
  expect(row.querySelector('[data-recorded-avatar]')?.getAttribute('data-recorded-avatar')).toBe('recorded-peer')
  expect(row.querySelector('.composer-mailbox__preview')?.textContent).toBe(wire.slice(0,240))
  expect(dom.container.textContent).not.toContain('WIRE BODY AFTER PREFIX')
  await dom.click('.composer-mailbox__row')
  expect(dom.container.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('agent')
  expect(dom.container.querySelector('.log-turn__who')?.textContent).toBe('Current peer name')
  await dom.click('[aria-label="Message details"]')
  expect(dom.container.querySelector('.conversation-input-details__body')?.textContent).toContain('recorded-peer')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire)
})

it('retains compact selection, local actions and complete prior text when the current original read fails', async () => {
  const mailbox = originalMailbox(prompt), local = vi.fn(() => <button type="button">Retained local action</button>)
  await dom.render(<InputMailboxRecords compact mailbox={mailbox} hostId="original-host" renderLocal={local} />)
  expect(local).not.toHaveBeenCalled()
  await dom.click('.composer-mailbox__row')
  const originalTurn = dom.container.querySelector('.log-turn')
  expect(originalTurn).not.toBeNull()
  const failed: AgentInputMailboxItem = { ...prompt, receipt: null, failure: { name: 'Error', message: 'CURRENT ORIGINAL READ FAILURE' } }
  await dom.render(<InputMailboxRecords compact mailbox={{ ...mailbox, failures: [failed] }} hostId="original-host" renderLocal={local} />)
  expect(dom.container.querySelector('.log-turn')).toBe(originalTurn)
  expect(dom.container.querySelector('.composer-mailbox__record-status')?.textContent).toBe('此前已读 · 本次读取未确认')
  expect(dom.container.querySelector('.composer-mailbox__row')?.getAttribute('aria-expanded')).toBe('true')
  await dom.click('[aria-label="Message details"]')
  expect(dom.container.textContent).toContain('CURRENT ORIGINAL READ FAILURE')
  expect(dom.container.textContent).toContain('Retained local action')
  expect([...dom.container.querySelectorAll('summary')].map(node => node.textContent)).not.toContain('查看原输入')
  await dom.click('.composer-mailbox__row')
  expect(dom.container.querySelector('.log-turn')).toBeNull()
  expect(dom.container.querySelector('.composer-mailbox__record-status')?.textContent).toBe('此前已读 · 本次读取未确认')
})
