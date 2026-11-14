import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxInteractionOperationIntent, AgentMuxInteractionOperationReceipt, AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { AgentInteractionCard } from '../src/components/AgentInteractionCard.js'
import { Button } from '../src/components/Button.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import { ConversationToolTrace } from '../src/components/ConversationToolTrace.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const copyText = vi.fn<ClientUiPlatform['copyText']>()
const platform: ClientUiPlatform = { copyText, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => {
  copyText.mockReset().mockResolvedValue(true)
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function render(content: ReactNode) {
  await act(async () => root.render(<ClientUiProvider platform={platform}>{content}</ClientUiProvider>))
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label ||
    [...node.children].some(child => child.textContent?.trim() === label))
  expect(found, `Rendered native action: ${label}`).toBeDefined()
  return found!
}
async function click(control: HTMLButtonElement) { await act(async () => control.click()) }
function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: Error) => void
  const promise = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
function request(kind: 'permission' | 'question' = 'permission', id = 'original-request'): AgentMuxInteractionRequest {
  const shared = { id, agentSessionId: 'original-session', evidence: { source: 'native-hook' as const, observedAt: fixtureEpoch(0, 0, 1), run: { runId: 'original-run' } } }
  return kind === 'permission' ? { ...shared, kind, title: 'Allow the original write?', toolName: 'Write', toolInput: '{"path":"src/original.ts"}',
    options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'reject-once' }] }
    : { ...shared, kind, questions: [{ id: 'question-original', title: 'Choose an approach', prompt: 'Which original approach?',
      options: [{ id: 'first', label: 'First approach', description: 'Keep this original explanation.' }, { id: 'second', label: 'Second approach' }] }] }
}
type Respond = (response: AgentMuxInteractionResponse, intent: AgentMuxInteractionOperationIntent) => Promise<AgentMuxInteractionOperationReceipt | void>
function receipt(response: AgentMuxInteractionResponse, intent: AgentMuxInteractionOperationIntent,
  overrides: Partial<AgentMuxInteractionOperationReceipt> = {}, completed = true): AgentMuxInteractionOperationReceipt {
  return { ...intent, agentSessionId: intent.expectedRequest.agentSessionId, run: { runId: 'original-run' }, response,
    delivery: 'hook-written', nativeAdoption: 'unknown',
    ...(completed ? { nativeCompleted: { source: 'native-hook' as const, observedAt: fixtureEpoch(0, 0, 2), run: { runId: 'original-run' } } } : {}), ...overrides }
}
function panel(): HTMLElement { return host.querySelector('.agent-interaction .conversation-disclosure')! }
function expectOpen() {
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('false')
  expect(panel().getAttribute('data-open')).toBe('true')
  expect(panel().hasAttribute('inert')).toBe(false)
}

it('preserves Button native ref, caller attributes, submit, disabled and keyboard ownership', async () => {
  const reference = createRef<HTMLButtonElement>(), onClick = vi.fn(), submit = vi.fn(), key = vi.fn()
  await render(<form onSubmit={event => { event.preventDefault(); submit() }}>
    <Button ref={reference} variant="primary" type="submit" name="original-action" value="confirm" className="caller-action"
      aria-busy="true" onClick={onClick} onKeyDown={key}>Continue</Button>
    <Button disabled onClick={onClick}>Unavailable</Button>
  </form>)
  const control = button('Continue')
  expect(reference.current).toBe(control)
  expect(control.type).toBe('submit'); expect(control.name).toBe('original-action'); expect(control.value).toBe('confirm')
  expect(control.classList.contains('primary-button')).toBe(true); expect(control.classList.contains('caller-action')).toBe(true)
  expect(control.getAttribute('aria-busy')).toBe('true')
  control.focus(); expect(document.activeElement).toBe(control)
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  control.dispatchEvent(enter); expect(enter.defaultPrevented).toBe(false); expect(key).toHaveBeenCalledOnce()
  await click(control); expect(submit).toHaveBeenCalledOnce(); expect(onClick).toHaveBeenCalledOnce()
  await click(button('Unavailable')); expect(onClick).toHaveBeenCalledOnce()
})

