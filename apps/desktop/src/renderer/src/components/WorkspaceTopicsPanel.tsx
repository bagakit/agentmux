import {
  Crosshair,
  LoaderCircle,
  NotebookText,
  Pin,
  Plus
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type {
  ScratchTopicSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_TOPIC_TITLE_MAX_LENGTH, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { topicAgentPresentation, topicsWithAgents } from '../lib/surface-tool-dock'
// 显示名只有一条求值链（《显示名与身份》），这里消费它而**不**在面板里重拼一份。
import { resolveAgentName } from '../lib/display-name'
import { firstPromptFromTimeline, tabDisplayName } from '../lib/workbench-tabs'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { applyCopyPathStyle } from '../lib/copy-path-display'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { orderTopics, partitionPinned, reorderTopics } from '../lib/topic-order'
import { openTopicRegionMosaics, openTopicWorkSurfaces } from '../lib/scratch-topic-layout'
import { sessionRecentActivity } from '../lib/session-recency'
import { presentError } from '../lib/error-presentation'
import { handleTopicRenameKeyDown } from '../lib/topic-rename'
import { TopicContextMenu } from './TopicContextMenu'
import { useAppStore } from '../store'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { TopicPresence } from './TopicPresence'
import type { TopicTabDetail } from './TopicPresence'
import { SelectorListHeader, SelectorRow } from './SelectorList'

/**
 * 一个 selector 的返回值就是 `useSyncExternalStore` 的快照，React 用 `Object.is` 比较它。所以缺省值必须是
 * 这个**常量**，不能是就地写的 `?? []` —— 那个字面量每次调用都新建一个数组，快照永远「变了」，组件立刻
 * 进入无限重渲染（React error #185，控制台先报 "The result of getSnapshot should be cached"）。
 * `togglePinnedItem` 在清空时会 delete 掉整个 key（store.ts 的 `pinnedItems` 分支），所以「缺 key」是常态
 * 而不是边角：没 pin 过任何东西的全新 userData 一进来就撞上，日常用的 profile 反而因为 key 在而正常。
 */
const NO_PINNED_TOPICS: readonly string[] = []

export function WorkspaceTopicsPanel({
  workspace,
  onRevealDirectory
}: {
  workspace: WorkspaceRecord
  onRevealDirectory(path: string): void
}) {
  const layout = useAppStore((state) => state.layouts[workspace.id])
  const activeTabId = layout?.groups.find((group) => group.id === layout.activeGroupId)?.activeTabId
  const topicId = useAppStore((state) => activeTabId ? state.tabs[activeTabId]?.topicId : undefined)
  const tabs = useAppStore((state) => state.tabs)
  const fileRevision = useAppStore((state) => state.workspaceFileRevisions[workspace.id] ?? 0)
  const sessions = useAppStore((state) => state.sessions)
  const config = useAppStore((state) => state.config)
  // 头像簇要显示的是**显示名**，不是 session.label（那是命名链最低一档）。链的两个高档输入就是这
  // 两份 store 状态：用户手改名与首条 prompt。不读它们，这枚头像就只能拿到兜底名——而同 provider、
  // 同目录的两个 Agent 兜底名逐字相同，于是 tooltip 与读屏都答不出「这是哪一个」。
  const agentNames = useAppStore((state) => state.agentNames)
  const timelines = useAppStore((state) => state.timelines)
  const createScratchTopic = useAppStore((state) => state.createScratchTopic)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const renameScratchTopic = useAppStore((state) => state.renameScratchTopic)
  // 头像点击走全局那一个 selectSession——跳转到某个 Agent 全窗口只有这一条路径，
  // 在这里另写一段"找到它的 Tab 再激活"就是第二条，两条迟早对不上。
  const selectSession = useAppStore((state) => state.selectSession)
  const openFile = useAppStore((state) => state.openFile)
  const reportError = useAppStore((state) => state.reportError)
  const localHome = useAppStore((state) => state.localHome)
  const copyPathsAsAbsolute = useAppStore((state) => state.config?.copyPathsAsAbsolute)
  const [topics, setTopics] = useState<ScratchTopicSnapshot[] | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The Topic list is authoritative and comes from the filesystem snapshot. Live Sessions are
  // matched onto it here for display; they never add or remove a Topic.
  // 拖拽要有一小段距离才启动，否则点一下打开 Topic 会被误判成拖动。键盘 sensor 提供等价路径。
  const topicSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const topicOrder = useAppStore((state) => state.scratchTopicOrder)
  const setTopicOrder = useAppStore((state) => state.setScratchTopicOrder)
  // Topic pin 与 Branch pin 是同一个概念的两次实例化——一个 scope 内的一组 id。scope key 从
  // SCRATCH_WORKSPACE_ID **派生**、绝不在这里手写字面量：Topic id 只在唯一那个 Scratch workspace
  // 内唯一，所以这就是它的 scope（见 store.ts pinnedItems 的注释）。左栏那些 pinned 子行读的也是
  // 这一桶，投影与它必须同源，否则「列表里靠前」和「挂在 Scratch 下」会各说各话。
  const pinnedTopics = useAppStore((state) => state.pinnedItems[SCRATCH_WORKSPACE_ID] ?? NO_PINNED_TOPICS)
  const togglePinnedItem = useAppStore((state) => state.togglePinnedItem)
  // 文件系统仍是 Topic 存在与否的真相；用户顺序只决定怎么排。
  // 先 orderTopics 定拖拽序，再 partitionPinned 把 pin 的提到前面——是一次**分区**不是排序：
  // pin 段按 pin 的先后、未 pin 段保留拖拽序原样。两者组合而不是取代（见 topic-order.ts）。
  const userTopics = topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID) ?? null
  const projected = userTopics
    ? (() => {
        const withAgents = topicsWithAgents(userTopics, sessions, workspace)
        const dragOrder = orderTopics(withAgents.map((topic) => topic.id), topicOrder)
        const shown = partitionPinned(dragOrder, pinnedTopics)
        return shown.flatMap((id) => withAgents.filter((topic) => topic.id === id))
      })()
    : null
  const currentTopic = projected?.find((topic) => topic.id === topicId)
  // 一次派生「哪些 Topic 有 Tab 开着」及其 Region 分屏几何，逐行只读它，不让每行各自扫 tabs
  // （scratch-topic-layout.ts 的学说：门禁与几何是同一事实的两半，投影一次）。
  const openMosaics = openTopicRegionMosaics(layout, tabs)
  const openWorkSurfaces = openTopicWorkSurfaces(layout, tabs)
  const tabOrder = layout?.groups.flatMap((group) => group.tabOrder) ?? []
  const sessionTabRank = new Map<string, number>()
  tabOrder.forEach((tabId, index) => {
    const tab = tabs[tabId]
    const agentSurface = tab && Object.values(tab.regions).find((surface) => surface.kind === 'agent')
    if (agentSurface?.kind === 'agent') sessionTabRank.set(agentSurface.sessionId, index)
  })
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const topicTabDetails = new Map<string, readonly TopicTabDetail[]>()
  for (const [openTopicId, entries] of openWorkSurfaces) {
    const details = entries.flatMap((entry, tabIndex) => {
      const tab = tabs[entry.tabId]
      if (!tab) return []
      const title = tabDisplayName({
        tab,
        fallback: `Tab ${tabIndex + 1}`,
        agentFactsFor: (sessionId) => {
          const session = sessionById.get(sessionId)
          if (!session || session.kind !== 'agent') return null
          const executor = session.executorId ? config?.executors[session.executorId] : undefined
          return {
            userName: agentNames[sessionId],
            firstPrompt: firstPromptFromTimeline(timelines[sessionId]),
            fallbackLabel: session.label,
            providerLabel: executor?.label ?? session.executorId ?? session.providerId
          }
        }
      })
      return [{
        tabId: entry.tabId,
        title,
        active: entry.active,
        regions: entry.cells.map((cell) => {
          const surface = tab.regions[cell.regionId]
          const session = surface && 'sessionId' in surface ? sessionById.get(surface.sessionId) : undefined
          const executorLabel = surface?.kind === 'agent'
            ? (session && session.kind === 'agent' && session.executorId
              ? config?.executors[session.executorId]?.label ?? session.executorId
              : 'Agent')
            : surface?.kind === 'terminal' ? 'Terminal'
              : surface?.kind === 'browser' ? 'Browser'
                : surface?.kind === 'file' ? 'File'
                  : 'Launcher'
          const activity = session?.kind === 'agent'
            ? (timelines[session.id]?.items.length || session.pendingInteraction || session.status.detail
              ? sessionRecentActivity(session, timelines[session.id]?.items ?? [], workspace.path)
              : 'No recent activity')
            : surface?.kind === 'terminal' ? 'Terminal session'
              : 'No recent activity'
          return { ...cell, executorLabel, activity }
        })
      } satisfies TopicTabDetail]
    })
    topicTabDetails.set(openTopicId, details)
  }

  useEffect(() => {
    let active = true
    setError(null)
    void api.scratch.listTopics(workspace.id).then((snapshots) => {
      if (active) setTopics(snapshots)
    }).catch((cause) => {
      if (active) setError(presentError(cause))
    })
    return () => { active = false }
  }, [fileRevision, workspace.id])

  async function createTopic(): Promise<void> {
    if (pending) return
    setPending('create')
    setError(null)
    try {
      const created = await createScratchTopic()
      setTopics((current) => {
        const next = [...(current ?? []).filter((topic) => topic.id !== created.id), created]
        return next.sort((left, right) =>
          left.directoryPath < right.directoryPath ? -1 : left.directoryPath > right.directoryPath ? 1 : 0
        )
      })
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setPending(null)
    }
  }

  async function openTopic(nextTopicId: string): Promise<void> {
    if (pending) return
    setPending(nextTopicId)
    setError(null)
    try {
      // The panel is rendered only for Scratch, so pass the workspace identity explicitly. This
      // keeps the click independent from the currently selected Project while the workbench is
      // being revealed.
      await openScratchTopic(nextTopicId, SCRATCH_WORKSPACE_ID)
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setPending(null)
    }
  }

  function beginRename(topic: ScratchTopicSnapshot): void {
    if (pending) return
    setError(null)
    setEditingTopicId(topic.id)
    setEditTitle(topic.title)
  }

  function cancelRename(): void {
    setEditingTopicId(null)
    setEditTitle('')
  }

  async function commitRename(topic: ScratchTopicSnapshot): Promise<void> {
    // 现在 blur 也会走到这里。Escape 先 cancelRename 清空了状态，紧接着输入框失焦触发的这次
    // commit 必须是个空操作——否则用户按 Esc 反而会看到一条「标题不能为空」的错误。
    if (editingTopicId !== topic.id) return
    const title = editTitle.trim()
    if (pending) return
    if (!title) {
      setError('Scratch Topic title cannot be empty')
      return
    }
    if (title === topic.title) {
      cancelRename()
      return
    }
    const pendingId = `rename:${topic.id}`
    setPending(pendingId)
    setError(null)
    try {
      const renamed = await renameScratchTopic(topic.id, title)
      setTopics((current) => current?.map((entry) => entry.id === renamed.id ? renamed : entry) ?? null)
      cancelRename()
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setPending(null)
    }
  }

  async function setTopicWikiEnabled(topic: ScratchTopicSnapshot, enabled: boolean): Promise<void> {
    if (pending) return
    setPending(`wiki:${topic.id}`)
    setError(null)
    try {
      const updated = await api.scratch.setWikiEnabled(workspace.id, topic.id, enabled)
      setTopics((current) => current?.map((entry) => entry.id === updated.id ? updated : entry) ?? null)
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setPending(null)
    }
  }

  async function resetTopicWiki(topic: ScratchTopicSnapshot): Promise<void> {
    if (pending) return
    setPending(`wiki-reset:${topic.id}`)
    setError(null)
    try {
      const updated = await api.scratch.resetWiki(workspace.id, topic.id)
      setTopics((current) => current?.map((entry) => entry.id === updated.id ? updated : entry) ?? null)
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="surface-tool-summary workspace-topics-panel workspace-topics-panel--index">
      <SelectorListHeader
        className="workspace-topic-index-header"
        title="Topics"
        count={userTopics?.length ?? null}
        actions={
          <button
            className="icon-button"
            type="button"
            aria-label="Create new Topic"
            title="Create new Topic"
            disabled={pending !== null || topics === null}
            onClick={() => void createTopic()}
          >
            {topics === null || pending === 'create'
              ? <LoaderCircle className="spin" size={13} />
              : <Plus size={14} />}
          </button>
        }
      />
      {topics === null ? (
        <div className="workspace-topic-state" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          <span><strong>Loading Topics</strong><small>Reading the Scratch workspace index…</small></span>
        </div>
      ) : projected?.length === 0 ? (
        <div className="workspace-topic-state workspace-topic-state--empty">
          <span className="workspace-topic-state__icon" aria-hidden="true"><NotebookText size={16} /></span>
          <span><strong>No Topics yet</strong><small>Create a Topic to keep its goal, references and Agent sessions together.</small></span>
          <button className="small-button" type="button" disabled={pending !== null} onClick={() => void createTopic()}>
            {pending === 'create' ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}
            {pending === 'create' ? 'Creating…' : 'Create Topic'}
          </button>
        </div>
      ) : null}
      {projected && projected.length > 0 ? (
        <DndContext
          sensors={topicSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => {
            const movedId = String(event.active.id)
            const targetId = event.over ? String(event.over.id) : movedId
            setTopicOrder(reorderTopics(projected.map((entry) => entry.id), movedId, targetId))
          }}
        >
        <SortableContext
          items={projected.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
        <div className="workspace-topic-list" aria-label="Scratch Topics">
          {projected.map((topic) => {
            const isCurrent = topic.id === currentTopic?.id
            const editing = editingTopicId === topic.id
            const pinned = pinnedTopics.includes(topic.id)
            return (
              <SortableTopicItem
                topicId={topic.id}
                isCurrent={isCurrent}
                pinned={pinned}
                key={topic.id}
                onCopyPath={() => void copyTextToClipboard(applyCopyPathStyle(topic.directoryPath, { home: localHome, copyPathsAsAbsolute }), reportError)}
                onRename={() => beginRename(topic)}
                onReveal={() => onRevealDirectory(topic.directoryPath)}
                onTogglePin={() => togglePinnedItem(SCRATCH_WORKSPACE_ID, topic.id)}
                onEditWiki={() => void openFile(`${topic.directoryPath}/${SCRATCH_TOPIC_WIKI_PATH}`, undefined, undefined, workspace.id).catch(reportError)}
                onToggleWiki={topic.wiki ? () => void setTopicWikiEnabled(topic, !topic.wiki!.enabled) : undefined}
                onResetWiki={topic.wiki ? () => void resetTopicWiki(topic) : undefined}
                wikiEnabled={topic.wiki?.enabled}
              >
                {editing ? (
                  <form
                    className="workspace-topic-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void commitRename(topic)
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={`Rename ${topic.title}`}
                      value={editTitle}
                      maxLength={SCRATCH_TOPIC_TITLE_MAX_LENGTH}
                      onChange={(event) => setEditTitle(event.target.value)}
                      onBlur={() => void commitRename(topic)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) =>
                        handleTopicRenameKeyDown(event, { cancel: cancelRename })
                      }
                    />
                  </form>
                ) : (
                  <div
                    className="workspace-topic-entry"
                    data-topic-id={topic.id}
                    {...(isCurrent ? { 'data-current': 'true' } : {})}
                    role="button"
                    tabIndex={pending !== null ? -1 : 0}
                    aria-disabled={pending !== null}
                    onClick={() => { if (pending === null) void openTopic(topic.id) }}
                    onKeyDown={(event) => { if (isImeCompositionKeyDown(event)) return; if (event.target === event.currentTarget && pending === null && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void openTopic(topic.id) } }}
                  >
                    {/* 已 pin 的静息态标记：一枚小 Pin，扫一眼列表就分辨得出哪些被钉住了，不必 hover。
                        它**不是**第二个常驻图标按钮（那会跟标题抢宽度、也会撞 surface-tool-dock 那条
                        「行上只留一个常驻动作」的断言）——pin/unpin 这个**动作**收在右键菜单里，与改名
                        同一处。这里只画一个 aria-hidden 的状态记号，且只在 pinned 时占位，同 leading
                        spinner「只在有话说时才占用」的规矩。 */}
                    {/* 行首不放 Topic 图标：一列全同的图标不携带信息，只在挤压标题宽度。
                        这个位置只在真的有话说时才占用——正在打开时的那枚 spinner。 */}
                    <SelectorRow
                      leading={pending === topic.id ? <span className="workspace-topic-glyph" aria-hidden="true"><LoaderCircle className="spin" size={14} /></span> : undefined}
                      title={<><span>{topic.title}</span>{pinned ? <Pin className="workspace-topic-entry__pin" size={11} aria-hidden="true" /> : null}</>}
                      subtitle={<><span>{topic.summary || topic.directoryPath}</span>{topic.wiki ? <span className={`workspace-topic-entry__wiki workspace-topic-entry__wiki--${topic.wiki.enabled ? 'on' : 'off'}`} title={`${topic.wiki.source === 'default' ? 'Default' : 'User'} Wiki · ${topic.wiki.version}`}>{topic.wiki.enabled ? 'Wiki' : 'Wiki off'} · {topic.wiki.version}{topic.wiki.updatedAt ? ` · ${new Date(topic.wiki.updatedAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ' · default'}</span> : null}</>}
                      /* Region 几何和 Agent 身份同处一格；未挂载的后台 Agent 保留独立入口。 */
                      presence={
                        <TopicPresence
                          cells={openMosaics.get(topic.id)}
                          tabs={topicTabDetails.get(topic.id) ?? []}
                          agents={topic.agents
                            .filter((agent) => agent.live !== null && agent.live.processState === 'running')
                            .sort((left, right) => (sessionTabRank.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) - (sessionTabRank.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER))
                            .map((agent) => {
                            const shown = topicAgentPresentation(agent)
                            return {
                              key: agent.sessionId,
                              providerId: agent.providerId,
                              executorId: agent.live?.executorId,
                              sessionId: agent.live?.id,
                              appearance: agent.live ? config?.executors[agent.live.executorId]?.avatar : undefined,
                              // 经命名链求值，不直接用 agent.live.label。那个 label 是 Main 建的
                              // `executorLabel · workspaceLabel`（链的最低一档），对「同 provider 多个
                              // Agent 同一目录」这个本条要解的场景逐字相同——两枚头像的 tooltip 与
                              // aria-label 会一模一样。`fallback` 仍是它：链的最低一档本来就是它，
                              // 这里不为缺 live 的情形编一个假名字（用 sessionId 兜底是如实的）。
                              label: resolveAgentName({
                                userName: agentNames[agent.sessionId],
                                firstPrompt: firstPromptFromTimeline(timelines[agent.sessionId]),
                                fallback: agent.live?.label ?? agent.sessionId
                              }).name,
                              state: shown.state,
                              onOpen: () => selectSession(agent.sessionId)
                            }
                          })}
                        />
                      }
                    />
                  </div>
                )}
                {/* 行上只留最高频的那个动作。改名收进右键菜单——它一天用不了一次，
                    占一个常驻图标位是在跟标题抢宽度。
                    文案与 TopicContextMenu 那项必须同一句（见那里的注释）：这是在自家文件面板里
                    定位，不是打开系统文件管理器，所以不走 lib/host-platform 的三态文案。 */}
                <span className="workspace-topic-actions">
                  <button
                    className="icon-button workspace-topic-reveal"
                    type="button"
                    aria-label={`Reveal ${topic.title} in Files`}
                    title="Reveal in Files"
                    disabled={pending !== null}
                    onClick={(event) => { event.stopPropagation(); onRevealDirectory(topic.directoryPath) }}
                  >
                    <Crosshair size={13} />
                  </button>
                </span>
              </SortableTopicItem>
            )
          })}
        </div>
        </SortableContext>
        </DndContext>
      ) : null}
      {error ? <div className="new-tab-error" role="alert">{error}</div> : null}
    </section>
  )
}

/**
 * 一行 Topic，可拖拽重排。
 *
 * 复用 Tab 条已经在用的 @dnd-kit/sortable，不自写拖拽；键盘 sensor 一并挂上，
 * 使重排不因为"改成拖拽"而只剩鼠标一条路。
 */
function SortableTopicItem({
  topicId,
  isCurrent,
  pinned,
  children,
  onCopyPath,
  onRename,
  onReveal,
  onTogglePin,
  onEditWiki,
  onToggleWiki,
  onResetWiki,
  wikiEnabled
}: {
  topicId: string
  isCurrent: boolean
  pinned: boolean
  children: ReactNode
  onCopyPath(): void
  onRename(): void
  onReveal(): void
  onTogglePin(): void
  onEditWiki(): void
  onToggleWiki?: (() => void) | undefined
  onResetWiki?: (() => void) | undefined
  wikiEnabled?: boolean | undefined
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: topicId
  })
  return (
    <TopicContextMenu
      pinned={pinned}
      onCopyPath={onCopyPath}
      onRename={onRename}
      onReveal={onReveal}
      onTogglePin={onTogglePin}
      onEditWiki={onEditWiki}
      onToggleWiki={onToggleWiki}
      onResetWiki={onResetWiki}
      {...(wikiEnabled === undefined ? {} : { wikiEnabled })}
    >
      <div
        ref={setNodeRef}
        className={`workspace-topic-item${isCurrent ? ' current' : ''}${isDragging ? ' dragging' : ''}`}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        {...attributes}
        {...listeners}
      >
        {children}
      </div>
    </TopicContextMenu>
  )
}
