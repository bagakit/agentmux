import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  GitBranch,
  Inbox,
  LoaderCircle,
  MessageSquarePlus,
  NotebookText,
  RadioTower,
  RefreshCw,
  Search,
  SquareTerminal,
  Unlink,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { useBoardRows } from '../hooks/useBoardRows'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import {
  BOARD_COLUMN_DESCRIPTIONS,
  PROJECT_BOARD_COLUMNS,
  boardRowRecap,
  filterBoardRows,
  type BoardRow,
  type BranchBindingFilter,
  type ProjectBoardColumn
} from '../lib/project-board'
import { boardRunCardAttributes } from '../lib/board-run-card'
import { observeAgentSession, observationSummary } from '../lib/agent-observation'
import { formatRelativeAge } from '../lib/relative-age'
import { useAppStore } from '../store'
import { BoardDiscussionCanvas } from './BoardDiscussionCanvas'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { FanOutStrip } from './FanOutStrip'
import { StatusDot } from './StatusDot'

// 列的**措辞**取自 BOARD_COLUMN_DESCRIPTIONS——它跟归类映射放在一起，因为它是关于那个映射的断言。
// 这里手抄过一份，于是 needs-you 长期写着 "Waiting or blocked"，而那一列其实还收着 disconnected 与 error。
const COLUMN_META: Record<ProjectBoardColumn, {
  label: string
  description: string
  icon: LucideIcon
}> = {
  inbox: { label: 'Inbox', description: BOARD_COLUMN_DESCRIPTIONS.inbox, icon: Inbox },
  working: { label: 'Working', description: BOARD_COLUMN_DESCRIPTIONS.working, icon: Activity },
  'needs-you': { label: 'Needs You', description: BOARD_COLUMN_DESCRIPTIONS['needs-you'], icon: BellRing },
  done: { label: 'Done', description: BOARD_COLUMN_DESCRIPTIONS.done, icon: CheckCircle2 }
}

/**
 * 一种行来源在 Board 上怎么说话。
 *
 * Branch 与 Topic 只在**措辞与图标**上不同——列、状态归类、Inbox 语义全部共用。把差异收进这张
 * 表，渲染面就不需要按 kind 分支，新增一种行来源也只是多一个条目。
 */
const ROW_KIND_META: Record<BoardRow['kind'], {
  cornerLabel: string
  cornerIcon: LucideIcon
  rowIcon: LucideIcon
  /** 行没有落地路径时的图标（Topic 恒有目录，因此只对 Branch 生效）。 */
  unboundIcon: LucideIcon
  title: string
  subtitle: string
  emptyPathLabel: string
}> = {
  branch: {
    cornerLabel: 'Branch / Worktree',
    cornerIcon: GitBranch,
    rowIcon: GitBranch,
    unboundIcon: Unlink,
    title: 'Branch × status',
    subtitle: 'Branches run vertically. Agent progress moves horizontally within the same row.',
    emptyPathLabel: 'No worktree'
  },
  topic: {
    cornerLabel: 'Topic',
    cornerIcon: NotebookText,
    rowIcon: NotebookText,
    unboundIcon: NotebookText,
    title: 'Topic × status',
    subtitle: 'Topics run vertically. Agent progress moves horizontally within the same row.',
    emptyPathLabel: 'No directory'
  }
}