it('keeps original ConversationMessage tool order, first-open laziness and exact copy payloads', async () => {
  const input = '\n {"original": "<tag>"}\n', output = '\toriginal result\n\n'
  await render(<ConversationMessage messageId="original-message" speaker={{ role: 'agent', id: 'original-session' }}
    content={[{ kind: 'tool-result', callId: 'result-before-call', output, failed: true }, { kind: 'tool-call', callId: 'other-call', name: 'Read', input }]} />)
  const traces = [...host.querySelectorAll('.conversation-tool-trace')]
  expect(traces.map(node => node.getAttribute('data-trace-kind'))).toEqual(['tool-result', 'tool-call'])
  expect(host.querySelector('.conversation-tool-trace__payload')).toBeNull()
  await click(traces[0]!.querySelector('button')!)
  expect(traces[1]!.querySelector('.conversation-tool-trace__payload')).toBeNull()
  expect(traces[0]!.getAttribute('data-status')).toBe('failed')
  await click(button('Copy tool output')); expect(copyText).toHaveBeenLastCalledWith(output, expect.any(Function))
  await click(traces[1]!.querySelector('button')!)
  await click(button('Copy tool input')); expect(copyText).toHaveBeenLastCalledWith(input, expect.any(Function))
  expect(traces.map(node => node.getAttribute('data-call-id'))).toEqual(['result-before-call', 'other-call'])
})

it('makes a closing tool immediately inert and restores focus without discarding its formatted content', async () => {
  const part = { kind: 'tool-call' as const, name: 'Read', input: '{"original":1}', callId: 'original-call' }
  const draw = (expanded: boolean) => render(<ConversationToolTrace part={part} expanded={expanded} />)
  await draw(false); expect(host.querySelector('pre')).toBeNull()
  await draw(true)
  const control = host.querySelector<HTMLButtonElement>('.conversation-tool-trace__row')!, payload = host.querySelector('.conversation-tool-trace__payload')!
  const format = button('Format JSON')
  await click(format); format.focus()
  await draw(false)
  const closing = host.querySelector('.conversation-disclosure')!
  expect(closing.hasAttribute('inert')).toBe(true); expect(closing.getAttribute('aria-hidden')).toBe('true')
  expect(closing.hasAttribute('hidden')).toBe(false)
  expect(closing.getAttribute('data-open')).toBe('false'); expect(document.activeElement).toBe(control)
  expect(host.querySelector('.conversation-tool-trace__payload')).toBe(payload)
  await draw(true); expect(button('Format JSON')).toBe(format); expect(format.getAttribute('aria-pressed')).toBe('true')
})

it.each(['permission', 'question'] as const)('converges only the exact native-completed %s receipt and preserves original request details', async kind => {
  const original = request(kind), respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent))
  await render(<AgentInteractionCard request={original} sourceNotice="Original native source" onRespond={respond} />)
  const originalBody = panel(), choose = button(kind === 'permission' ? 'Allow once' : 'First approach')
  choose.focus(); await click(choose)
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  expect(originalBody).toBe(panel()); expect(panel().getAttribute('data-open')).toBe('false'); expect(panel().hasAttribute('inert')).toBe(true)
  expect(host.textContent).toContain('Original request completed')
  const details = button('Details'); expect(document.activeElement).toBe(details)
  await click(details)
  expect(panel().getAttribute('data-open')).toBe('true'); expect(panel().hasAttribute('inert')).toBe(false)
  expect(host.textContent).toContain('Original native source')
  expect(host.textContent).toContain(kind === 'permission' ? '{"path":"src/original.ts"}' : 'Which original approach?')
  expect(choose.getAttribute('aria-pressed')).toBe('true'); expect(choose.disabled).toBe(true)
  expect(respond).toHaveBeenCalledOnce()
})

