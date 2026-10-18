import { act } from 'react'
import { expect, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentMuxClient, AgentTimelineSnapshot, AgentPromptInputKey, AgentPromptSubmissionRecord } from '@agentmux/core'
import { inputMailboxKey } from '@agentmux/client-ui/use-agent-input-mailbox'
import { SessionMailbox } from '../../src/renderer/src/components/SessionMailbox'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { composerDOM, composerSession } from './composer-dom-fixture'

/** Mount the original Desktop reader; input facts are supplied by the actual Core journal. */
export function externalIngressMailbox() {
  const dom = composerDOM()
  return async (session: AgentMuxAgentSession, client: Pick<AgentMuxClient, 'readAgentInputMailbox' | 'inspectAgentPromptSubmission'>, input: AgentPromptInputKey, timeline: AgentTimelineSnapshot) => {
    const projected = { ...composerSession(session.agentSessionId, session.providerId), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: session.agentSessionId, run: session.run } }
    useAppStore.setState({ sessions: [projected], noticeReadReceipts: {}, timelines: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {} })
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ dispose: vi.fn() })
    vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(null)
    const reader = vi.spyOn(api.sessions, 'inputMailbox').mockImplementation((target, options) => {
      expect(target).toEqual({ hostId: 'local', agentSessionId: session.agentSessionId })
      return client.readAgentInputMailbox({ ...options, agentSessionId: target.agentSessionId })
    })
    const key = inputMailboxKey('local', input)
    let original: AgentPromptSubmissionRecord | null = null
    await vi.waitFor(async () => {
      original = await client.inspectAgentPromptSubmission(input)
      expect(original?.admission?.intent?.prompt).toBeDefined()
    })
    const copy = vi.fn(async () => true)
    await dom.render(<SessionMailbox control={projected.control} system={{ available: true, notices: [], unread: [], acknowledge: vi.fn() }} queued={[]} timeline={timeline} onCopyQueued={copy} />)
    const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
    await act(async () => panel.dispatchEvent(event))
    await dom.click('[role="tab"][id$="-user-tab"]')
    let row: HTMLButtonElement | undefined
    await vi.waitFor(async () => {
      await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
      row = Array.from(panel.querySelectorAll<HTMLButtonElement>('button[data-record-key]')).find(candidate => candidate.dataset.recordKey === key)
      expect(reader).toHaveBeenCalled()
      expect(row, JSON.stringify({ key, records: Array.from(panel.querySelectorAll<HTMLElement>('[data-record-key]')).map(node => node.dataset.recordKey) })).toBeDefined()
    })
    expect(reader).toHaveBeenCalled()
    await act(async () => row!.click())
    const detail = panel.querySelector<HTMLElement>('.log-turn')!
    expect(detail).not.toBeNull()
    await dom.click('[aria-label="Message details"]')
    return { detail, copy, key, original: original!, copyOriginal: () => dom.click('[aria-label="Copy message"]') }
  }
}