function RunCard({ session, onOpen }: { session: SessionSnapshot; onOpen: () => void }) {
  // 三条不折叠的观察轴（进程活性 / 语义活性 / 就绪性）经 Core 的同一份合同投影而来（observeAgentSession
  // 只做形状归一，判定住在 @agentmux/core/agent-status）。落在状态点的 title 上，让"活着但闲着"「在跑」
  // 「活着但还没就绪」在同一格里读得出区别，而不是塌成一个 busy。终端 Session 没有语义活性这层概念。
  const observationTitle = session.kind === 'agent'
    ? observationSummary(observeAgentSession(session, Date.now()))
    : undefined
  return (
    <button
      type="button"
      {...boardRunCardAttributes(session.status.state)}
      onClick={onOpen}
      aria-label={`Open ${session.label}`}
    >
      <span className="board-run-card__status" {...(observationTitle ? { title: observationTitle } : {})}><StatusDot status={session.status} /></span>
      <span className="board-run-card__identity">
        <strong>{session.label}</strong>
        <small>{session.providerId ? <><AgentProviderIcon providerId={session.providerId} size={11} /> {agentProviderLabel(session.providerId)}</> : <><SquareTerminal size={11} /> terminal</>}</small>
      </span>
      <span className="board-run-card__meta">
        <em>{session.status.state}</em>
        {/* 后缀是这个面自己的密度选择——卡片够宽，`12m ago` 读起来是完整的句子。档位不是。 */}
        <time>{formatRelativeAge(Date.now() - session.updatedAt, ' ago')}</time>
      </span>
      {session.status.detail ? <span className="board-run-card__detail">{session.status.detail}</span> : null}
      <ArrowUpRight size={12} />
    </button>
  )
}