it.each(['saved', 'unknown', 'hook-written'] as const)('keeps an unconfirmed %s response open with the original inspection path', async delivery => {
  const respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { delivery }, false))
  const inspect = vi.fn(async () => null)
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={inspect} />)
  await click(button('Allow once')); expectOpen()
  expect(host.textContent).not.toContain('Original request completed')
  if (delivery !== 'hook-written') {
    await click(button('Check original response'))
    expect(inspect).toHaveBeenCalledWith(respond.mock.calls[0]![1].operationId)
  }
})

it.each(['saved', 'unknown'] as const)('does not turn a %s delivery into a successful compact result', async delivery => {
  await render(<AgentInteractionCard request={request()} onRespond={async (response, intent) => receipt(response, intent, { delivery })} />)
  await click(button('Allow once')); expectOpen()
})

it('keeps sending and failure actionable instead of converging, and retries the same original operation', async () => {
  const pending = deferred<AgentMuxInteractionOperationReceipt>(), respond = vi.fn<Respond>().mockReturnValueOnce(pending.promise)
    .mockImplementationOnce(async (response, intent) => receipt(response, intent, {}, false))
  await render(<AgentInteractionCard request={request()} onRespond={respond} />)
  await click(button('Allow once')); expectOpen(); expect(host.textContent).toContain('Sending answer…')
  await act(async () => pending.reject(new Error('Original dispatch failed')))
  expectOpen(); expect(host.textContent).toContain('Original dispatch failed'); expect(button('Allow once').disabled).toBe(false)
  await click(button('Allow once')); expect(respond.mock.calls[1]![1]).toBe(respond.mock.calls[0]![1]); expectOpen()
})

it.each(['operation', 'request', 'session', 'run', 'response'] as const)('rejects native completion from a different %s', async mismatch => {
  await render(<AgentInteractionCard request={request()} onRespond={async (response, intent) => {
    const value = receipt(response, intent)
    if (mismatch === 'operation') value.operationId = 'other-operation'
    if (mismatch === 'request') value.expectedRequest = request('permission', 'other-request')
    if (mismatch === 'session') value.agentSessionId = 'other-session'
    if (mismatch === 'run') value.run = { runId: 'other-run' }
    if (mismatch === 'response') value.response = { kind: 'permission', requestId: 'original-request', decision: { outcome: 'selected', optionId: 'deny' } }
    return value
  }} />)
  await click(button('Allow once')); expectOpen(); expect(host.textContent).not.toContain('Original request completed')
})

it.each(['resolve', 'reject'] as const)('ignores an old response Promise %s after a new request with the same ID arrives', async outcome => {
  const pending = deferred<AgentMuxInteractionOperationReceipt>(), respond = vi.fn<Respond>().mockReturnValue(pending.promise)
  const original = request(), next = { ...request(), title: 'A new original operation', toolInput: 'New exact parameters' }
  await render(<AgentInteractionCard request={original} onRespond={respond} />)
  await click(button('Allow once'))
  const [response, intent] = respond.mock.calls[0]!
  await render(<AgentInteractionCard request={next} onRespond={respond} />)
  await act(async () => outcome === 'resolve' ? pending.resolve(receipt(response, intent)) : pending.reject(new Error('Old request failure')))
  expectOpen(); expect(button('Allow once').disabled).toBe(false)
  expect(host.textContent).toContain('New exact parameters'); expect(host.textContent).not.toContain('Old request failure')
  expect(host.textContent).not.toContain('Original request completed')
})

it.each(['resolve', 'reject'] as const)('ignores an old inspection %s and accepts only the new request completion', async outcome => {
  const pending = deferred<AgentMuxInteractionOperationReceipt | null>(), respond = vi.fn<Respond>(async (response, intent) =>
    receipt(response, intent, intent.expectedRequest.id === 'original-request' ? { delivery: 'unknown' } : {}, intent.expectedRequest.id !== 'original-request'))
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={() => pending.promise} />)
  await click(button('Allow once')); await click(button('Check original response'))
  const [response, intent] = respond.mock.calls[0]!
  await render(<AgentInteractionCard request={request('question', 'next-request')} onRespond={respond} onInspect={() => pending.promise} />)
  await act(async () => outcome === 'resolve' ? pending.resolve(receipt(response, intent)) : pending.reject(new Error('Old inspection failure')))
  expectOpen(); expect(host.textContent).not.toContain('Old inspection failure')
  await click(button('First approach'))
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
})

