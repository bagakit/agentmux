// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const session = () => ({ ...composerSession(), terminalPromptDelivery: {
  state: 'unverified' as const, mode: 'degraded' as const, reason: 'screen-evidence-gap' as const,
  submissionId: 'submission-1', run: { runId: 'run-agent-1' }, observedAt: 1
} })
beforeEach(() => useAppStore.setState({ sessions: [session()], noticeReadReceipts: {} }))
const banners = () => dom.container.querySelectorAll('.composer__notices .composer-notice')
const inbox = () => dom.container.querySelector('.composer__inbox-card')!

it('moves the real Session delivery notice into the inbox without clearing the Core fact', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(banners()).toHaveLength(1)
  expect(inbox().textContent).toContain('screen confirmation')
  await dom.click('.composer__notices [aria-label="Move notice to inbox"]')
  expect(banners()).toHaveLength(0)
  expect(dom.container.querySelector('.composer__inbox')?.getAttribute('aria-label')).toContain('1 current, 0 unread')
  expect(useAppStore.getState().sessions[0]).toMatchObject({ terminalPromptDelivery: session().terminalPromptDelivery })
  // Remount and a fresh store projection model a restarted renderer reading its persisted receipt.
  const persisted = JSON.parse(JSON.stringify(useAppStore.persist.getOptions().partialize!(useAppStore.getState())))
  expect(persisted.noticeReadReceipts['agent-1'].delivery).toBeTruthy()
  await dom.render(null)
  await act(async () => useAppStore.setState({ noticeReadReceipts: persisted.noticeReadReceipts }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(banners()).toHaveLength(0)
  expect(inbox().textContent).toContain('screen confirmation')
})

it('coalesces repetitions but reopens changed causes and a recurrence after recovery', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer__notices [aria-label="Move notice to inbox"]')
  const repeated = session()
  repeated.terminalPromptDelivery.submissionId = 'submission-2'
  repeated.terminalPromptDelivery.observedAt = 2
  await act(async () => useAppStore.setState({ sessions: [repeated] }))
  expect(banners()).toHaveLength(0)
  await act(async () => useAppStore.setState({ sessions: [{ ...repeated,
    terminalPromptDelivery: { ...repeated.terminalPromptDelivery, reason: 'prompt-render-timeout' } }] }))
  expect(banners()).toHaveLength(1)
  await dom.click('.composer__notices [aria-label="Move notice to inbox"]')
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(inbox().textContent).toContain('No current notices.')
  expect(useAppStore.getState().noticeReadReceipts['agent-1']).toBeUndefined()
  await act(async () => useAppStore.setState({ sessions: [session()] }))
  expect(banners()).toHaveLength(1)
})

it('keeps the inbox enabled in every mode, even when prompt input is disabled, and scopes receipts', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" disabled />)
  for (const mode of ['collapsed', 'current', 'expanded']) {
    expect(dom.container.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe(mode)
    const trigger = dom.container.querySelector<HTMLButtonElement>('.composer__inbox')!
    expect(trigger.disabled).toBe(false)
    expect(document.getElementById(trigger.getAttribute('popovertarget')!)).toBe(inbox())
    await dom.click('.composer-tool--mode')
  }
  await dom.click('.composer__notices [aria-label="Move notice to inbox"]')
  await act(async () => useAppStore.setState({ sessions: [session(), { ...session(), id: 'other' }] }))
  await dom.render(<AgentSessionComposer key="other" sessionId="other" />)
  expect(banners()).toHaveLength(1)
  expect(useAppStore.getState().noticeReadReceipts['agent-1']?.delivery).toBeTruthy()
})

it('collects queue problems in the same inbox, preserving messages and recovery actions', async () => {
  const queued = { operationId: 'queued-1', runId: 'run-agent-1', text: 'Keep these words',
    status: 'deferred' as const, error: 'Input confirmation is pending. Diagnostic: private-cursor=123' }
  useAppStore.setState({ agentSteerQueues: { 'agent-1': [queued] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(banners()).toHaveLength(2)
  expect(dom.container.querySelector('.composer__queue-notice')).toBeNull()
  expect(dom.container.querySelector('.composer__notices')?.textContent).not.toContain('private-cursor')
  await dom.click('.composer__notices [aria-label="Move notice to inbox"]')
  await dom.click('.composer__notices [aria-label="Move notice to inbox"]')
  expect(banners()).toHaveLength(0)
  expect(inbox().querySelectorAll('.composer-notice')).toHaveLength(2)
  expect(dom.container.querySelector('.composer__queued-card')?.textContent).toContain('Keep these words')
  expect(dom.container.querySelector('.composer__queued-card')?.textContent).toContain('Retry queue')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([queued])
  await act(async () => useAppStore.setState({ agentSteerQueues: {} }))
  expect(inbox().querySelectorAll('.composer-notice')).toHaveLength(1)
  expect(inbox().textContent).not.toContain('Input confirmation is pending')
})

it('retains acknowledgement through the empty restart snapshot, but a new Run alerts again', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer__notices [aria-label="Move notice to inbox"]')
  const receipt = useAppStore.getState().noticeReadReceipts['agent-1']
  await dom.render(null)
  await act(async () => useAppStore.setState({ sessions: [] }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(inbox().textContent).toContain('Waiting for Session status.')
  expect(useAppStore.getState().noticeReadReceipts['agent-1']).toEqual(receipt)
  await act(async () => useAppStore.setState({ sessions: [session()] }))
  expect(banners()).toHaveLength(0)
  const resumed = session()
  resumed.control = { ...resumed.control, run: { runId: 'new-run' } }
  resumed.terminalPromptDelivery.run = { runId: 'new-run' }
  await act(async () => useAppStore.setState({ sessions: [resumed] }))
  expect(banners()).toHaveLength(1)
})
