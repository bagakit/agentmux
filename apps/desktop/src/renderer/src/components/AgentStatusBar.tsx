import { useAppStore } from '../store'
import { summarizeAgentAttention, summarizeProviderActivity } from '../lib/agent-attention'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { AgentTreePanel } from './AgentRoster'
import { ResourceUsagePanel } from './ResourceUsagePanel'
import { CirclePlay, CircleAlert, CircleHelp } from 'lucide-react'

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
        {state === 'working' ? <CirclePlay size={12} /> : state === 'error' ? <CircleAlert size={12} /> : state === 'waiting' ? <CircleHelp size={12} /> : <span className="status__dot" />}
      </span>
      <span className="agent-status-bar__count">{count}</span>
      <span className="agent-status-bar__label">{label}</span>
    </>
  )
}

// 一个 Provider 现在几个在跑、几个闲着。整窗的 working/needs-you 汇总回答"谁在等我"，这一段
// 回答另一个问题——"哪个 Provider 在干活"——所以它按 Provider 分，而不是再报一次总数。
// 活跃的定义来自 Board 那一个开关（见 summarizeProviderActivity），整窗那个 working 计数也走同一个，
// 因此同一个 Session 不会 Board 判在跑、状态栏判待机。
function ProviderActivity() {
  const sessions = useAppStore((state) => state.sessions)
  const providers = summarizeProviderActivity(sessions)
  if (providers.length === 0) return null
  return (
    <span className="agent-status-bar__providers">
      {providers.map(({ providerId, active, idle }) => (
        <span
          className="agent-status-bar__provider"
          key={providerId}
          data-active={active > 0 ? 'true' : 'false'}
          // 计数在 tooltip 与可访问名里都说全，屏幕阅读器听到的是事实而不是两个裸数字。
          title={`${agentProviderLabel(providerId)} · ${active} active · ${idle} idle`}
          aria-label={`${agentProviderLabel(providerId)}: ${active} active, ${idle} idle`}
        >
          <AgentProviderIcon providerId={providerId} size={11} />
          <span className="agent-status-bar__count">{active}</span>
          {/* 闲着的那部分是次要事实：压低而不是省掉，省掉就没法回答"总共几个"。 */}
          <span className="agent-status-bar__idle">/{active + idle}</span>
        </span>
      ))}
    </span>
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
      {/* The total segment stays a compact cross-window summary. Each count below now also DISCLOSES its
          project→Agent tree via a separate chevron (AgentTreePanel) — hover/click/keyboard — so a count
          is no longer a dead number. needs-you/error keep their one-click JUMP button unchanged beside
          it; the tree is added, never substituted (principle 11). An empty class renders no chevron, so
          a zero count is not a dead click. */}
      <span className="agent-status-bar__group">
        <span className="agent-status-bar__segment" data-attention="working">
          <StatusCount state={rollup.working > 0 ? 'working' : null} count={rollup.working} label="working" />
        </span>
        <AgentTreePanel
          filter="working"
          heading="Working · by project"
          label={`Show the ${rollup.working} working ${rollup.working === 1 ? 'agent' : 'agents'} by project`}
        />
      </span>
      {rollup.needsYouSessionId ? (
        <span className="agent-status-bar__group">
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
          <AgentTreePanel
            filter="needs-you"
            heading="Needs you · by project"
            label={`Show the ${rollup.needsYou} ${rollup.needsYou === 1 ? 'agent' : 'agents'} needing you by project`}
          />
        </span>
      ) : (
        <span className="agent-status-bar__segment" data-attention="needs-you">
          <StatusCount state={null} count={rollup.needsYou} label="needs you" />
        </span>
      )}
      {rollup.errorSessionId ? (
        <span className="agent-status-bar__group">
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
          <AgentTreePanel
            filter="error"
            heading="Error · by project"
            label={`Show the ${rollup.error} ${rollup.error === 1 ? 'agent' : 'agents'} in error by project`}
          />
        </span>
      ) : (
        <span className="agent-status-bar__segment" data-attention="error">
          <StatusCount state={null} count={rollup.error} label="error" />
        </span>
      )}
      <ProviderActivity />
      {/* 资源面板排在最后：它回答的是"机器还扛得住吗"，比"谁在等你"次要一档。
          折叠时它只是一枚图标，采样在打开那一刻才开始。 */}
      <ResourceUsagePanel />
    </div>
  )
}