it('converges an exact inspected completion and retains the same original operation and disclosure', async () => {
  let inspected: AgentMuxInteractionOperationReceipt
  const respond = vi.fn<Respond>(async (response, intent) => {
    inspected = receipt(response, intent)
    return receipt(response, intent, { delivery: 'unknown' }, false)
  })
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={async () => inspected} />)
  await click(button('Allow once')); expectOpen()
  await click(button('Check original response'))
  expect(panel().hasAttribute('inert')).toBe(true)
  await click(button('Details')); expect(host.textContent).toContain('{"path":"src/original.ts"}'); expect(respond).toHaveBeenCalledOnce()
})

it('preserves completion across unchanged request snapshots and excludes a mismatched inspected receipt', async () => {
  const original = request(), respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { delivery: 'unknown' }, false))
  const inspect = vi.fn(async () => receipt(respond.mock.calls[0]![0], respond.mock.calls[0]![1], { operationId: 'wrong-operation' }))
  await render(<AgentInteractionCard request={original} onRespond={respond} onInspect={inspect} />)
  await click(button('Allow once')); await click(button('Check original response')); expectOpen()
  inspect.mockImplementation(async () => receipt(respond.mock.calls[0]![0], respond.mock.calls[0]![1]))
  await click(button('Check original response')); await click(button('Details'))
  const body = panel(), control = button('Details')
  const { evidence, ...target } = original
  await render(<AgentInteractionCard request={{ evidence, ...target }} onRespond={respond} onInspect={inspect} />)
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  expect(panel()).toBe(body); expect(button('Details')).toBe(control); expect(control.getAttribute('aria-expanded')).toBe('true')
})

it('review S1: an inspection failure cannot veto a later exact native completion', async () => {
  const respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { delivery: 'unknown' }, false))
  const inspect = vi.fn<() => Promise<AgentMuxInteractionOperationReceipt | null>>()
    .mockRejectedValueOnce(new Error('Original operation inspection failed'))
    .mockImplementationOnce(async () => receipt(...respond.mock.calls[0]!))
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={inspect} />)
  await click(button('Allow once')); await click(button('Check original response'))
  expectOpen(); expect(host.textContent).toContain('Original operation inspection failed')
  await click(button('Check original response'))
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  expect(host.textContent).not.toContain('Original operation inspection failed')
  expect(host.textContent).toContain('Original request completed'); expect(respond).toHaveBeenCalledOnce()
})

it('review S1: an older inspection rejection cannot undo an exact completed receipt', async () => {
  const pending = deferred<AgentMuxInteractionOperationReceipt | null>()
  const respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { delivery: 'unknown' }, false))
  const inspect = vi.fn<() => Promise<AgentMuxInteractionOperationReceipt | null>>().mockReturnValueOnce(pending.promise)
    .mockImplementationOnce(async () => receipt(...respond.mock.calls[0]!))
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={inspect} />)
  await click(button('Allow once')); await click(button('Check original response')); await click(button('Check original response'))
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  await act(async () => pending.reject(new Error('Older inspection failed')))
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  expect(host.textContent).not.toContain('Older inspection failed'); expect(respond).toHaveBeenCalledOnce()
})

it('review S2: a rejected foreign receipt retains original-operation inspection', async () => {
  const respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { operationId: 'foreign-operation' }))
  const inspect = vi.fn(async (_operationId: string) => receipt(...respond.mock.calls[0]!)), openTerminal = vi.fn()
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={inspect} onOpenTerminal={openTerminal} />)
  await click(button('Allow once')); expectOpen()
  expect(host.textContent).toContain('Response receipt association is unconfirmed')
  expect(host.textContent).not.toContain('Answer sent')
  expect(button('Allow once').disabled).toBe(true); expect(button('Deny').disabled).toBe(true)
  await click(button('Open terminal')); expect(openTerminal).toHaveBeenCalledOnce()
  await click(button('Check original response'))
  expect(inspect).toHaveBeenCalledExactlyOnceWith(respond.mock.calls[0]![1].operationId)
  expect(inspect).not.toHaveBeenCalledWith('foreign-operation')
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  expect(host.textContent).not.toContain('Response receipt association is unconfirmed'); expect(respond).toHaveBeenCalledOnce()
})

