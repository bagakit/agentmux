import { act } from 'react'
import { expect, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentTimelineSnapshot } from '@agentmux/core'
import { SessionMailbox } from '../../src/renderer/src/components/SessionMailbox'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { composerDOM, composerSession } from './composer-dom-fixture'

/** Mount the original Desktop reader; input facts are supplied by the actual Core journal. */
export function externalIngressMailbox() {
  const dom = composerDOM()
  return async (session: AgentMuxAgentSession, timeline: AgentTimelineSnapshot, recordId: string) => {
    const projected = { ...composerSession(session.agentSessionId, session.providerId), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: session.agentSessionId, run: session.run } }
    useAppStore.setState({ sessions: [projected], noticeReadReceipts: {}, timelines: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {} })
    vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
    vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ dispose: vi.fn() })
    vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(null)
    const copy = vi.fn(async () => true)
    await dom.render(<SessionMailbox control={projected.control} system={{ available: true, notices: [], unread: [], acknowledge: vi.fn() }} queued={[]} timeline={timeline} onCopyQueued={copy} />)
    const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
    await act(async () => panel.dispatchEvent(event))
    await dom.click('[role="tab"][id$="-outbox-tab"]')
    const row = panel.querySelector<HTMLButtonElement>(`[data-record-key="timeline:${recordId}"]`)!
    expect(row).not.toBeNull(); await act(async () => row.click())
    const detail = panel.querySelector<HTMLElement>('.log-turn')!
    await dom.click('[aria-label="Message details"]')
    return { detail, copy, copyOriginal: () => dom.click('[aria-label="Copy message"]') }
  }
}
