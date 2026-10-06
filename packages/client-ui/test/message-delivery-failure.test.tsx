import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageDeliveryFailure } from '../src/components/MessageDeliveryFailure.js'
import { messageDeliveryDiagnosticExport, messageDeliveryDiagnosticReport, presentMessageDeliveryFailure } from '../src/lib/message-delivery-presentation.js'
import type { ClientDeliveryLog } from '../src/lib/delivery-diagnostics.js'
import type { AgentInputSubmissionReceipt, AgentInputWaitStopReceipt } from '@agentmux/core'

const logId = 'delivery-6156f51c-b81f-42cd-959a-1c43b99742be'
const original = 'Original input preparation timed out. {"preclaimObservation":{"phase":"current-pane"}}'
const failure = () => Object.assign(new Error(original), { code: 'AGENT_PROMPT_PREPARATION_FAILED',
  detail: '{"complete":"unaltered nested detail"}', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
function savedInput(): AgentInputSubmissionReceipt {
  const key = { kind: 'prompt' as const, agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, submissionId: 'original-operation' }
  const ref = { key, waitGeneration: 1 }
  return { key, ref, persistence: 'confirmed', admission: null, status: 'waiting', observation: 'rejoin-needed',
    control: { ref, state: 'enabled', at: _reshape_fixtureEpoch(0, 0, 2), waiting: { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin',
      failure: { name: 'AbortError', message: 'This operation was aborted' }, observation: { phase: 'native-peer' } } } }
}
const log = (): ClientDeliveryLog => ({ owner: 'original-owner', localSaved: true, localIssue: null, notificationIssue: null, remote: null, reportIssue: null,
  record: { logId, source: 'client', hostId: 'original-host', agentSessionId: 'original-session', expectedRunId: 'original-run',
    operationId: 'original-operation', afterSubmissionId: 'previous-submission', conditionAvailable: true, promptDigest: null,
    execution: 'immediate', startedAt: _reshape_fixtureEpoch(0, 0, 1), failedAt: _reshape_fixtureEpoch(0, 0, 2), stage: 'core-submit', error: {
      name: 'AgentMuxError', message: original, code: 'AGENT_PROMPT_PREPARATION_FAILED', detail: '{"original":"detail"}',
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
    } } })
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = async (node: ReactNode) => { await act(async () => root.render(node)) }
async function click(label = '复制诊断摘要') {
  const button = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)
  expect(button).toBeDefined(); await act(async () => button!.click())
}

it('shows concise preparation cause and state while preserving the original error and all stable diagnostic identities', async () => {
  const copy = vi.fn<(text: string) => Promise<boolean>>(async () => true), error = failure(), diagnostic = log()
  await render(<MessageDeliveryFailure error={error} logId={logId} log={diagnostic} copyText={copy} />)
  expect(container.querySelector('.message-delivery-failure__heading')!.textContent).toBe('本次准备未完成')
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('尚未写入输入')
  expect(container.querySelector('.message-delivery-failure__state')!.textContent).not.toContain('preclaimObservation')
  expect(container.querySelector('details')!.open).toBe(false)
  expect(container.querySelector('summary')!.textContent).toBe('技术详情')
  await click('复制完整资料')
  const report = copy.mock.calls[0]![0]
  expect(JSON.parse(report).error).toMatchObject({ message: original, detail: error.detail, stack: error.stack })
  for (const value of [logId, 'original-host', 'original-session', 'original-run', 'original-operation', 'previous-submission']) expect(report).toContain(value)
  expect(container.querySelector('[data-copy-state]')!.textContent).toBe('完整资料已复制')
  expect(container.querySelector('[aria-label="完整诊断原文"]')!.textContent).toBe(report)
})

it('the compact host presentation folds explanations without clipping original diagnostics or changing retry and copy receipts', async () => {
  const copy = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const retry = vi.fn(), error = failure(), diagnostic = log()
  await render(<MessageDeliveryFailure compact error={error} logId={logId} log={diagnostic} copyText={copy} onRetry={retry} />)
  expect(container.querySelector('section')?.dataset.compact).toBe('true')
  expect(container.querySelector('details')!.open).toBe(false)
  expect(container.querySelector('.message-delivery-failure__state')!.closest('details')).not.toBeNull()
  expect(container.querySelector('summary')!.textContent).toBe('详情')
  await click(); expect(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('failed')
  await click(); expect(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('copied')
  const report = copy.mock.calls[1]![0]
  expect(report).toBe(messageDeliveryDiagnosticReport({ error, logId, log: diagnostic }))
  expect(container.querySelector('[aria-label="诊断摘要"]')!.textContent).toBe(report)
  for (const value of [logId, 'original-host', 'original-session', 'original-run', 'original-operation', 'previous-submission']) expect(report).toContain(value)
  expect(retry).not.toHaveBeenCalled()
  await click('重试'); expect(retry).toHaveBeenCalledTimes(1)
})

it('only describes compaction from typed facts and this-call no-input evidence; original unknown takes precedence', () => {
  expect(presentMessageDeliveryFailure({ error: failure(), preparationReason: 'context-compaction' })).toMatchObject({ kind: 'waiting', title: '正在整理上下文' })
  expect(presentMessageDeliveryFailure({ error: failure(), preparationReason: 'native-busy' })).toMatchObject({ kind: 'waiting', title: 'Agent 暂时忙碌' })
  expect(presentMessageDeliveryFailure({ error: failure(), preparationReason: 'context-compaction', inputUnconfirmed: true })).toMatchObject({ kind: 'unknown', title: '发送结果待核实' })
  const unknown = Object.assign(failure(), { controlFailure: { disposition: 'unknown', confirmedInputBytes: 0 } })
  expect(presentMessageDeliveryFailure({ error: unknown, preparationReason: 'context-compaction' }).state).not.toContain('尚未写入')
  expect(presentMessageDeliveryFailure({ error: 'Compacting context · esc to interrupt' }).title).not.toBe('正在整理上下文')
})

it('keeps old generic failures honest and does not clip complete copy even beyond the usual diagnostic budget', async () => {
  const raw = 'Legacy error {"detail":"' + '原始事实'.repeat(18000) + '"}\nfinal-marker', copy = vi.fn<(text: string) => Promise<boolean>>(async () => true)
  await render(<MessageDeliveryFailure error={raw} copyText={copy} />)
  expect(container.querySelector('[role="alert"]')!.textContent).not.toContain('尚未写入')
  expect(container.querySelector('.message-delivery-failure__next')!.textContent).toContain('输入结果未知')
  await click('复制完整资料')
  expect(JSON.parse(copy.mock.calls[0]![0]).error).toBe(raw)
  expect(JSON.parse(messageDeliveryDiagnosticExport({ error: raw })).error).toContain('final-marker')
})

it('separates a known condition refusal from the original unknown delivery without recommending the frozen retry', () => {
  const error = Object.assign(new Error('Original condition changed.'), { code: 'AGENT_PROMPT_CONDITION_CHANGED',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
  const result = presentMessageDeliveryFailure({ error, inputUnconfirmed: true })
  expect(result).toMatchObject({ kind: 'condition-changed', title: '发送条件已变化' })
  expect(result.state).toContain('本次尝试未写入')
  expect(result.state).toContain('此前的投递结果仍需核对')
  expect(result.action).toContain('新消息')
  expect(result.action).not.toContain('重试')
  expect(presentMessageDeliveryFailure({ error: Object.assign(error, { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' }),
    inputUnconfirmed: true }).kind).toBe('unknown')
})

it('does not expose the unchanged-condition retry callback while copy and original details remain available', async () => {
  const retry = vi.fn(), copy = vi.fn(async () => true)
  await render(<MessageDeliveryFailure error={Object.assign(new Error('Original condition changed'), {
    code: 'AGENT_PROMPT_CONDITION_CHANGED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
  })} inputUnconfirmed onRetry={retry} copyText={copy} />)
  expect(container.querySelector('[data-kind="condition-changed"]')).not.toBeNull()
  expect([...container.querySelectorAll('button')].some(button => button.textContent === '重试此操作')).toBe(false)
  await click()
  expect(copy).toHaveBeenCalledTimes(1)
  expect(retry).not.toHaveBeenCalled()
})

it.each(['false', 'reject'] as const)('reports actual clipboard %s and allows copying again without replaying Input', async outcome => {
  const copy = vi.fn<(text: string) => Promise<boolean>>()
  if (outcome === 'false') copy.mockResolvedValueOnce(false); else copy.mockRejectedValueOnce(new Error('OS clipboard refused'))
  copy.mockResolvedValueOnce(true)
  const retry = vi.fn()
  await render(<MessageDeliveryFailure error={failure()} copyText={copy} onRetry={retry} />)
  await click(); expect(container.querySelector('[data-copy-state]')!.textContent).toContain('复制失败')
  await click(); expect(container.querySelector('[data-copy-state]')!.textContent).toBe('诊断摘要已复制')
  expect(copy.mock.calls[0]![0]).toBe(copy.mock.calls[1]![0]); expect(retry).not.toHaveBeenCalled()
})

it('cannot let an old delayed clipboard completion acknowledge a different report', async () => {
  let release!: (copied: boolean) => void
  const copy = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))
  await render(<MessageDeliveryFailure error={failure()} logId={logId} copyText={copy} />)
  await click(); expect(container.querySelector('[aria-label="复制诊断摘要"]')!.hasAttribute('disabled')).toBe(true)
  await render(<MessageDeliveryFailure error="A different original error" copyText={copy} />)
  await act(async () => release(true))
  expect(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('idle')
})

it('uses the saved Core receipt after observation ends, retaining the full receipt and original error in copy', async () => {
  const inputReceipt = savedInput(), error = new DOMException('This operation was aborted', 'AbortError')
  const copy = vi.fn(async (_text: string) => true), retry = vi.fn()
  await render(<MessageDeliveryFailure compact error={error} inputReceipt={inputReceipt} copyText={copy} onRetry={retry} />)
  expect(container.querySelector('section')!.dataset.kind).toBe('saved-waiting')
  expect(container.querySelector('.message-delivery-failure__heading')!.textContent).toBe('已保存 · 等待确认')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector('.message-delivery-failure__next')!.textContent).toContain('继续确认原环境')
  await click('复制完整资料')
  const report = copy.mock.calls[0]![0]
  expect(report).toContain('This operation was aborted')
  expect(JSON.parse(report).inputReceipt).toEqual(inputReceipt)
  expect(report).not.toContain('输入结果未知')
  expect(retry).not.toHaveBeenCalled()
  await click('继续确认'); expect(retry).toHaveBeenCalledOnce()
})

it('does not infer waiting or a non-dispatch result from an AbortError or a phase without a Core receipt', () => {
  const error = { name: 'AbortError', message: 'This operation was aborted', waitingObservation: { phase: 'native-peer' } }
  expect(presentMessageDeliveryFailure({ error }).kind).toBe('unknown')
})

it.each(['prior-unknown', 'partial', 'dispatch', 'admission', 'unknown-receipt'] as const)(
  'keeps %s evidence ahead of a waiting projection', evidence => {
    const inputReceipt = savedInput()
    if (evidence === 'dispatch') inputReceipt.control.state = 'dispatch-authorized'
    if (evidence === 'admission') inputReceipt.admission = { agentSessionId: inputReceipt.key.agentSessionId, run: inputReceipt.key.expectedRun }
    if (evidence === 'unknown-receipt') inputReceipt.status = 'unknown'
    const result = presentMessageDeliveryFailure({ inputReceipt, inputUnconfirmed: evidence === 'prior-unknown',
      error: evidence === 'partial' ? { controlFailure: { disposition: 'not_applied', confirmedInputBytes: 1 } } : new Error('observation ended') })
    expect(result.kind).toBe('unknown')
    expect(result.action).toContain('避免重复发送')
  })

it('keeps an exact stop receipt ahead of a stale waiting projection, without borrowing another key or generation', () => {
  const inputReceipt = savedInput()
  const inputStopReceipt: AgentInputWaitStopReceipt = { ref: structuredClone(inputReceipt.ref), cancelOperationId: 'original-stop', outcome: 'stopped-before-dispatch', at: _reshape_fixtureEpoch(0, 0, 3) }
  expect(presentMessageDeliveryFailure({ error: 'inspect failed', inputReceipt, inputStopReceipt }).kind).toBe('stopped')
  const report = messageDeliveryDiagnosticExport({ error: 'inspect failed', inputReceipt, inputStopReceipt })
  expect(JSON.parse(report).inputStopReceipt).toEqual(inputStopReceipt)
  for (const ref of [
    { ...inputReceipt.ref, waitGeneration: 2 },
    { ...inputReceipt.ref, key: { ...inputReceipt.key, agentSessionId: 'other-session' } },
    { ...inputReceipt.ref, key: { ...inputReceipt.key, expectedRun: { runId: 'other-run' } } },
    { ...inputReceipt.ref, key: { kind: 'prompt' as const, agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, submissionId: 'other-input' } },
    { ...inputReceipt.ref, key: { kind: 'message' as const, agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, messageId: 'original-operation' } }
  ]) expect(presentMessageDeliveryFailure({ error: 'inspect failed', inputReceipt, inputStopReceipt: { ...inputStopReceipt, ref } }).kind).toBe('saved-waiting')
})

it.each(['admitted', 'not-applied'] as const)('reports the original %s receipt and offers no replay callback', async status => {
  const inputReceipt = { ...savedInput(), status }, retry = vi.fn()
  const diagnostic = log()
  diagnostic.record.error.controlFailure = { disposition: 'unknown', confirmedInputBytes: 1 }
  await render(<MessageDeliveryFailure error="Old observation ended" errorCode="AGENT_PROMPT_CONDITION_CHANGED" log={diagnostic}
    inputUnconfirmed inputReceipt={inputReceipt} onRetry={retry} copyText={async () => true} />)
  expect(container.querySelector('section')!.dataset.kind).toBe(status)
  if (status === 'not-applied') {
    expect(container.querySelector('.message-delivery-failure__state')!.textContent).toContain('Core 已确认')
    expect(container.querySelector('.message-delivery-failure__state')!.textContent).not.toContain('Native 明确拒绝')
  }
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('重试'))).toBe(false)
  expect(retry).not.toHaveBeenCalled()
})


it('copies a compact source-labelled snapshot with exact input and machine reason, without stacks or duplicated waiting payloads', () => {
  const inputReceipt = savedInput()
  inputReceipt.control.waiting = { phase: 'native-environment', reason: 'original-environment-unconfirmed', wake: 'explicit-rejoin',
    mechanism: 'unconfirmed', observation: { phase: 'native-peer', failure: { name: 'AgentMuxError', code: 'AGENT_NATIVE_INPUT_UNCONFIRMED',
      message: 'Original channel is unconfirmed', detail: '{"phase":"native-peer","reason":"original-connection-absent"}', stack: 'STACK_MUST_STAY_IN_FULL' } } }
  const error = inputReceipt.control.waiting.observation!.failure!
  const report = messageDeliveryDiagnosticReport({ error, inputReceipt, logId })
  expect(report).toContain(JSON.stringify(inputReceipt.ref.key))
  expect(report.split('original-operation')).toHaveLength(2)
  expect(report).toContain('等待代次: 1')
  for (const value of ['status=waiting', 'control=enabled', 'persistence=confirmed', 'observation=rejoin-needed', 'native-peer（观察位置）',
    'reason=original-environment-unconfirmed', 'mechanism=unconfirmed', 'original-connection-absent', 'error.detail（收到的原因字段）', logId]) expect(report).toContain(value)
  expect(report).not.toContain('STACK_MUST_STAY_IN_FULL')
  expect(report).not.toContain('waitingObservation')
  expect(report).toContain('不代签此前未输入')
})

it('exports each received source once, references only the identical waiting error, and retains distinct equal errors and upstream truncation', () => {
  const inputReceipt = savedInput(), original = inputReceipt.control.waiting!
  if (original.phase !== 'observer') throw new Error('Fixture must use the actual observer receipt')
  const error = original.failure, diagnostic = log()
  const snapshot = JSON.parse(messageDeliveryDiagnosticExport({ error, inputReceipt, log: diagnostic }))
  expect(snapshot.error).toEqual({ sourceRef: 'inputReceipt.control.waiting.failure' })
  expect(snapshot.inputReceipt).toEqual(inputReceipt)
  expect(snapshot.log).toEqual(diagnostic)
  expect(messageDeliveryDiagnosticExport({ error, inputReceipt }).split('This operation was aborted')).toHaveLength(2)
  const other = { ...error, truncated: true, detail: 'Received bounded detail' }
  const distinct = JSON.parse(messageDeliveryDiagnosticExport({ error: other, inputReceipt }))
  expect(distinct.error).toEqual(other)
  expect(distinct.inputReceipt.control.waiting.failure).toEqual(error)
  expect(distinct.error).not.toHaveProperty('sourceRef')
  expect(distinct.scope).toContain('上游 truncated')
})

it('keeps received non-enumerable error fields, repeated shared objects, exact cause and cycles in full export', () => {
  const shared = { machine: 'unchanged' }, cause = new Error('Inner cause')
  const error = Object.assign(new Error('Original failure', { cause }), { detail: 'Received detail', left: shared, right: shared })
  Object.assign(cause, { parent: error })
  const exported = JSON.parse(messageDeliveryDiagnosticExport({ error }))
  expect(exported.error).toMatchObject({ message: error.message, stack: error.stack, detail: error.detail, left: shared, right: shared,
    cause: { message: cause.message, stack: cause.stack, parent: '[circular reference]' } })
})

it('invalidates a delayed copy when only full source changes, even while the summary is unchanged', async () => {
  let release!: (copied: boolean) => void
  const copy = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))
  const first = Object.assign(new Error('Same visible cause'), { stack: 'first-source-stack' })
  const second = Object.assign(new Error('Same visible cause'), { stack: 'second-source-stack' })
  expect(messageDeliveryDiagnosticReport({ error: first })).toBe(messageDeliveryDiagnosticReport({ error: second }))
  await render(<MessageDeliveryFailure error={first} copyText={copy} />)
  await click('复制完整资料')
  await render(<MessageDeliveryFailure error={second} copyText={copy} />)
  await act(async () => release(true))
  expect(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('idle')
  expect(container.querySelector('[data-full-copy-state]')!.getAttribute('data-full-copy-state')).toBe('idle')
})

it('keeps the two Clipboard actions separate and rejects stale results from the other action', async () => {
  let release!: (copied: boolean) => void
  const copy = vi.fn<(text: string) => Promise<boolean>>().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValueOnce(true)
  await render(<MessageDeliveryFailure error={failure()} copyText={copy} />)
  await click()
  await click('复制完整资料')
  await act(async () => release(false))
  expect(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-kind')).toBe('full')
  expect(container.querySelector('[data-full-copy-state]')!.textContent).toBe('完整资料已复制')
  expect(container.querySelector('[aria-label="复制诊断摘要"]')!.textContent).toBe('复制诊断')
  expect(copy.mock.calls[0]![0]).not.toContain('"stack"')
  expect(JSON.parse(copy.mock.calls[1]![0]).error.stack).toBeDefined()
})

it.each(['summary', 'full'] as const)('does not report a non-Boolean Clipboard response as %s success', async kind => {
  await render(<MessageDeliveryFailure error={failure()} copyText={async () => undefined as unknown as boolean} />)
  await click(kind === 'summary' ? '复制诊断摘要' : '复制完整资料')
  expect(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('failed')
})


it('exports DOMException name and message even when the platform stores them on its prototype', () => {
  const error = new DOMException('Original native observation stopped', 'AbortError')
  expect(JSON.parse(messageDeliveryDiagnosticExport({ error })).error).toMatchObject({ name: 'AbortError', message: 'Original native observation stopped' })
})

it('keeps partial and unknown evidence explicit in the brief, without calling the original input unsent', () => {
  const inputReceipt = savedInput()
  inputReceipt.control.state = 'dispatch-authorized'
  const report = messageDeliveryDiagnosticReport({ error: { name: 'Original', message: 'attempt stopped', controlFailure: { disposition: 'unknown', confirmedInputBytes: 12 } }, inputReceipt, inputUnconfirmed: true })
  expect(report).toContain('发送结果待核实')
  expect(report).toContain('control=dispatch-authorized')
  expect(report).toContain('"confirmedInputBytes":12')
  expect(report).not.toContain('尚未写入输入')
  expect(report).not.toContain('未被接纳')
})


it('keeps a distinct original Core failure beside a transport error without mistaking observation position for cause', () => {
  const inputReceipt = savedInput()
  inputReceipt.control.waiting = { phase: 'native-environment', reason: 'original-environment-unconfirmed', wake: 'explicit-rejoin',
    observation: { phase: 'native-peer', failure: { name: 'AgentMuxError', message: 'Original native channel unavailable',
      code: 'AGENT_NATIVE_INPUT_UNCONFIRMED', detail: '{"reason":"original-connection-absent"}' } } }
  const report = messageDeliveryDiagnosticReport({ error: new DOMException('Short observer ended', 'AbortError'), inputReceipt })
  expect(report).toContain('Short observer ended')
  expect(report).toContain('inputReceipt.control.waiting.observation.failure.detail（收到的原因字段）: {"reason":"original-connection-absent"}')
  expect(report).not.toContain('尚未写入输入')
})


it('presents terminal byte confirmation as information, without Native admission, task completion or a replay action', async () => {
  const inputReceipt = { ...savedInput(), status: 'terminal-confirmed' as const }, retry = vi.fn()
  await render(<MessageDeliveryFailure compact error="Old reader ended" inputReceipt={inputReceipt} onRetry={retry} copyText={async () => true} />)
  const surface = container.querySelector('section')!
  expect(surface.dataset.kind).toBe('terminal-confirmed')
  expect(surface.textContent).toContain('终端输入已确认')
  expect(surface.textContent).toContain('Native 是否采用尚未确认')
  expect(surface.textContent).toContain('不是任务完成')
  expect(surface.querySelector('[role="alert"]')).toBeNull()
  expect([...surface.querySelectorAll('button')].some(button => button.textContent?.includes('重试'))).toBe(false)
  expect(retry).not.toHaveBeenCalled()
})
