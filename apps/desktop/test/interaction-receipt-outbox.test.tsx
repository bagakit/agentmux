// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AgentInputSubmissionReceipt, AgentInputWaitStopReceipt } from '@agentmux/core'
import { ComposerOutbox } from '../src/renderer/src/components/ComposerOutbox'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('renders only the original Outbox wait as stopped at an equal waiting generation', async () => {
  const key = { kind: 'message' as const, agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, messageId: 'original-message' }
  const ref = { key, waitGeneration: 1 }
  const inputReceipt: AgentInputSubmissionReceipt = { key, ref, persistence: 'confirmed', admission: null, status: 'waiting',
    observation: 'rejoin-needed', control: { ref, state: 'enabled', at: 1 } }
  const originalStop: AgentInputWaitStopReceipt = { ref, outcome: 'stopped-before-dispatch', at: 2, cancelOperationId: 'original-stop' }
  const otherStop = { ...originalStop, ref: { ...ref, key: { ...key, messageId: 'other-message' } } }
  const entry = { id: key.messageId, text: 'Original waiting body', status: 'queued' as const, deliverable: true, inputReceipt }
  const render = (inputStopReceipt: AgentInputWaitStopReceipt) => dom.render(<ComposerOutbox queued={[{ ...entry, inputStopReceipt }]}
    selectedId={entry.id} onSelect={vi.fn()} onCancelPreparation={vi.fn()} />)
  await render(otherStop)
  const row = () => dom.container.querySelector('[data-record-key="queue:original-message"]')!
  expect(row().textContent).toContain('已保存 · 等待确认')
  expect(row().textContent).not.toContain('已停止等待')
  expect(row().textContent).toContain(entry.text)
  await render(originalStop)
  expect(row().textContent).toContain('已停止等待')
})
