import { AgentAvatar } from './AgentAvatar'
import {
  Activity,
  ArrowUpRight,
  BellRing,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  History,
  NotebookText,
  Plus,
  RadioTower
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  SessionSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { BOARD_COLUMN_DESCRIPTIONS } from '../lib/project-board'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import {
  contentSlotPresentation,
  resolveExplorerCollapsed,
  resolveWorkspaceTools,
  workspaceAgentGroups,
  type WorkspaceAgentGroupId,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { formatRelativeAge } from '../lib/relative-age'
import { contextPressure, contextUsedPercent } from '../lib/agent-usage'
import { CONTEXT_PRESSURE_HINT } from './AgentRoster'
import { useAppStore } from '../store'
import { agentProviderLabel } from './AgentProviderIcon'
import { WorkspaceTopicsPanel } from './WorkspaceTopicsPanel'
import { BranchesPanel } from './BranchesPanel'
import { ChangesPanel } from './ChangesPanel'
import { FileExplorer, type FileExplorerRevealRequest } from './FileExplorer'
import { SidebarToggleChrome } from './TopRowChrome'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

type ToolDefinition<T extends string> = {
  id: T
  label: string
  description: string
  icon: typeof FolderGit2
}

const WORKSPACE_TOOL_META: Record<WorkspaceTool, Omit<ToolDefinition<WorkspaceTool>, 'id'>> = {
  'files-branches': { label: 'Files + Branches', description: 'Browse the selected worktree', icon: FolderGit2 },
  agents: { label: 'Agents', description: 'Find Agents that remain available after their Tab closes', icon: Bot }
}

function WorkspaceFilesTool({
  workspace,
  isScratch
}: {
  workspace: WorkspaceRecord
  isScratch: boolean
}) {
  const presentation = contentSlotPresentation(isScratch)
  const explorerCollapsedOverride = useAppStore((state) => state.explorerCollapsed[workspace.id])
  const setExplorerCollapsed = useAppStore((state) => state.setExplorerCollapsed)
  // 解析一次、读写复用：折叠态既决定渲染哪一支（读），又是 toggle 写入的取反基准（写）。分开算两次
  // 就是本仓踩过的「读的 key 与写的 key 漂移」——所以这里只有这一个 const，写入点直接取反它。
  const collapsed = resolveExplorerCollapsed(explorerCollapsedOverride, presentation.explorerCollapsedByDefault)
  const [explorerRevealRequest, setExplorerRevealRequest] = useState<FileExplorerRevealRequest>()
  const explorerRevealRequestId = useRef(0)
  // The content slot's bottom half is Branches by default (unchanged behavior); a real project can
  // switch it to Source Control changes. Scratch never shows this — it renders Topics instead.
  const [bottomView, setBottomView] = useState<'branches' | 'changes'>('branches')

  function revealDirectoryInExplorer(path: string): void {
    explorerRevealRequestId.current += 1
    setExplorerRevealRequest({
      workspaceId: workspace.id,
      path,
      requestId: explorerRevealRequestId.current
    })
  }

  const bottomHalf = presentation.showTopics ? (
    <WorkspaceTopicsPanel
      workspace={workspace}
      onRevealDirectory={revealDirectoryInExplorer}
    />
  ) : (
    <div className="content-slot-source-control">
      <div className="source-control-switch" role="tablist" aria-label="Source control view">
        <button
          type="button"
          role="tab"
          aria-selected={bottomView === 'branches'}
          className={bottomView === 'branches' ? 'selected' : ''}
          onClick={() => setBottomView('branches')}
        >
          Branches
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={bottomView === 'changes'}
          className={bottomView === 'changes' ? 'selected' : ''}
          onClick={() => setBottomView('changes')}
        >
          Changes
        </button>
      </div>
      {bottomView === 'branches' ? (
        <BranchesPanel workspace={workspace} />
      ) : (
        <ChangesPanel workspace={workspace} />
      )}
    </div>
  )

  return (
    <div className="workspace-tool-explorer">
      <div className="workspace-tool-context workspace-tool-context--collapsible">
        <button
          type="button"
          className="workspace-tool-context__toggle"
          // Explorer 的折叠总归一个 chevron 控件，沿用左栏分组头那套（chevron 朝下＝展开、朝右＝收起，
          // aria-expanded 跟着真实状态）。它常驻在这条 context bar 上而不是塞进 FileExplorer 自己的
          // header：折叠后 FileExplorer 根本不渲染，把 toggle 放进它就再也收不回来。
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show file tree' : 'Hide file tree'}
          title={collapsed ? 'Show file tree' : 'Hide file tree'}
          onClick={() => setExplorerCollapsed(workspace.id, !collapsed)}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <span title={workspace.path}>
          <strong>{workspace.name}</strong>
          {isScratch || workspace.branch ? <small>{isScratch ? 'Topic wiki' : workspace.branch}</small> : null}
        </span>
        {workspace.hostId !== 'local' ? (
          <em><RadioTower size={11} /> {workspace.hostId}</em>
        ) : null}
      </div>
      {collapsed ? (
        // 折叠＝没有可切分的第二块，所以整块直接由 bottomHalf 占满，不渲染 PanelGroup / 把手（见评审
        // §2.3.1：折叠态不进 react-resizable-panels，否则折叠状态会有 store 与库两个源）。「可拖但无意义
        // 的死把手」因此不可能存在——把手根本没被渲染。
        <div className="workspace-tools-collapsed">{bottomHalf}</div>
      ) : (
        <PanelGroup
          direction="vertical"
          className="workspace-tools-split"
          key={presentation.showTopics ? 'content-slot-topics' : 'content-slot-branches'}
        >
          <Panel defaultSize={presentation.fileTreeDefaultSize} minSize={presentation.fileTreeMinSize}>
            <FileExplorer key={workspace.id} revealRequest={explorerRevealRequest} />
          </Panel>
          <PanelResizeHandle className="workspace-tools-resize-handle" />
          <Panel defaultSize={100 - presentation.fileTreeDefaultSize} minSize={20}>
            {bottomHalf}
          </Panel>
        </PanelGroup>
      )}
    </div>
  )
}

// working / needs-you 的措辞取自 BOARD_COLUMN_DESCRIPTIONS：这两组就是 Board 那两列按 workspace 收窄，
// 同一个归类却在两个面上说两句话是漂移的入口（needs-you 这句原先手抄成 "Waiting or blocked"，漏掉了
// 那一列同样收着的 disconnected 与 error）。recent 有自己的话，因为它是 done 列在这里换了个名字。
const AGENT_GROUP_META: Record<WorkspaceAgentGroupId, {
  label: string
  description: string
  icon: typeof Activity
}> = {
  working: { label: 'Working', description: BOARD_COLUMN_DESCRIPTIONS.working, icon: Activity },
  'needs-you': { label: 'Needs You', description: BOARD_COLUMN_DESCRIPTIONS['needs-you'], icon: BellRing },
  recent: { label: 'Recent', description: 'Finished Agents', icon: History }
}

export function WorkspaceAgentsTool({
  workspace,
  sessions,
  onOpen
}: {
  workspace: WorkspaceRecord
  sessions: readonly SessionSnapshot[]
  onOpen(sessionId: string): void
}) {
  const groups = workspaceAgentGroups(sessions, workspace)
  const count = groups.reduce((total, group) => total + group.sessions.length, 0)

  return (
    <section className="workspace-agents-tool">
      <div className="workspace-tool-context">
        <span>
          <strong>{workspace.name}</strong>
          <small>Agent Sessions</small>
        </span>
        <em>{count}</em>
      </div>
      <div className="workspace-agents-tool__scroll">
        <p className="workspace-agents-tool__hint">Agents kept during Tab close remain available here.</p>
        {count === 0 ? (
          <div className="workspace-agents-tool__empty">
            <Bot size={18} />
            <strong>No Agents in this workspace</strong>
            <span>Use + to start an Agent. Choose “Keep Session” on close to leave it running here.</span>
          </div>
        ) : groups.map((group) => {
          if (group.sessions.length === 0) return null
          const meta = AGENT_GROUP_META[group.id]
          const Icon = meta.icon
          return (
            <section className="workspace-agent-group" key={group.id}>
              <header>
                <span><Icon size={11} /><strong>{meta.label}</strong><small>{meta.description}</small></span>
                <em>{group.sessions.length}</em>
              </header>
              <div>
                {group.sessions.map((session) => {
                  // 上下文压力：与花名册同源（agent-usage.ts 的 contextPressure/contextUsedPercent），
                  // 不在这里另立门槛。这是**空闲 Agent 也能看见压力**的地方——花名册那条 surface 已被
                  // 收进这个 dock，而 recent 组恰好收着跑完待机的 Agent，正是「快满却没人管」的那一类。
                  const percent = contextUsedPercent(session.turnUsage?.context)
                  const pressure = contextPressure(percent)
                  return (
                  <button
                    type="button"
                    className="workspace-agent-row"
                    key={session.id}
                    title={`Open or focus ${session.label}`}
                    onClick={() => onOpen(session.id)}
                  >
                    <span className="workspace-agent-row__mark">
                      <AgentAvatar sessionId={session.id} executorId={session.executorId} label={session.label} state={session.status.state} providerId={session.providerId} size={18} />
                    </span>
                    <span className="workspace-agent-row__identity">
                      <strong>{session.label}</strong>
                      <small>
                        {agentProviderLabel(session.providerId)} · {session.status.state}
                        {/* 够上门槛才出现，且文案说的是下一步不是颜色名——沿用花名册那枚 data-pressure
                            标记（CSS 在 agent-panels.css），逻辑层不出现颜色。缺席即正常。 */}
                        {pressure ? (
                          <span
                            className="agent-roster__pressure"
                            data-pressure={pressure}
                            title={`Context window ${percent}% full — ${CONTEXT_PRESSURE_HINT[pressure]}`}
                          >
                            {percent}%
                          </span>
                        ) : null}
                      </small>
                    </span>
                    <time title={new Date(session.updatedAt).toLocaleString()}>{formatRelativeAge(Date.now() - session.updatedAt)}</time>
                    <ArrowUpRight size={11} />
                  </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}

export function SurfaceToolDock({
  workspace
}: {
  workspace: WorkspaceRecord | undefined
}) {
  const workspaceTool = useAppStore((state) => state.workspaceTool)
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const layout = useAppStore((state) => workspace ? state.layouts[workspace.id] : undefined)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const selectSession = useAppStore((state) => state.selectSession)
  const sessions = useAppStore((state) => state.sessions)
  const fileEditingProbe = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-file-editing-report') === '1'
  // Scratch is a wiki-first workspace: the content slot keeps its `files-branches` role but is
  // re-skinned as `Files + Topics` (see contentSlotPresentation), so the tool set never diverges
  // and the global workspaceTool is never mutated.
  const isScratch = Boolean(workspace && isScratchWorkspaceId(workspace.id))
  const { tools: workspaceToolIds, effective: effectiveWorkspaceTool } = resolveWorkspaceTools({
    workspaceTool,
    isScratch
  })
  const contentSlot = contentSlotPresentation(isScratch)
  const tools: ToolDefinition<WorkspaceTool>[] = workspaceToolIds.map((id) => {
        const meta = WORKSPACE_TOOL_META[id]
        // Re-skin the content slot for Scratch without changing its enum id.
        if (id === 'files-branches' && isScratch) {
          return { id, ...meta, label: contentSlot.label, description: 'Browse the topic wiki and collaborators', icon: NotebookText }
        }
        return { id, ...meta }
      })
  const selectedTool = fileEditingProbe ? 'files-branches' : effectiveWorkspaceTool
  const activePaneId = layout?.activeGroupId
  return (
    <aside className="surface-tool-panel" aria-label="Space tools">
      <header className={`surface-tool-activitybar surface-tool-activitybar--space ${projectRailOpen ? '' : 'surface-tool-activitybar--compact-chrome'}`}>
        {!projectRailOpen ? <SidebarToggleChrome /> : null}
        <nav aria-label="Space tool selection">
          {tools.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.id}
                type="button"
                className={selectedTool === tool.id ? 'selected' : ''}
                aria-label={tool.label}
                aria-pressed={selectedTool === tool.id}
                title={`${tool.label} — ${tool.description}`}
                onClick={() => {
                  setWorkspaceTool(tool.id)
                }}
              >
                <Icon size={15} />
              </button>
            )
          })}
        </nav>
        {selectedTool === 'agents' && workspace && layout ? (
          <button
            type="button"
            className="surface-tool-create icon-button"
            aria-label="New Agent"
            title="New Agent — choose an Executor"
            onClick={() => openLauncher(activePaneId)}
          >
            <Plus size={15} />
          </button>
        ) : null}
      </header>
      <div className="surface-tool-content">
        {selectedTool === 'files-branches' && workspace ? (
          <WorkspaceFilesTool workspace={workspace} isScratch={isScratch} />
        ) : null}
        {effectiveWorkspaceTool === 'agents' && workspace ? (
          <WorkspaceAgentsTool
            workspace={workspace}
            sessions={sessions}
            onOpen={(sessionId) => selectSession(sessionId, activePaneId)}
          />
        ) : null}
      </div>
    </aside>
  )
}
