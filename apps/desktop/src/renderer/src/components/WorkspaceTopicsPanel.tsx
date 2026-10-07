import { TextInput } from '@agentmux/client-ui/input'
import { formatZoneAddress } from '@agentmux/core/sharing'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { isKnowledgeTopicInBindings } from '../../../shared/topic-categories'
import { originalTopicAddress } from '../../../shared/space-addresses'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type {
  ScratchTopicSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_TOPIC_TITLE_MAX_LENGTH, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath, scratchTopicPhysicalPath, scratchWorkspaceFilePath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { bumpWorkspaceFileRevision } from '../lib/file-workbench-state'
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
import { activeTopicIdFromLayout, openTopicWorkSurfaces } from '../lib/scratch-topic-layout'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { handleTopicRenameKeyDown } from '../lib/topic-rename'
import { TopicActionsMenu, TopicContextMenu } from './TopicContextMenu'
import { TopicMoveDialog } from './TopicMoveDialog'
import { TopicRowPresence } from './TopicRowPresence'
import { useTopicSessionPaths } from '../lib/topic-session-subscriptions'
import { workbenchDisplayTabs } from '../lib/workbench-resource-display'
import { useAppStore } from '../store'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { SelectorListHeader, SelectorRow } from './SelectorList'
import { topicSpaceIconTarget, type SpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceIconPicker } from './SpaceIconPicker'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCreateTopicIcon = semanticIconComponent('action.create-topic')
const ThemeStatusInfoIcon = semanticIconComponent('status.info')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectNotebookIcon = semanticIconComponent('object.notebook')
const ThemeActionPinIcon = semanticIconComponent('action.pin')


/**
 * 一个 selector 的返回值就是 `useSyncExternalStore` 的快照，React 用 `Object.is` 比较它。所以缺省值必须是
 * 这个**常量**，不能是就地写的 `?? []` —— 那个字面量每次调用都新建一个数组，快照永远「变了」，组件立刻
 * 进入无限重渲染（React error #185，控制台先报 "The result of getSnapshot should be cached"）。
 * `togglePinnedItem` 在清空时会 delete 掉整个 key（store.ts 的 `pinnedItems` 分支），所以「缺 key」是常态
 * 而不是边角：没 pin 过任何东西的全新 userData 一进来就撞上，日常用的 profile 反而因为 key 在而正常。
 */
const NO_PINNED_TOPICS: readonly string[] = []
const NO_TOPICS: readonly ScratchTopicSnapshot[] = []
const NO_SURFACES: readonly import('../lib/scratch-topic-layout').TopicTabSurface[] = []

export function WorkspaceTopicsPanel({
  workspace,
  onRevealDirectory,
  categorySpaceId,
  visible = true
}: {
  workspace: WorkspaceRecord
  categorySpaceId?: string | undefined
  visible?: boolean | undefined
  onRevealDirectory(path: string): void
}) {
  const displayPath = usePathDisplay()
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const category = useAppStore(state => state.topicCategories.find(category => category.spaceId === categorySpaceId))
  const layout = useAppStore((state) => state.layouts[workspace.id])
  const tabs = useAppStore(useShallow(state => workbenchDisplayTabs(state.tabs, workspace.id, layout)))
  const selection = useAppStore(state => state.workbenchSpaceSelection)
  const topicId = selection?.workspaceId === workspace.id ? selection.topicId : layout ? activeTopicIdFromLayout(layout, tabs) : null
  const createScratchTopic = useAppStore((state) => state.createScratchTopic)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const renameScratchTopic = useAppStore((state) => state.renameScratchTopic)
  const openFile = useAppStore((state) => state.openFile)
  const reportError = useAppStore((state) => state.reportError)
  const { topics, error: readError } = useScratchTopics(workspace.id, visible)
  const [pending, setPending] = useState<string | null>(null)
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [categoryRefresh, setCategoryRefresh] = useState<{ spaceId: string; busy: boolean; error: string | null } | null>(null)
  const categoryRefreshState = categoryRefresh?.spaceId === categorySpaceId ? categoryRefresh : null
  const [iconTarget, setIconTarget] = useState<SpaceIconTarget | null>(null)
  const [moveTarget, setMoveTarget] = useState<{ topicId: string; title: string } | null>(null)
  const manualIcons = useAppStore(state => state.spaceObjectIcons)
  const panel = useRef<HTMLElement>(null)
  const iconReturnKey = useRef<string | null>(null)
  const iconInvoker = useRef<HTMLElement | null>(null)
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
  // 这一桶，投影与它必须同源，否则「列表里靠前」和「挂在 Topics 下」会各说各话。
  const pinnedTopics = useAppStore((state) => state.pinnedItems[SCRATCH_WORKSPACE_ID] ?? NO_PINNED_TOPICS)
  const togglePinnedItem = useAppStore((state) => state.togglePinnedItem)
  // 文件系统仍是 Topic 存在与否的真相；用户顺序只决定怎么排。
  // 先 orderTopics 定拖拽序，再 partitionPinned 把 pin 的提到前面——是一次**分区**不是排序：
  // pin 段按 pin 的先后、未 pin 段保留拖拽序原样。两者组合而不是取代（见 topic-order.ts）。
  const userTopics = useMemo(() => topics?.filter(topic => isKnowledgeTopicInBindings(topic, bindings) &&
    (!categorySpaceId || (() => { const address = originalTopicAddress(workspace, topic, bindings)
      return address && bindings[address.zoneId]?.relations?.[categorySpaceId] === true })())) ?? null,
    [topics, bindings, categorySpaceId, workspace])
  const projected = useMemo(() => {
    if (!userTopics) return null
    const byId = new Map(userTopics.map(topic => [topic.id, topic]))
    return partitionPinned(orderTopics([...byId.keys()], topicOrder), pinnedTopics).flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
  }, [userTopics, topicOrder, pinnedTopics])
  const currentTopic = projected?.find(topic => topic.id === topicId)
  const paths = useTopicSessionPaths(workspace, topics ?? NO_TOPICS)
  const openWorkSurfaces = useMemo(() => openTopicWorkSurfaces(layout, tabs), [layout, tabs])

  async function refreshCategoryDescription(): Promise<void> {
    const spaceId = categorySpaceId!
    setCategoryRefresh({ spaceId, busy: true, error: null })
    try {
      const result = await api.topics.call('topic.category.ls', {})
      const original = result.categories.find(item => item.spaceId === spaceId && (!category || item.categoryId === category.categoryId))
      if (original && !original.readError) {
        // Only the Host description is refreshed. Membership, navigation and workfaces retain their owners.
        useAppStore.setState(state => state.topicCategories.find(item => item.spaceId === spaceId) !== category ? state : ({
          topicCategories: state.topicCategories.some(item => item.spaceId === spaceId)
            ? state.topicCategories.map(item => item.spaceId === spaceId ? original : item)
            : [...state.topicCategories, original] }))
      }
      setCategoryRefresh({ spaceId, busy: false, error: original?.readError ?? (original ? null : 'The original Category description is still unavailable. Restore its source, then refresh to retry.') })
    } catch (cause) {
      setCategoryRefresh({ spaceId, busy: false, error: presentError(cause) })
    }
  }

  async function createTopic(): Promise<void> {
    if (pending) return
    if (categorySpaceId && (!category || category.readError)) {
      setError('The selected Category description is not confirmed. Reopen this Category after refreshing Topics; its existing discussions remain available.')
      return
    }
    setPending('create')
    setError(null)
    try {
      await createScratchTopic(undefined, undefined, category ? { categoryId: category.categoryId } : undefined)
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

  const selectTopicTab = useCallback(async (nextTopicId: string, tabId: string, groupId?: string): Promise<void> => {
    try {
      await openScratchTopic(nextTopicId, workspace.id, { tabId, ...(groupId === undefined ? {} : { groupId }) })
    } catch (cause) {
      setError(presentError(cause))
    }
  }, [openScratchTopic, workspace.id])

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
      setError('Topic title cannot be empty')
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
      await renameScratchTopic(topic.id, title)
      cancelRename()
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setPending(null)
    }
  }

  function invalidateTopics(): void {
    useAppStore.setState((current) => ({
      workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspace.id)
    }))
  }

  async function setTopicWikiEnabled(topic: ScratchTopicSnapshot, enabled: boolean): Promise<void> {
    if (pending) return
    setPending(`wiki:${topic.id}`)
    setError(null)
    try {
      await api.scratch.setWikiEnabled(workspace.id, topic.id, enabled)
      invalidateTopics()
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
      await api.scratch.resetWiki(workspace.id, topic.id)
      invalidateTopics()
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setPending(null)
    }
  }

  return (
    <section ref={panel} className="surface-tool-summary workspace-topics-panel workspace-topics-panel--index">
      <SelectorListHeader
        className="workspace-topic-index-header"
        title={category?.title ?? 'All Topics'}
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
              ? <ThemeStatusLoadingIcon className="spin" size={13} />
              : <ThemeActionCreateTopicIcon size={14} />}
          </button>
        }
      />
      {categorySpaceId && (!category || category.readError) ? <div className="workspace-topic-category-status" role="status">
        <ThemeStatusInfoIcon size={14} aria-hidden="true" />
        <span>{categoryRefreshState?.error ?? category?.readError ?? 'The selected Category description is still restoring.'} Existing Topics and discussions remain available.</span>
        <button type="button" className="icon-button" aria-label="Refresh category description" title="Refresh category description"
          disabled={categoryRefreshState?.busy} onClick={() => void refreshCategoryDescription()}>
          <ThemeActionRefreshIcon size={13} className={categoryRefreshState?.busy ? 'spin' : undefined} />
        </button>
      </div> : null}
      {topics === null ? (
        <div className="workspace-topic-state" role="status">
          <ThemeStatusLoadingIcon className="spin" size={16} aria-hidden="true" />
          <span><strong>Loading Topics</strong><small>Reading the Topics directory…</small></span>
        </div>
      ) : projected?.length === 0 ? (
        <div className="workspace-topic-state workspace-topic-state--empty">
          <span className="workspace-topic-state__icon" aria-hidden="true"><ThemeObjectNotebookIcon size={16} /></span>
          <span><strong>{category ? 'No Topics in this category' : 'No Topics yet'}</strong><small>Create a Topic to keep its knowledge and discussions together.</small></span>
          <button className="small-button" type="button" disabled={pending !== null} onClick={() => void createTopic()}>
            {pending === 'create' ? <ThemeStatusLoadingIcon className="spin" size={12} /> : <ThemeActionCreateTopicIcon size={12} />}
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
            setTopicOrder(reorderTopics(projected.map((entry) => entry.id), movedId, targetId, topicOrder))
          }}
        >
        <SortableContext
          items={projected.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
        <div className="workspace-topic-list" aria-label="Topics list">
          {projected.map((topic) => {
            const isCurrent = topic.id === currentTopic?.id
            const editing = editingTopicId === topic.id
            const pinned = pinnedTopics.includes(topic.id)
            const target = topicSpaceIconTarget(workspace, topic, bindings)
            const logicalPath = scratchTopicLogicalPath(workspace, topic)
            const physicalPath = scratchTopicPhysicalPath(workspace, topic)
            function withLogicalPath(action: (path: string) => void): void {
              if (logicalPath === null || topic.readError) {
                reportError(new Error('The original directory read is not confirmed. Refresh Topics and retry this operation.'))
                return
              }
              action(logicalPath)
            }
            function copyTopicAddress(): void {
              const address = originalTopicAddress(workspace, topic, bindings)
              if (!address) { reportError(new Error('The original Topic identity is unconfirmed. Refresh Topics and retry copying its address.')); return }
              void copyTextToClipboard(formatZoneAddress({ zoneId: address.zoneId }), reportError)
            }
            const menuActions = {
              pinned,
              onCopyLink: copyTopicAddress,
              onCopyPath: () => withLogicalPath(path => {
                const absolute = scratchWorkspaceFilePath(workspace, topics, path)
                if (absolute === null) { reportError(new Error('The original directory read is not confirmed. Refresh Topics and retry copying its path.')); return }
                void copyTextToClipboard(displayPath(absolute, workspace.hostId), reportError)
              }),
              onRename: () => beginRename(topic),
              onReveal: () => withLogicalPath(onRevealDirectory),
              onTogglePin: () => togglePinnedItem(SCRATCH_WORKSPACE_ID, topic.id),
              onEditWiki: () => withLogicalPath(path => void openFile(`${path}/${SCRATCH_TOPIC_WIKI_PATH}`, undefined, undefined, workspace.id).catch(reportError)),
              onToggleWiki: topic.wiki ? () => void setTopicWikiEnabled(topic, !topic.wiki!.enabled) : undefined,
              onResetWiki: topic.wiki ? () => void resetTopicWiki(topic) : undefined,
              onChangeIcon: () => { if (!target) { reportError(new Error('The original object identity is unconfirmed. Repair its directory record before changing its icon.')); return } iconReturnKey.current = target.key; iconInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setIconTarget(target) },
              onMove: () => setMoveTarget({ topicId: topic.id, title: topic.title }),
              wikiEnabled: topic.wiki?.enabled
            }
            return (
              <SortableTopicItem
                topicId={topic.id}
                isCurrent={isCurrent}
                key={topic.id}
                {...menuActions}
              >
                {editing ? (
                  <form
                    className="workspace-topic-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void commitRename(topic)
                    }}
                  >
                    <TextInput
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
                    data-space-icon-target={target?.key}
                    {...(isCurrent ? { 'data-current': 'true' } : {})}
                    role="button"
                    aria-current={isCurrent ? 'page' : undefined}
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
                    <SelectorRow
                      leading={pending === topic.id ? <span className="workspace-topic-glyph" aria-hidden="true"><ThemeStatusLoadingIcon className="spin" size={14} /></span>
                        : <SpaceObjectIcon kind={target?.kind ?? 'topic'} name={target?.name ?? topic.title} manualIcon={target ? manualIcons[target.key] ?? null : null} imageTarget={target?.imageTarget} avatarObjectKey={target?.key} avatarWorkspaceId={target?.avatarTarget?.workspaceId} avatarTopicId={target?.avatarTarget?.topicId} />}
                      title={<><span title={topic.title}>{topic.title}</span>{pinned ? <ThemeActionPinIcon className="workspace-topic-entry__pin" size={11} aria-hidden="true" /> : null}</>}
                      subtitle={<><span>{topic.summary || displayPath(physicalPath, workspace.hostId)}</span>{topic.wiki ? <span className={`workspace-topic-entry__wiki workspace-topic-entry__wiki--${topic.wiki.enabled ? 'on' : 'off'}`} title={`${topic.wiki.source === 'default' ? 'Default' : 'User'} Wiki · ${topic.wiki.version}`}>{topic.wiki.enabled ? 'Wiki' : 'Wiki off'} · {topic.wiki.version}{topic.wiki.updatedAt ? ` · ${new Date(topic.wiki.updatedAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ' · default'}</span> : null}</>}
                      /* Region 几何和 Agent 身份同处一格；未挂载的后台 Agent 保留独立入口。 */
                      presence={
                        <TopicRowPresence workspace={workspace} topic={topic} paths={paths.get(topic.id) ?? NO_PINNED_TOPICS}
                          surfaces={openWorkSurfaces.get(topic.id) ?? NO_SURFACES} active={visible} onSelectTab={selectTopicTab} />
                      }
                    />
                  </div>
                )}
                {/* One visible menu shares all actions with the keyboard/context menu. */}
                <span className="workspace-topic-actions">
                  <TopicActionsMenu title={topic.title} {...menuActions} />
                </span>
                {topic.readError ? <div className="surface-inline-error" role="alert">{topic.title}: {topic.readError}. Its work surface is retained.</div> : null}
              </SortableTopicItem>
            )
          })}
        </div>
        </SortableContext>
        </DndContext>
      ) : null}
      {readError ? <div className="surface-inline-error" role="alert">Topics could not be refreshed: {readError}. Existing work surfaces remain available.</div> : null}
      {error ? <div className="surface-inline-error" role="alert">{error}</div> : null}
      <TopicMoveDialog target={moveTarget} onClose={() => setMoveTarget(null)} />
      <SpaceIconPicker target={iconTarget} onClose={() => setIconTarget(null)} returnFocus={() =>
        iconInvoker.current?.isConnected ? iconInvoker.current : [...(panel.current?.querySelectorAll<HTMLElement>('[data-space-icon-target]') ?? [])]
          .find(node => node.dataset.spaceIconTarget === iconReturnKey.current) ?? null} />
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
  onCopyLink,
  onRename,
  onReveal,
  onTogglePin,
  onEditWiki,
  onToggleWiki,
  onResetWiki,
  onChangeIcon,
  onMove,
  wikiEnabled
}: {
  topicId: string
  isCurrent: boolean
  pinned: boolean
  children: ReactNode
  onCopyPath(): void
  onCopyLink(): void
  onRename(): void
  onReveal(): void
  onTogglePin(): void
  onEditWiki(): void
  onToggleWiki?: (() => void) | undefined
  onResetWiki?: (() => void) | undefined
  onChangeIcon(): void
  onMove(): void
  wikiEnabled?: boolean | undefined
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: topicId
  })
  return (
    <TopicContextMenu
      pinned={pinned}
      onCopyPath={onCopyPath}
      onCopyLink={onCopyLink}
      onRename={onRename}
      onReveal={onReveal}
      onTogglePin={onTogglePin}
      onEditWiki={onEditWiki}
      onToggleWiki={onToggleWiki}
      onResetWiki={onResetWiki}
      onChangeIcon={onChangeIcon}
      onMove={onMove}
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
