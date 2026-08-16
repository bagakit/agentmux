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
import { SCRATCH_TOPIC_TITLE_MAX_LENGTH, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { topicAgentPresentation, topicsWithAgents } from '../lib/surface-tool-dock'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
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
import { openTopicRegionMosaics } from '../lib/scratch-topic-layout'
import { presentError } from '../lib/error-presentation'
import type { RegionGeometry } from '@agentmux/layout'
import { handleTopicRenameKeyDown } from '../lib/topic-rename'
import { TopicContextMenu } from './TopicContextMenu'
import { useAppStore } from '../store'
import { SelectorListHeader, SelectorPresence, SelectorRow } from './SelectorList'

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
  const createScratchTopic = useAppStore((state) => state.createScratchTopic)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const renameScratchTopic = useAppStore((state) => state.renameScratchTopic)
  // 头像点击走全局那一个 selectSession——跳转到某个 Agent 全窗口只有这一条路径，
  // 在这里另写一段"找到它的 Tab 再激活"就是第二条，两条迟早对不上。
  const selectSession = useAppStore((state) => state.selectSession)
  const reportError = useAppStore((state) => state.reportError)
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
  const projected = topics
    ? (() => {
        const withAgents = topicsWithAgents(topics, sessions, workspace)
        const dragOrder = orderTopics(withAgents.map((topic) => topic.id), topicOrder)
        const shown = partitionPinned(dragOrder, pinnedTopics)
        return shown.flatMap((id) => withAgents.filter((topic) => topic.id === id))
      })()
    : null
  const currentTopic = projected?.find((topic) => topic.id === topicId)
  const compact = topics === null || topics.length > 0
  // 一次派生「哪些 Topic 有 Tab 开着」及其 Region 分屏几何，逐行只读它，不让每行各自扫 tabs
  // （scratch-topic-layout.ts 的学说：门禁与几何是同一事实的两半，投影一次）。
  const openMosaics = openTopicRegionMosaics(layout, tabs)

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
      await openScratchTopic(nextTopicId)
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

  return (
    <section className={`surface-tool-summary workspace-topics-panel workspace-topics-panel--${compact ? 'index' : 'empty'}`}>
      {compact ? (
        <SelectorListHeader
          className="workspace-topic-index-header"
          title="Topics"
          count={topics?.length ?? null}
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
      ) : (
        <>
          <div className="surface-tool-summary__icon"><NotebookText size={18} /></div>
          <div className="eyebrow">Topics</div>
          <h2>No Topics yet</h2>
          <p>A Topic is a real shared directory for a goal, outcomes, references, and collaborating Agents.</p>
          <button className="primary-button" type="button" disabled={pending !== null} onClick={() => void createTopic()}>
            {pending === 'create' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
            {pending === 'create' ? 'Creating…' : 'Create new Topic'}
          </button>
        </>
      )}
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
                onCopyPath={() => void copyTextToClipboard(topic.directoryPath, reportError)}
                onRename={() => beginRename(topic)}
                onReveal={() => onRevealDirectory(topic.directoryPath)}
                onTogglePin={() => togglePinnedItem(SCRATCH_WORKSPACE_ID, topic.id)}
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
                  <button
                    className="workspace-topic-entry"
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void openTopic(topic.id)}
                  >
                    {/* 已 pin 的静息态标记：一枚小 Pin，扫一眼列表就分辨得出哪些被钉住了，不必 hover。
                        它**不是**第二个常驻图标按钮（那会跟标题抢宽度、也会撞 surface-tool-dock 那条
                        「行上只留一个常驻动作」的断言）——pin/unpin 这个**动作**收在右键菜单里，与改名
                        同一处。这里只画一个 aria-hidden 的状态记号，且只在 pinned 时占位，同 leading
                        spinner「只在有话说时才占用」的规矩。 */}
                    {pinned ? <Pin className="workspace-topic-entry__pin" size={11} aria-hidden="true" /> : null}
                    {/* 行首不放 Topic 图标：一列全同的图标不携带信息，只在挤压标题宽度。
                        这个位置只在真的有话说时才占用——正在打开时的那枚 spinner。 */}
                    <SelectorRow
                      leading={pending === topic.id ? <LoaderCircle className="spin" size={14} /> : null}
                      title={topic.title}
                      subtitle={topic.summary || topic.directoryPath}
                      /* 每个 Agent 一枚头像：身份看图标、状态看边框，一枚方块答完两件事。
                         这里不给 `N agents` 计数——头像逐个在场，计数是把同一事实说第二遍。
                         簇是行里独立的一段（`.selector-row__meta`），右缘对齐的是行，与本行摘要
                         多长无关——这条性质由共享层的 flex 兑现，不靠本容器的轨道表。此前这里
                         写的是"网格里的尾列"，而 `leading` 可空：只来两段时簇被摆进摘要那一列，
                         直接压在文字上（#467）。 */
                      presence={
                        <SelectorPresence
                          agents={topic.agents.map((agent) => {
                            const shown = topicAgentPresentation(agent)
                            return {
                              key: agent.sessionId,
                              providerId: agent.providerId,
                              label: agent.live?.label ?? agent.sessionId,
                              state: shown.state,
                              onOpen: () => selectSession(agent.sessionId)
                            }
                          })}
                        />
                      }
                      /* 行尾那枚 Region 缩略图：只在这个 Topic 真的开着一张 Tab 时出现（门禁来自
                         openTopicRegionMosaics —— tab.topicId 是唯一绑定真相），画的是那张 Tab 的
                         Region 分屏缩影。Branch 行不传 trailing 缩略图，保留它自己的头像簇/状态胶囊。 */
                      trailing={
                        openMosaics.has(topic.id)
                          ? <RegionMosaic cells={openMosaics.get(topic.id)!} />
                          : null
                      }
                    />
                  </button>
                )}
                {/* 行上只留最高频的那个动作。改名收进右键菜单——它一天用不了一次，
                    占一个常驻图标位是在跟标题抢宽度。
                    文案与 TopicContextMenu 那项必须同一句（见那里的注释）：这是在自家文件面板里
                    定位，不是打开系统文件管理器，所以不走 lib/host-platform 的三态文案。 */}
                <button
                  className="icon-button workspace-topic-reveal"
                  type="button"
                  aria-label={`Reveal ${topic.title} in Files`}
                  title="Reveal in Files"
                  disabled={pending !== null}
                  onClick={() => onRevealDirectory(topic.directoryPath)}
                >
                  <Crosshair size={13} />
                </button>
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
 * 一张 Tab 的 Region 分屏缩影：34×22px 的行尾小方块，按真实归一化几何铺出每个 Region。
 *
 * 几何来自 `workbenchRegionBounds`（0–1 归一化），这里只把它乘进小方块的百分比坐标——不发明第二套
 * 布局模型，Tab 里怎么分屏，这枚缩略图就怎么分。它是一枚一眼可辨的提示（"这个 Topic 开着，且长这样"），
 * 不是可交互的实时镜像，所以不挂点击、不读 Session 状态。
 */
export function RegionMosaic({ cells }: { cells: readonly RegionGeometry[] }) {
  return (
    <span className="topic-region-mosaic" aria-hidden="true">
      {cells.map((cell) => (
        <span
          key={cell.regionId}
          className="topic-region-mosaic__cell"
          style={{
            left: `${cell.bounds.x * 100}%`,
            top: `${cell.bounds.y * 100}%`,
            width: `${cell.bounds.width * 100}%`,
            height: `${cell.bounds.height * 100}%`
          }}
        />
      ))}
    </span>
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
  onTogglePin
}: {
  topicId: string
  isCurrent: boolean
  pinned: boolean
  children: ReactNode
  onCopyPath(): void
  onRename(): void
  onReveal(): void
  onTogglePin(): void
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
