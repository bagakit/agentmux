import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageDeliveryFailure } from '../src/components/MessageDeliveryFailure.js'
import { messageDeliveryDiagnosticReport, presentMessageDeliveryFailure } from '../src/lib/message-delivery-presentation.js'
import type { ClientDeliveryLog } from '../src/lib/delivery-diagnostics.js'

const logId = 'delivery-6156f51c-b81f-42cd-959a-1c43b99742be'
const original = 'Original input preparation timed out. {"preclaimObservation":{"phase":"current-pane"}}'
const failure = () => Object.assign(new Error(original), { code: 'AGENT_PROMPT_PREPARATION_FAILED',
  detail: '{"complete":"unaltered nested detail"}', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
const log = (): ClientDeliveryLog => ({ owner: 'original-owner', localSaved: true, localIssue: null, notificationIssue: null, remote: null, reportIssue: null,
  record: { logId, source: 'client', hostId: 'original-host', agentSessionId: 'original-session', expectedRunId: 'original-run',
    operationId: 'original-operation', afterSubmissionId: 'previous-submission', conditionAvailable: true, promptDigest: null,
    execution: 'immediate', startedAt: 1, failedAt: 2, stage: 'core-submit', error: {
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
async function click(label = '复制完整诊断') {
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
  await click()
  const report = copy.mock.calls[0]![0]
  expect(report).toContain(original); expect(report).toContain(error.detail)
  for (const value of [logId, 'original-host', 'original-session', 'original-run', 'original-operation', 'previous-submission']) expect(report).toContain(value)
  expect(container.querySelector('[data-copy-state]')!.textContent).toBe('完整诊断已复制')
  expect(container.querySelector('pre')!.textContent).toBe(report)
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
  await click()
  expect(copy.mock.calls[0]![0]).toContain(raw)
  expect(messageDeliveryDiagnosticReport({ error: raw })).toContain('final-marker')
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
  await click(); expect(container.querySelector('[data-copy-state]')!.textContent).toBe('完整诊断已复制')
  expect(copy.mock.calls[0]![0]).toBe(copy.mock.calls[1]![0]); expect(retry).not.toHaveBeenCalled()
})

it('cannot let an old delayed clipboard completion acknowledge a different report', async () => {
  let release!: (copied: boolean) => void
  const copy = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))
  await render(<MessageDeliveryFailure error={failure()} logId={logId} copyText={copy} />)
  await click(); expect(container.querySelector('[aria-label="复制完整诊断"]')!.hasAttribute('disabled')).toBe(true)
  await render(<MessageDeliveryFailure error="A different original error" copyText={copy} />)
  await act(async () => release(true))
  expect(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-state')).toBe('idle')
})