it.each(['unknown', 'saved'] as const)('keeps an exact completion when an older inspection returns %s', async delivery => {
  const pending = deferred<AgentMuxInteractionOperationReceipt | null>()
  const respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { delivery: 'unknown' }, false))
  const inspect = vi.fn<() => Promise<AgentMuxInteractionOperationReceipt | null>>().mockReturnValueOnce(pending.promise)
    .mockImplementationOnce(async () => receipt(...respond.mock.calls[0]!))
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={inspect} />)
  await click(button('Allow once')); await click(button('Check original response')); await click(button('Check original response'))
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  await act(async () => pending.resolve(receipt(...respond.mock.calls[0]!, { delivery }, false)))
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  expect(host.textContent).toContain('Original request completed'); expect(panel().hasAttribute('inert')).toBe(true)
  expect(respond).toHaveBeenCalledOnce()
})

it.each([true, false])('names the missing inspection capability and preserves terminal recovery=%s without resending', async terminalAvailable => {
  const respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { operationId: 'foreign-operation' }))
  const openTerminal = vi.fn()
  await render(<AgentInteractionCard request={request()} onRespond={respond} {...(terminalAvailable ? { onOpenTerminal: openTerminal } : {})} />)
  await click(button('Allow once')); expectOpen()
  expect(host.textContent).toContain('Response receipt association is unconfirmed')
  expect(host.textContent).toContain('Original-operation inspection is unavailable here')
  expect(host.textContent).not.toContain('Answer sent')
  expect(host.querySelector('.agent-interaction')?.textContent).toContain('{"path":"src/original.ts"}')
  expect([...host.querySelectorAll('button')].some(control => control.textContent?.trim() === 'Check original response')).toBe(false)
  expect(button('Allow once').disabled).toBe(true)
  if (terminalAvailable) { await click(button('Open terminal')); expect(openTerminal).toHaveBeenCalledOnce() }
  else expect([...host.querySelectorAll('button')].some(control => control.textContent?.trim() === 'Open terminal')).toBe(false)
  expect(respond).toHaveBeenCalledOnce()
})

it('preserves original-operation recovery under caller status and keeps rejecting unrelated inspection receipts', async () => {
  const respond = vi.fn<Respond>(async (response, intent) => receipt(response, intent, { operationId: 'foreign-operation' }))
  const inspect = vi.fn<() => Promise<AgentMuxInteractionOperationReceipt | null>>()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(async () => receipt(...respond.mock.calls[0]!, { operationId: 'foreign-inspection' }))
    .mockImplementationOnce(async () => receipt(...respond.mock.calls[0]!))
  const renderReceipt = vi.fn(() => <span>Associated receipt only</span>)
  await render(<AgentInteractionCard request={request()} onRespond={respond} onInspect={inspect}
    responseStatus={<p>Retained caller status</p>} renderReceipt={renderReceipt} />)
  await click(button('Allow once')); expectOpen()
  expect(host.textContent).toContain('Retained caller status'); expect(host.textContent).toContain('Response receipt association is unconfirmed')
  expect(renderReceipt).not.toHaveBeenCalled()
  await click(button('Check original response')); expectOpen()
  await click(button('Check original response')); expectOpen()
  expect(renderReceipt).not.toHaveBeenCalled()
  await click(button('Check original response'))
  expect(host.querySelector('.agent-interaction')?.getAttribute('data-completed')).toBe('true')
  expect(host.textContent).not.toContain('Response receipt association is unconfirmed'); expect(respond).toHaveBeenCalledOnce()
})