export function WorkspaceBoard() {
  const sessions = useAppStore((state) => state.sessions)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const selectSession = useAppStore((state) => state.selectSession)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const keepOneOfFanOut = useAppStore((state) => state.keepOneOfFanOut)
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const [query, setQuery] = useState('')
  const [column, setColumn] = useState<ProjectBoardColumn | 'all'>('all')
  const [binding, setBinding] = useState<BranchBindingFilter>('all')
  const [actionError, setActionError] = useState<string | null>(null)
  const [discussionRow, setDiscussionRow] = useState<BoardRow | null>(null)

  const { rows, project, scratch, anchor, snapshot, topics, loadError, topicsError, loading, refresh, kind } = useBoardRows()

  useEffect(() => {
    setQuery('')
    setColumn('all')
    setBinding('all')
    setActionError(null)
    setDiscussionRow(null)
  }, [project?.id, scratch?.id])

  const meta = ROW_KIND_META[kind]
  const filteredRows = useMemo(
    () => filterBoardRows(rows, query, column, binding),
    [binding, column, rows, query]
  )
  const hasFilters = Boolean(query.trim() || column !== 'all' || binding !== 'all')

  function clearFilters(): void {
    setQuery('')
    setColumn('all')
    setBinding('all')
  }

  async function openRow(row: BoardRow): Promise<void> {
    if (!anchor) return
    setActionError(null)
    try {
      if (row.kind === 'topic') {
        await openScratchTopic(row.id)
        return
      }
      if (row.workspace) {
        await selectWorkspace(row.workspace.id)
      } else if (row.branch.worktreePath) {
        activateWorkspaceSelection(await api.workspaces.openBranch(anchor.id, row.branch.name))
      } else {
        await selectWorkspace(anchor.id)
        setWorkspaceTool('files-branches')
      }
    } catch (cause) {
      setActionError(presentError(cause))
    }
  }

  if (!anchor) {
    return (
      <section className="board board--empty">
        <div className="board-state">
          <GitBranch size={22} />
          <strong>No project selected</strong>
          <span>Add or select a Project before opening its Branch board.</span>
        </div>
      </section>
    )
  }

  if (!scratch && !snapshot && loading) {
    return (
      <section className="board board--empty">
        <div className="board-state"><LoaderCircle className="spin" size={22} /><strong>Loading branches</strong><span>Reading Git truth from {project?.name}.</span></div>
      </section>
    )
  }

  if (!scratch && !snapshot && loadError) {
    return (
      <section className="board board--empty">
        <div className="board-state board-state--error"><AlertTriangle size={22} /><strong>Branches unavailable</strong><span>{loadError}</span><button className="small-button" onClick={() => void refresh()}>Retry</button></div>
      </section>
    )
  }

  if (snapshot?.kind === 'not-a-git-repository') {
    return (
      <section className="board board--empty">
        <div className="board-state"><GitBranch size={22} /><strong>Not a Git repository</strong><span>This workspace is not linked to a Git repository.</span></div>
      </section>
    )
  }

  // 快照还没到手是"还不知道"，不是"没有 Topic"——诚实地说在读，别渲染一个零行矩阵冒充空态。
  if (scratch && !topics && !topicsError) {
    return (
      <section className="board board--empty">
        <div className="board-state"><LoaderCircle className="spin" size={22} /><strong>Loading Topics</strong><span>Reading Topics from {scratch.name}.</span></div>
      </section>
    )
  }

  const hostId = scratch?.hostId ?? project?.hostId ?? anchor.hostId
  const contextName = scratch?.name ?? project?.name ?? anchor.name
  const boardError = loadError ?? topicsError
  const columnCounts = Object.fromEntries(PROJECT_BOARD_COLUMNS.map((id) => [
    id,
    id === 'inbox'
      ? filteredRows.filter((row) => row.path !== null).length
      : filteredRows.reduce((total, row) => total + row.runsByColumn[id].length, 0)
  ])) as Record<ProjectBoardColumn, number>
  const CornerIcon = meta.cornerIcon

  return (
    <section className="board board--matrix">
      <header className="board__header">
        <div>
          <div className="eyebrow">{scratch ? 'Scratch board' : 'Project board'}</div>
          <h1>{meta.title}</h1>
          <p>{meta.subtitle}</p>
        </div>
        <span className="board__context-hint">
          {contextName} · {rows.length} {kind === 'topic' ? 'topics' : 'branches'}
        </span>
      </header>

      <div className="board-toolbar board-toolbar--matrix">
        <label className="board-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={kind === 'topic' ? 'Search topics, summaries, providers, or run details' : 'Search branches, paths, providers, or run details'} />{query ? <button title="Clear search" onClick={() => setQuery('')}><X size={11} /></button> : null}</label>
        <label><span>Status</span><select aria-label="Filter by board status" value={column} onChange={(event) => setColumn(event.target.value as ProjectBoardColumn | 'all')}><option value="all">All statuses</option>{PROJECT_BOARD_COLUMNS.map((id) => <option value={id} key={id}>{COLUMN_META[id].label}</option>)}</select></label>
        {/* Binding 只对 Branch 是个真问题——Topic 恒有目录，给它一个永远只有一个答案的筛选器
            是在制造噪音。 */}
        {kind === 'branch' ? (
          <label><span>Binding</span><select aria-label="Filter by binding" value={binding} onChange={(event) => setBinding(event.target.value as BranchBindingFilter)}><option value="all">All branches</option><option value="bound">Worktrees</option><option value="unbound">Unbound</option></select></label>
        ) : null}
        <span className="board-host-scope"><RadioTower size={11} /> {hostId === 'local' ? 'This Mac' : hostId}</span>
        <span className="board-filter-count">{filteredRows.length} / {rows.length}</span>
        {hasFilters ? <button className="small-button" onClick={clearFilters}><X size={11} /> Reset</button> : kind === 'branch' ? <button className="small-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />} Refresh</button> : null}
      </div>

      {/* Which branches are racing on the same prompt. Absent when there is no fan-out to compare. */}
      {project ? (
        <FanOutStrip
          workspaces={project.workspaces}
          sessions={sessions}
          onSelectSession={(sessionId) => void selectSession(sessionId)}
          onKeepLane={(keepWorkspaceId, removeWorkspaceIds) =>
            void keepOneOfFanOut({ keepWorkspaceId, removeWorkspaceIds })}
        />
      ) : null}

      {boardError ? <div className="board-inline-warning"><AlertTriangle size={13} /> {boardError}</div> : null}
      {actionError ? <div className="board-inline-warning"><AlertTriangle size={13} /> {actionError}</div> : null}

      {filteredRows.length === 0 ? (
        <div className="board-no-results"><Search size={18} /><strong>{hasFilters ? `No matching ${kind === 'topic' ? 'topics' : 'branches'}` : kind === 'topic' ? 'No Topics yet' : 'No local branches'}</strong><span>{hasFilters ? 'Change or reset the board filters.' : kind === 'topic' ? 'Create a Topic from the Topics panel, then it appears as a row here.' : 'Create a branch with Git, then refresh the board.'}</span>{hasFilters ? <button className="small-button" onClick={clearFilters}>Clear filters</button> : null}</div>
      ) : (
        <div className="board-matrix-scroll">
          <div className="board-matrix" role="grid" aria-label={`${meta.cornerLabel} by status board`}>
            <div className="board-matrix__head" role="row">
              <div className="board-matrix__corner" role="columnheader">
                <CornerIcon size={13} /> {meta.cornerLabel}
              </div>
              {PROJECT_BOARD_COLUMNS.map((id) => {
                const columnMeta = COLUMN_META[id]
                const Icon = columnMeta.icon
                return (
                  <div className={`board-column-head board-column-head--${id}`} role="columnheader" key={id}>
                    <span><Icon size={13} /><strong>{columnMeta.label}</strong></span>
                    <small>{columnMeta.description}</small>
                    <em>{columnCounts[id]}</em>
                  </div>
                )
              })}
            </div>
            {filteredRows.map((row) => {
              const RowIcon = row.path ? meta.rowIcon : meta.unboundIcon
              return (
                <div className="board-matrix__row" role="row" data-board-row={row.id} key={row.id}>
                  <header className="board-branch-head" role="rowheader">
                    <span className="board-branch-head__glyph"><RowIcon size={15} /></span>
                    <span className="board-branch-head__identity"><strong>{row.name}</strong><small title={row.path ?? undefined}>{row.path ?? meta.emptyPathLabel}</small>{boardRowRecap(row) ? <small className="board-branch-head__recap">{boardRowRecap(row)}</small> : null}</span>
                    <span className="board-branch-head__meta">
                      {row.kind === 'branch' && row.branch.isCurrent ? <em>Current</em> : null}
                      <small>{row.sessions.length} run{row.sessions.length === 1 ? '' : 's'}</small>
                    </span>
                    <button className="icon-button" type="button" title={row.kind === 'topic' ? 'Open Topic' : row.workspace ? 'Open workspace' : row.branch.worktreePath ? 'Open worktree' : 'Open Branches'} onClick={() => void openRow(row)}><ArrowUpRight size={12} /></button>
                  </header>
                  {PROJECT_BOARD_COLUMNS.map((id) => (
                    <div className={`board-cell board-cell--${id}`} role="gridcell" data-board-column={id} key={id}>
                      {id === 'inbox' ? (
                        <button className={`board-discussion-card ${row.path ? '' : 'board-discussion-card--unbound'}`} type="button" onClick={() => setDiscussionRow(row)}>
                          <span>{row.path ? <MessageSquarePlus size={15} /> : <Unlink size={15} />}</span>
                          <strong>{row.path ? 'Start discussion' : 'Worktree required'}</strong>
                          <small>{row.path ? `Launch an Agent on ${row.name}` : 'Create a worktree before launching an Agent'}</small>
                        </button>
                      ) : row.runsByColumn[id].length > 0 ? (
                        row.runsByColumn[id].map((session) => <RunCard key={session.id} session={session} onOpen={() => selectSession(session.id)} />)
                      ) : (
                        <div className="board-cell__empty"><span>—</span><small>No {COLUMN_META[id].label.toLocaleLowerCase()} runs</small></div>
                      )}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <BoardDiscussionCanvas
        row={discussionRow}
        anchor={anchor}
        onClose={() => setDiscussionRow(null)}
        onOpenBranches={(row) => void openRow(row)}
      />
    </section>
  )
}
