import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { ServiceWindowNotice } from '../src/renderer/src/components/ServiceWindowNotice.js'
import { agentPromptDeliveryServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from '../src/renderer/src/lib/service-window-notice.js'

function session(processState: SessionSnapshot['processState'] = 'running'): SessionSnapshot {
  return {
    kind: 'agent', processState,
    terminalPromptDelivery: {
      state: 'unverified', mode: 'degraded', reason: 'screen-evidence-replaced',
      submissionId: 'prompt-1', run: { runId: 'run-1' }, observedAt: 1
    }
  } as SessionSnapshot
}
function notice(value: SessionSnapshot | undefined) {
  return serviceNoticeToRender(classifyServiceNotice(agentPromptDeliveryServiceOutcome(value)))
}

describe('prompt delivery service window', () => {
  it('shows the cause, actual delivery mode, and recovery without an overlay or resend instruction', () => {
    const markup = renderToStaticMarkup(createElement(ServiceWindowNotice, { notice: notice(session()) }))
    expect(markup).toContain('while the terminal refreshed')
    expect(markup).toContain('continued without full screen confirmation')
    expect(markup).toContain('move this notice to the inbox')
    expect(markup).toContain('a verified prompt clears it')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="dialog"')
    expect(markup).not.toContain('Send it again')
  })
  it('clears only when the Core marker clears and never presents unknown viability as healthy', () => {
    expect(notice(undefined)).toBeNull()
    const healthy = session()
    if (healthy.kind === 'agent') delete healthy.terminalPromptDelivery
    expect(notice(healthy)).toBeNull()
    expect(notice(session('interrupted'))?.kind).toBe('indeterminate')
    expect(notice(session('exited'))).toBeNull()
  })
})

// Live updates must add AND remove the marker; a correct cold snapshot alone cannot show a
// degradation during an already-open conversation.
import { projectRuntimeEvent, type SessionProjectionState } from '../src/renderer/src/lib/session-state.js'
import type { AgentMuxAgentSession } from '@agentmux/core'
it('projects live Core delivery notices and clears them on the next verified update', () => {
  const initialSession = { ...session(), id: 'agent', hostId: 'local', updatedAt: 1, control: {
    kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'run-1' }
  } } as SessionSnapshot
  if (initialSession.kind === 'agent') delete initialSession.terminalPromptDelivery
  const state: SessionProjectionState = {
    sessions: [initialSession], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {}
  }
  const core: AgentMuxAgentSession = {
    kind: 'agent', agentSessionId: 'agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: '/repo', createdAt: 1, updatedAt: 2,
    run: { runId: 'run-1' }, retiredRuns: [], outputCursorBytes: 0,
    terminalPromptDelivery: (session() as Extract<SessionSnapshot, { kind: 'agent' }>).terminalPromptDelivery!
  }
  const degraded = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: core } }).state
  expect(notice(degraded.sessions[0])?.kind).toBe('process-degraded')
  delete core.terminalPromptDelivery
  core.updatedAt = 3
  const restored = projectRuntimeEvent(degraded, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: core } }).state
  expect(notice(restored.sessions[0])).toBeNull()
})
