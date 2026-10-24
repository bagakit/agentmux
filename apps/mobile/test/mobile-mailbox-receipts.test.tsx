import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentInputMailboxItem, AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import { MobileConversationHeaderFixture as MobileConversationSurface } from './conversation-header-fixture'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { acceptedPrompt, button, click, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(async () => {
  localStorage.clear()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const view of mounted.splice(0)) {
    await act(async () => view.root.unmount())
    view.element.remove()
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it.each([
  { kind: 'controlled', sameRun: true }, { kind: 'submission', sameRun: true },
  { kind: 'controlled', sameRun: false }, { kind: 'submission', sameRun: false },
] as const)('reads $kind records without conflating input identities (same Run: $sameRun)', async ({ kind, sameRun }) => {
  const f = fixture()
  const text = 'Keep the original input receipt inspectable'
  let item: AgentInputMailboxItem
  f.submit.mockImplementation(async input => {
    const receipt = await acceptedPrompt(input)
    if (!receipt?.admission) throw new Error('Expected the original controlled input receipt')
    const recorded = sameRun ? receipt : await acceptedPrompt({ ...input, expectedRun: { runId: 'another-original-run' } })
    if (!recorded?.admission) throw new Error('Expected the recorded original Run receipt')
    const position = { sequence: 1, recordedAt: fixtureEpoch(0, 0, 1) }
    item = kind === 'controlled'
      ? { ...position, kind, intent: { key: recorded.key,
          admissionIntent: { kind: 'manual-actor', expectedRun: recorded.key.expectedRun }, execution: 'immediate',
          source: { kind: 'prompt', prompt: input.prompt, authorHuman: true } }, receipt: recorded }
      : { ...position, kind, key: recorded.key, record: recorded.admission }
    return receipt
  })
  const read = vi.fn<typeof f.client.readAgentInputMailbox>(async input => ({
    agentSessionId: input.agentSessionId, queueId: 'original-input-journal',
    cut: { incarnation: 'original-journal', throughSequence: 1 }, budgetBytes: input.maxBytes ?? 64 * 1024,
    items: [{ kind: 'item', item }], nextCursor: null,
    coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' },
  } satisfies AgentInputMailboxPage))
  f.client.readAgentInputMailbox = read
  const view = await mount(<MobileConversationSurface client={f.client} agentSessionId="session-original"
    connection={{ state: 'connected', message: 'Original connection' }} platform={createBrowserPlatform()} />)
  await paste(view.element, text)
  await click(button(view.element, 'Send'))
  expect(f.submit).toHaveBeenCalledOnce()
  await click(view.element.querySelector<HTMLButtonElement>('.mobile-message-tools__trigger')!)
  await act(async () => { await vi.waitFor(() => {
    expect(document.body.querySelector('[data-input-mailbox-key]')?.textContent).toContain(text)
  }) })
  const localReceipt = document.body.querySelector('.mobile-message-tools__attempt')
  if (sameRun) expect(localReceipt).toBeNull()
  else {
    expect(document.body.querySelector('[data-input-mailbox-key]')?.getAttribute('data-input-mailbox-key')).toContain('another-original-run')
    expect(localReceipt?.getAttribute('data-operation-id')).toBe(f.submit.mock.calls[0]![0].operationId)
  }
  expect(f.submit).toHaveBeenCalledOnce()
})
