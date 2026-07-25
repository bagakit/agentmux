import { useAppStore } from '../store'
import { summarizeAgentAttention } from '../lib/agent-attention'

// The window's only cross-session attention rollup. Every other status indicator is scoped — the
// tab dot to one Session, Board columns to one Project, the Agents tool total to one open Workspace
// dock. This states, for the whole window (collapsed panes, other tab groups, other workspaces
// included), whether any Agent needs you. It renders only when at least one Agent Session exists,
// stays neutral until a count crosses zero, and reuses the shared status language so a dot here
// means exactly what it means on a Tab.

// An aggregate is not one Session, so there is no honest SessionSnapshot['status'] to hand
// StatusDot — faking its source/observedAt would promote evidence that does not exist. We reuse the
// status CSS vocabulary (.status / .status__dot / .status--{state}) directly instead; a bare
// .status is the neutral grey the design asks for at count zero.
function StatusCount({
  state,
  count,
  label
}: {
  state: 'working' | 'waiting' | 'error' | null
  count: number
  label: string
}) {
  return (
    <>
      <span className={state ? `status status--${state}` : 'status'} aria-hidden="true">
        <span className="status__dot" />
      </span>
      <span className="agent-status-bar__count">{count}</span>
      <span className="agent-status-bar__label">{label}</span>
    </>
  )
}

export function AgentStatusBar() {
  const sessions = useAppStore((state) => state.sessions)
  const selectSession = useAppStore((state) => state.selectSession)
  const rollup = summarizeAgentAttention(sessions)
  if (rollup.total === 0) return null

  return (
    // role="group" makes the aria-label a real accessible name; a bare div is a generic node many
    // screen readers skip, so the window's only attention rollup would announce as nothing.
    <div className="agent-status-bar" role="group" aria-label="Agent attention across this window">
      <span className="agent-status-bar__segment" data-attention="total">
        <StatusCount state={null} count={rollup.total} label={rollup.total === 1 ? 'agent' : 'agents'} />
      </span>
      <span className="agent-status-bar__segment" data-attention="working">
        <StatusCount state={rollup.working > 0 ? 'working' : null} count={rollup.working} label="working" />
      </span>
      {rollup.needsYouSessionId ? (
        <button
          className="agent-status-bar__segment agent-status-bar__segment--action"
          type="button"
          data-attention="needs-you"
          aria-label={`${rollup.needsYou} ${rollup.needsYou === 1 ? 'agent needs' : 'agents need'} you. Jump to the one waiting longest.`}
          title="Jump to the agent that has been waiting longest"
          onClick={() => selectSession(rollup.needsYouSessionId!)}
        >
          <StatusCount state="waiting" count={rollup.needsYou} label="needs you" />
        </button>
      ) : (
        <span className="agent-status-bar__segment" data-attention="needs-you">
          <StatusCount state={null} count={rollup.needsYou} label="needs you" />
        </span>
      )}
      {rollup.errorSessionId ? (
        <button
          className="agent-status-bar__segment agent-status-bar__segment--action"
          type="button"
          data-attention="error"
          aria-label={`${rollup.error} ${rollup.error === 1 ? 'agent' : 'agents'} in error. Jump to the earliest.`}
          title="Jump to the earliest agent in error"
          onClick={() => selectSession(rollup.errorSessionId!)}
        >
          <StatusCount state="error" count={rollup.error} label="error" />
        </button>
      ) : (
        <span className="agent-status-bar__segment" data-attention="error">
          <StatusCount state={null} count={rollup.error} label="error" />
        </span>
      )}
    </div>
  )
}
