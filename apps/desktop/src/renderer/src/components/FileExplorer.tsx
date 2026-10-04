import { TextInput } from '@agentmux/client-ui/input'
import { Link2 } from 'lucide-react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { InlineRenameField } from '@agentmux/client-ui/components/InlineRenameField'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useDndMonitor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragCancelEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  ChevronDown,
  ChevronRight,
  Check,
  ChevronsDownUp,
  Eye,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  TriangleAlert,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import { isFolderWorkspace, isScratchWorkspaceId } from '../../../shared/contracts'
import { scratchTopicIdFromDirectoryName, scratchWorkspaceFilePath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { applyWorkspacePathRebind } from '../lib/workspace-path-recovery'
import { getFileTypeIcon } from '../lib/file-type-icons'
import { documentKey } from '../lib/workbench-tabs'
import { fileNavigationSelection, useAppStore } from '../store'
import { useWorkspaceResource } from '../hooks/useWorkspaceResource'
import { ConfirmationDialog } from './ConfirmationDialog'
import * as DropdownMenu from './HoverDropdownMenu'
import { projectFileExplorerRows } from './file-tree/file-explorer-visibility'
import {
  isNavigationKey,
  resolveFileExplorerNavigationTarget
} from './file-tree/file-explorer-keyboard-navigation'
import { getRevealAncestorPaths } from '../lib/workspace-paths'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { copyTextToClipboard, formatPathsForCopy } from '../lib/clipboard-copy'
import {
  FILE_TREE_GIT_STATUS_CLASS,
  FILE_TREE_GIT_STATUS_LABEL,
  FILE_TREE_GIT_STATUS_MARK,
  buildFileTreeGitStatusIndex,
  type FileTreeGitStatus
} from '../lib/file-tree-git-status'
import { useGitStatus } from '../hooks/useGitStatus'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { fileExplorerContains } from '../lib/file-explorer-scope'
import { createFileExplorerRowProjection } from './file-tree/file-explorer-row-projection'
import { useFileTreeViewport } from './file-tree/useFileTreeViewport'
import { refreshFileExplorer } from './file-tree/file-explorer-refresh'
import { presentExpandedDir } from './file-tree/file-explorer-stale-dir-cache'
import {
  createSingleFileExplorerSelection,
  createEmptyFileExplorerViewState,
  getFileExplorerSelectionMode,
  revealFileExplorerPath,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths,
  type FileExplorerSelectionState
} from '../lib/file-explorer-selection'
import {
  flattenFileTree,
  useWorkspaceFileTree,
  type TreeNode
} from './file-tree/useWorkspaceFileTree'
import { FileTreeContextMenu } from './file-tree/FileTreeContextMenu'
import { isMacPlatform } from '../lib/host-platform'
import { createDirectoryProjectInput } from '../lib/open-directory-as-project'
import {
  createFileExplorerMoveIndex,
  fileExplorerDropDirectory,
  fileExplorerMoveTargets,
  isFileExplorerMenuKey,
  planFileExplorerMove,
  runFileExplorerMove,
  workspacePathParent,
  FILE_EXPLORER_DELETE_KEY,
  FILE_EXPLORER_RENAME_KEY,
  type FileExplorerMoveTarget
} from '../lib/file-explorer-move'

type InlineEdit = { id: number; workspaceId: string; workspacePath: string; rootPath: string } & (
  | { kind: 'create-file' | 'create-directory'; parentPath: string }
  | { kind: 'rename'; node: TreeNode }
)

const EMPTY_EXPLORER_STATE = createEmptyFileExplorerViewState()

type FileExplorerDragData = { kind: 'file-explorer-path'; path: string; name: string }
type FileExplorerDropData = { kind: 'file-explorer-directory'; directoryPath: string }

export type FileExplorerRevealRequest = {
  workspaceId: string
  path: string
  requestId: number
}

// A probe-only observer of the existing DndContext; it never dispatches drag state.
function FileExplorerCancelTraceObserver({ workspaceId }: { workspaceId: string | null | undefined }) {
  function observe(kind: string, event: DragStartEvent | DragMoveEvent | DragOverEvent | DragCancelEvent | DragEndEvent): void {
    const sink = (window as Window & {
      __agentmuxFileEditingCancelTrace?: { observeDnd(event: Record<string, unknown>): void }
    }).__agentmuxFileEditingCancelTrace
    if (!sink) return
    const over = 'over' in event ? event.over : undefined
    sink.observeDnd({ kind, workspaceId, activeId: event.active.id,
      activePath: event.active.data.current?.path ?? null,
      activeEnded: kind === 'cancel' || kind === 'end',
      overCollected: 'over' in event, overId: over?.id ?? null,
      overDirectory: over?.data.current?.directoryPath ?? null })
  }
  useDndMonitor({
    onDragStart: (event) => observe('start', event),
    onDragMove: (event) => observe('move', event),
    onDragOver: (event) => observe('over', event),
    onDragCancel: (event) => observe('cancel', event),
    onDragEnd: (event) => observe('end', event)
  })
  return null
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function validName(value: string): boolean {
  const name = value.trim()
  return Boolean(name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'))
}

export function canRenameFileExplorerNode(workspaceId: string, node: TreeNode): boolean {
  return !(isScratchWorkspaceId(workspaceId) &&
    node.isDirectory &&
    !node.path.includes('/') &&
    scratchTopicIdFromDirectoryName(node.path) !== null)
}

function FileTreeRow({
  node,
  rowIndex,
  expanded,
  loadFailure,
  selected,
  dirty,
  gitStatus,
  editing,
  editId,
  editPending,
  editError,
  pathTitle,
  editValue,
  onEditValue,
  onCommitEdit,
  onCancelEdit,
  onClick,
  onSelect,
  onCollapse,
  onContextMenuChange,
  onCopyPaths,
  onCreate,
  onToggle,
  onOpenTerminal,
  onOpenAsProject,
  onRename,
  onDelete,
  onReveal,
  onViewFile,
  onMove,
  getMoveTargets,
  canOpenTerminal,
  canMove,
  dropDisabled,
  canRename,
  isLocal,
  selectionSize
}: {
  node: TreeNode
  rowIndex: number
  expanded: boolean
  /** 展开的目录读失败时的原因；读成功、真的空目录、以及文件行都是 null。 */
  loadFailure: string | null
  selected: boolean
  dirty: boolean
  /** 该节点的源码状态，来自 git:status 的纯投影；干净或未知时为 null。 */
  gitStatus: FileTreeGitStatus | null
  editing: boolean
  editId: number | undefined
  editPending: boolean
  editError: string | null
  pathTitle: string
  editValue: string
  onEditValue: (value: string) => void
  onCommitEdit: (value: string) => Promise<void>
  onCancelEdit: () => void
  onClick: (event: React.MouseEvent) => void
  onSelect: (event: React.MouseEvent) => void
  onCollapse: () => void
  onContextMenuChange: (open: boolean) => void
  onCopyPaths: (kind: 'absolute' | 'relative') => void
  onCreate: (kind: 'file' | 'directory') => void
  onToggle: () => void
  onOpenTerminal: () => void
  onOpenAsProject: () => void
  onRename: () => void
  onDelete: () => void
  onReveal: () => void
  onViewFile: () => void
  onMove: (directoryPath: string) => void
  getMoveTargets: () => readonly FileExplorerMoveTarget[]
  canOpenTerminal: boolean
  canMove: boolean
  dropDisabled: boolean
  canRename: boolean
  isLocal: boolean
  selectionSize: number
}) {
  const FileIcon = getFileTypeIcon(node.path)
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging
  } = useDraggable({
    id: `file-explorer-path:${node.path}`,
    data: { kind: 'file-explorer-path', path: node.path, name: node.name } satisfies FileExplorerDragData,
    disabled: editing || !canMove
  })
  const {
    setNodeRef: setDroppableRef,
    isOver
  } = useDroppable({
    id: `file-explorer-target:${node.path}`,
    data: {
      kind: 'file-explorer-directory',
      directoryPath: fileExplorerDropDirectory(node)
    } satisfies FileExplorerDropData,
    disabled: editing || dropDisabled
  })
  const setRowRef = useCallback((element: HTMLDivElement | null) => {
    setDraggableRef(element)
    setDroppableRef(element)
  }, [setDraggableRef, setDroppableRef])
  return (
    <FileTreeContextMenu
      canRename={canRename}
      canOpenTerminal={canOpenTerminal}
      isDirectory={node.isDirectory}
      isExpanded={expanded}
      isLocal={isLocal}
      selectionSize={selectionSize}
      getMoveTargets={getMoveTargets}
      onOpenChange={onContextMenuChange}
      onCreate={onCreate}
      onCopyPaths={onCopyPaths}
      onOpenTerminal={onOpenTerminal}
      onOpenAsProject={onOpenAsProject}
      onMove={onMove}
      onViewFile={onViewFile}
      onCollapse={onCollapse}
      onReveal={onReveal}
      onRename={onRename}
      onDelete={onDelete}
    >
      <div
        ref={setRowRef}
        {...attributes}
        {...listeners}
        className={`tree-row ${node.ignored ? 'tree-row--ignored' : ''} ${selected ? 'tree-row--selected' : ''} ${isDragging ? 'tree-row--dragging' : ''} ${isOver ? 'tree-row--drop-over' : ''} ${loadFailure ? 'tree-row--load-failed' : ''} ${gitStatus ? FILE_TREE_GIT_STATUS_CLASS[gitStatus] : ''}`}
        style={{ '--tree-depth': node.depth } as React.CSSProperties}
        title={[pathTitle, node.ignored ? 'Ignored by Git' : '', node.isSymlink ? `${node.linkIssue ? 'Unavailable' : node.isDirectory ? 'Directory' : 'File'} link` : ''].filter(Boolean).join(' · ') || undefined}
        data-tree-path={node.path}
        data-tree-index={rowIndex}
        data-load-failed={loadFailure ? 'true' : 'false'}
        data-move-drop-disabled={dropDisabled ? 'true' : 'false'}
        role="treeitem"
        tabIndex={selected ? 0 : -1}
        aria-level={node.depth + 1}
        aria-expanded={node.isDirectory ? expanded : undefined}
        aria-selected={selected}
        onClick={onClick}
      >
        <button
          type="button"
          className="tree-row__disclosure"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation()
            if (node.isDirectory) onToggle()
          }}
          aria-label={node.isDirectory ? `${expanded ? 'Collapse' : 'Expand'} ${node.name}` : undefined}
        >
          {node.isDirectory ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </button>
        <span
          className="tree-row__icon"
          // 读失败的目录此前与真的空目录逐像素相同（都是展开的空文件夹）。图标换成告警，并把原因
          // 放进 title——否则用户会以为那个目录真的什么都没有。
          title={loadFailure ?? undefined}
        >
          {loadFailure
            ? <TriangleAlert size={14} aria-label={`Could not read ${node.name}`} />
            : node.isDirectory
              ? expanded ? <FolderOpen size={14} /> : <Folder size={14} />
              : <FileIcon size={13} />}
        </span>
        {editing ? (
          <InlineRenameField inputClassName="tree-inline-input" key={editId}
            label={`Rename ${node.name}`}
            error={editError}
            pending={editPending}
            selectionEnd={!node.isDirectory && node.name.lastIndexOf('.') > 0 ? node.name.lastIndexOf('.') : node.name.length}
            value={editValue}
            onValueChange={onEditValue}
            onCommit={onCommitEdit}
            onCancel={onCancelEdit}
          />
        ) : (
          <button
            type="button"
            className="tree-row__label"
            tabIndex={-1}
            title={canRename ? `${pathTitle}\nDouble-click to rename (F2)` : pathTitle}
            onClick={(event) => {
              event.stopPropagation()
              // The first click activates; the second belongs to inline Rename.
              if (event.detail < 2) onClick(event)
              else onSelect(event)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              if (canRename && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) onRename()
            }}
          >
            {node.name}
          </button>
        )}
        {dirty ? <i className="tree-row__dirty" aria-label="Unsaved changes" /> : null}
        {/*
          源码状态标记。字母（M/A/?/D/R/!）是承重的非色信号，颜色只是强化——见 dock.css 里
          .tree-row__git 的理由。判定不在这里：状态、class、字母全出自 lib/file-tree-git-status.ts
          的穷举表，这里只把它渲染成一个带 title/aria-label 的记号。
        */}
        {gitStatus ? (
          <span
            className="tree-row__git"
            title={FILE_TREE_GIT_STATUS_LABEL[gitStatus]}
            aria-label={FILE_TREE_GIT_STATUS_LABEL[gitStatus]}
          >
            {FILE_TREE_GIT_STATUS_MARK[gitStatus]}
          </span>
        ) : null}
        {node.isSymlink ? <Link2 size={11} className="tree-row__link" aria-label={node.linkIssue ? 'Unavailable symbolic link' : node.isDirectory ? 'Directory symbolic link' : 'File symbolic link'} /> : null}
      </div>
    </FileTreeContextMenu>
  )
}

function FileExplorerRootDropTarget({ disabled, rootPath, rootLabel }: { disabled: boolean; rootPath: string; rootLabel: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'file-explorer-target:root:' + rootPath,
    data: { kind: 'file-explorer-directory', directoryPath: rootPath } satisfies FileExplorerDropData,
    disabled
  })
  return (
    <div
      ref={setNodeRef}
      className={`file-tree-root-target ${isOver ? 'file-tree-root-target--over' : ''}`}
      data-move-drop-disabled={disabled ? 'true' : 'false'}
    >
      <FolderOpen size={12} /><span>{rootLabel}</span>
    </div>
  )
}

export function FileExplorer({
  revealRequest, createRequest, onCreateRequestHandled, toolbarTarget, workspaceId: requestedWorkspaceId, rootPath = '', rootLabel = 'Workspace Root', onOpenPath, onOpenTerminal, active = true
}: {
  active?: boolean
  onCreateRequestHandled?: (() => void) | undefined
  createRequest?: { requestId: number; parentPath: string } | undefined
  workspaceId?: string | undefined
  rootPath?: string | undefined
  rootLabel?: string | undefined
  onOpenPath?: ((path: string) => Promise<unknown>) | undefined
  onOpenTerminal?: ((path: string) => Promise<unknown>) | undefined
  revealRequest?: FileExplorerRevealRequest | undefined
  /** undefined: own toolbar; null: shared header slot is not attached yet. */
  toolbarTarget?: HTMLElement | null | undefined
}) {
  const workspaceId = useAppStore((state) => requestedWorkspaceId ?? state.activeWorkspaceId)
  const workspace = useWorkspaceResource(workspaceId)
  const activePath = useAppStore((state) =>
    workspaceId && fileExplorerContains(rootPath, state.lastActiveFileByWorkspace[workspaceId] ?? '') ? state.lastActiveFileByWorkspace[workspaceId] : undefined
  )
  const originalOpenFile = useAppStore((state) => state.openFileAndReveal)
  const fileRevealRef = useRef<AbortController | null>(null)
  const openFile = (path: string, groupId?: string, location?: { line: number; column?: number }, resourceId = workspaceId) => {
    if (onOpenPath) return onOpenPath(path)
    fileRevealRef.current?.abort()
    const intent = new AbortController()
    fileRevealRef.current = intent
    return originalOpenFile(path, groupId, location, resourceId ?? undefined, intent.signal)
  }
  const createPath = useAppStore((state) => state.createPath)
  const renamePath = useAppStore((state) => state.renamePath)
  const deletePath = useAppStore((state) => state.deletePath)
  const launchTerminal = useAppStore((state) => state.launchTerminal)
  const reportError = useAppStore((state) => state.reportError)
  const displayPath = usePathDisplay()
  const scratchTopics = useAppStore(state => scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace))
  const setConfig = useAppStore((state) => state.setConfig)
  const activePaneId = useAppStore((state) => (
    workspaceId ? state.layouts[workspaceId]?.activeGroupId : undefined
  ))
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  // Source-control status projected straight onto the tree — no second copy of "what changed" in the
  // store, it consumes the same git:status the Changes panel does. The mapping from porcelain to a
  // per-node status is a pure function (lib/file-tree-git-status); this component only asks it.
  const { status: gitStatus, refresh: refreshGitStatus } = useGitStatus(workspaceId ?? null, active)
  const gitStatusIndex = useMemo(() => {
    if (gitStatus?.kind !== 'git-repository') return buildFileTreeGitStatusIndex([])
    // The prefix comes from main, which asked git for it (`rev-parse --show-prefix`). It is NOT
    // recomputed from repoPath vs workspace.path: those two strings can disagree in any ancestor
    // segment (git canonicalizes symlinks and on-disk casing, the config path does not), and the
    // failed comparison would silently yield '' — the value that makes the projection below stop
    // filtering and paint one file's status onto a different, clean file.
    return buildFileTreeGitStatusIndex(gitStatus.changes, gitStatus.repoRelativePrefix)
  }, [gitStatus])
  const observedRevision = useAppStore(state => active && workspaceId ? state.workspaceFileRevisions[workspaceId] ?? 0 : null)
  const heldRevision = useRef({ workspaceId, value: observedRevision ?? (workspaceId ? useAppStore.getState().workspaceFileRevisions[workspaceId] ?? 0 : 0) })
  if (observedRevision !== null) heldRevision.current = { workspaceId, value: observedRevision }
  else if (heldRevision.current.workspaceId !== workspaceId) heldRevision.current = { workspaceId, value: workspaceId ? useAppStore.getState().workspaceFileRevisions[workspaceId] ?? 0 : 0 }
  const workspaceFileRevision = heldRevision.current.value
  const explorerState = useAppStore((state) => (
    workspaceId ? state.fileExplorerStates[workspaceId] : undefined
  )) ?? EMPTY_EXPLORER_STATE
  const updateExplorerState = useAppStore((state) => state.updateFileExplorerState)
  const showHidden = useAppStore(state => state.explorerShowHidden)
  const showIgnored = useAppStore(state => state.explorerShowIgnored)
  const toggleShowHidden = useAppStore(state => state.toggleExplorerShowHidden)
  const toggleShowIgnored = useAppStore(state => state.toggleExplorerShowIgnored)
  const [query, setQuery] = useState('')
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null)
  const editIntent = useRef(0)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [editPending, setEditPending] = useState(false)
  const editSubmissionRef = useRef<InlineEdit | null>(null)
  const workspacePath = workspace?.path ?? ''
  useEffect(() => () => { fileRevealRef.current?.abort() }, [workspaceId, workspace?.hostId, workspacePath, rootPath])
  const editContextRef = useRef({ workspaceId, workspacePath, rootPath })
  editContextRef.current = { workspaceId, workspacePath, rootPath }
  const [deleteRequest, setDeleteRequest] = useState<{ node: TreeNode; workspaceId: string; rootPath: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [relinking, setRelinking] = useState(false)
  const [activeDrag, setActiveDrag] = useState<FileExplorerDragData | null>(null)
  const dragVisibilityRef = useRef<{ showHidden: boolean; showIgnored: boolean; query: string } | null>(null)
  const activeDragScopeRef = useRef<{ workspaceId: string | null; rootPath: string } | null>(null)
  const [scrollTarget, setScrollTarget] = useState<{
    path: string
    requestId: number
    focus: boolean
    openMenu?: boolean
  } | null>(null)
  const treeRootRef = useRef<HTMLDivElement>(null)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const lastRevealedPathRef = useRef<string | null>(null)
  const lastRevealRequestIdRef = useRef<number | null>(null)
  const autoRevealRequestIdRef = useRef(0)
  const observedFileRevisionRef = useRef(workspaceFileRevision)
  const expanded = useMemo(() => new Set([...explorerState.expandedPaths].filter(path => fileExplorerContains(rootPath, path))), [explorerState.expandedPaths, rootPath])
  const selection = useMemo(() => updateFileExplorerSelectionPaths(explorerState.selection, path => fileExplorerContains(rootPath, path) ? path : null), [explorerState.selection, rootPath])
  const selectedPath = selection.activePath
  const tree = useWorkspaceFileTree(workspaceId ?? 'missing-workspace', expanded, rootPath, active)
  const isMac = useMemo(() => isMacPlatform(), [])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const hoverExpandRef = useRef<{ path: string; timer: number } | null>(null)
  // 五个触发点（revision 变化、窗口重获焦点、重绑路径、头部按钮、读失败重试）共用的那一个「刷新」。
  // 见 file-tree/file-explorer-refresh.ts：把结构与 git 状态收成一个动作，是因为它们分开时
  // 漏掉的那一半完全静默——#750 就是 git 那半边从来没人调。
  const refreshExplorer = useCallback(
    async (discover = true) => {
      await Promise.all([
        refreshFileExplorer({ refreshTree: tree.refreshTree, refreshGitStatus }),
        discover && workspaceId && isScratchWorkspaceId(workspaceId)
          ? useAppStore.getState().refreshScratchTopics(workspaceId, true)
          : Promise.resolve()
      ])
    },
    [refreshGitStatus, tree.refreshTree, workspaceId]
  )

  function setExpanded(update: SetStateAction<Set<string>>): void {
    if (!workspaceId) return
    updateExplorerState(workspaceId, (current) => ({
      ...current,
      expandedPaths: new Set([
        ...[...current.expandedPaths].filter(path => !fileExplorerContains(rootPath, path)),
        ...[...(typeof update === 'function' ? update(new Set([...current.expandedPaths].filter(path => fileExplorerContains(rootPath, path)))) : update)].filter(path => fileExplorerContains(rootPath, path))
      ])
    }))
  }

  function setSelection(update: SetStateAction<FileExplorerSelectionState>, cancelPendingReveal = true): void {
    if (cancelPendingReveal) fileRevealRef.current?.abort()
    if (!workspaceId) return
    updateExplorerState(workspaceId, (current) => ({
      ...current,
      selection: typeof update === 'function' ? update(updateFileExplorerSelectionPaths(current.selection, path => fileExplorerContains(rootPath, path) ? path : null)) : update
    }))
  }

  useEffect(() => {
    clearHoverExpand()
    observedFileRevisionRef.current = workspaceFileRevision
    setActiveDrag(null)
    dragVisibilityRef.current = null
    activeDragScopeRef.current = null
    setDeleteRequest(null)
    lastRevealedPathRef.current = null
    lastRevealRequestIdRef.current = null
    setScrollTarget(null)
    setFocusedPath(null)
    setMenuPath(null)
    setInlineEdit(null)
    setEditError(null)
    setEditPending(false)
    editSubmissionRef.current = null
    setQuery('')
    return () => clearHoverExpand()
  }, [workspaceId, workspacePath, rootPath])

  useEffect(() => {
    if (!active || observedFileRevisionRef.current === workspaceFileRevision || tree.rootCache?.loading) return
    observedFileRevisionRef.current = workspaceFileRevision
    if (tree.rootCache) void refreshExplorer(false)
  }, [active, refreshExplorer, workspaceFileRevision, tree.rootCache?.loading])

  // Expand each relative Workspace ancestor without replacing an existing
  // multi-selection, then scroll after async reads project the target row.
  useEffect(() => {
    if (!active || !activePath || activePath === lastRevealedPathRef.current) return
    lastRevealedPathRef.current = activePath
    const nextExplorerState = revealFileExplorerPath(explorerState, activePath)
    if (workspaceId && nextExplorerState !== explorerState) {
      updateExplorerState(workspaceId, (current) => revealFileExplorerPath(current, activePath))
    }
    autoRevealRequestIdRef.current += 1
    setScrollTarget({
      path: activePath,
      requestId: autoRevealRequestIdRef.current,
      focus: false
    })
  }, [active, activePath, explorerState, updateExplorerState, workspaceId])

  useEffect(() => {
    if (
      !active || !revealRequest ||
      revealRequest.workspaceId !== workspaceId ||
      !fileExplorerContains(rootPath, revealRequest.path) ||
      revealRequest.requestId === lastRevealRequestIdRef.current
    ) return
    lastRevealRequestIdRef.current = revealRequest.requestId
    setQuery('')
    setExpanded((current) => {
      const next = new Set(current)
      for (const path of getRevealAncestorPaths(revealRequest.path)) next.add(path)
      next.add(revealRequest.path)
      return next
    })
    setSelection(createSingleFileExplorerSelection(revealRequest.path))
    setScrollTarget({
      path: revealRequest.path,
      requestId: revealRequest.requestId,
      focus: true
    })
  }, [active, revealRequest, workspaceId, rootPath])

  // Continuous filesystem watch would need a cross-host owner. Until the mux
  // decision, refresh on application focus through the same Local/SSH IPC
  // instead of introducing a local-only watcher with conflicting semantics.
  // 重获焦点这条路尤其要连 git 一起刷：用户切到终端里跑了 agent 或 git 命令，回到 AgentMux 时
  // 期待看到的正是"哪些文件被改了"，而那是 git 那半边的事。
  useEffect(() => {
    if (!active) return
    const refreshOnFocus = () => void refreshExplorer()
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [active, refreshExplorer])

  const rows = useMemo(
    () => flattenFileTree(tree.rootCache?.children ?? [], tree.dirCache, expanded),
    [expanded, tree.dirCache, tree.rootCache?.children]
  )
  const editPath = inlineEdit?.kind === 'rename' ? inlineEdit.node.path : inlineEdit?.parentPath
  const retainedPaths = useMemo(() => [editPath, menuPath, focusedPath, activeDrag?.path, scrollTarget?.path],
    [editPath, menuPath, focusedPath, activeDrag?.path, scrollTarget?.path])
  // Visibility changes in another consumer wait for the original pointer move to settle.
  const dragVisibility = activeDrag ? dragVisibilityRef.current : null
  const visibleRows = useMemo(() => projectFileExplorerRows(rows, dragVisibility?.showHidden ?? showHidden,
    dragVisibility?.showIgnored ?? showIgnored, dragVisibility?.query ?? query, retainedPaths),
  [dragVisibility, query, retainedPaths, rows, showHidden, showIgnored])
  const rowProjection = useMemo(
    () => createFileExplorerRowProjection(visibleRows),
    [visibleRows]
  )
  const viewport = useFileTreeViewport(rowProjection, treeRootRef, retainedPaths,
    `${workspaceId}\0${workspacePath}\0${rootPath}`)
  useEffect(() => {
    if (!active || !scrollTarget || !rowProjection.hasPath(scrollTarget.path)) return
    viewport.scrollToPath(scrollTarget.path)
    if (!scrollTarget.focus) return
    const frame = requestAnimationFrame(() => {
      const row = treeRootRef.current?.querySelector<HTMLElement>(
        `[data-tree-path="${CSS.escape(scrollTarget.path)}"]`
      )
      row?.focus({ preventScroll: true })
      if (row && scrollTarget.openMenu) {
        const rect = row.getBoundingClientRect()
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left, clientY: rect.top }))
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [active, scrollTarget, rowProjection, viewport.scrollToPath])
  useEffect(() => {
    if (active && editPath !== undefined) viewport.scrollToPath(editPath)
  }, [active, editPath, viewport.scrollToPath])
  const selectedNode = selectedPath ? rowProjection.getRowByPath(selectedPath) : null
  const createParent = selectedNode?.isDirectory
    ? selectedNode.path
    : selectedNode ? workspacePathParent(selectedNode.path) : rootPath
  const loadedTreeNodes = useMemo(
    () => Object.values(tree.dirCache).flatMap((entry) => entry.children),
    [tree.dirCache]
  )

  const moveIndex = useMemo(() => createFileExplorerMoveIndex(
    rootPath ? [{ path: rootPath, isDirectory: true }, ...loadedTreeNodes] : loadedTreeNodes
  ), [loadedTreeNodes, rootPath])

  function clearHoverExpand(): void {
    const pending = hoverExpandRef.current
    if (pending) window.clearTimeout(pending.timer)
    hoverExpandRef.current = null
  }

  function isMoveDropDisabled(directoryPath: string): boolean {
    return !fileExplorerContains(rootPath, directoryPath) || (activeDrag !== null &&
      planFileExplorerMove(moveIndex, activeDrag.path, directoryPath).status === 'blocked')
  }

  async function movePath(sourcePath: string, destinationPath: string): Promise<void> {
    if (!fileExplorerContains(rootPath, sourcePath) || !fileExplorerContains(rootPath, destinationPath)) return
    await runFileExplorerMove({
      sourcePath,
      destinationPath,
      move: (source, destination) => renamePath(source, destination, workspaceId ?? undefined),
      refreshDirectory: tree.refreshDir
    })
  }

  async function movePathToDirectory(sourcePath: string, directoryPath: string): Promise<void> {
    const plan = planFileExplorerMove(moveIndex, sourcePath, directoryPath)
    if (plan.status === 'blocked') return
    await movePath(plan.sourcePath, plan.destinationPath)
  }

  function handleDragStart(event: DragStartEvent): void {
    const data = event.active.data.current as FileExplorerDragData | undefined
    if (data?.kind === 'file-explorer-path' && fileExplorerContains(rootPath, data.path)) {
      activeDragScopeRef.current = { workspaceId, rootPath }
      dragVisibilityRef.current = { showHidden, showIgnored, query }
      setSelection(createSingleFileExplorerSelection(data.path))
      setActiveDrag(data)
    }
  }

  function handleDragOver(event: DragOverEvent): void {
    const drag = event.active.data.current as FileExplorerDragData | undefined
    const data = event.over?.data.current as FileExplorerDropData | undefined
    const directoryPath = data?.kind === 'file-explorer-directory' ? data.directoryPath : null
    if (
      drag?.kind !== 'file-explorer-path' ||
      activeDragScopeRef.current?.workspaceId !== workspaceId || activeDragScopeRef.current.rootPath !== rootPath ||
      directoryPath === null || !fileExplorerContains(rootPath, directoryPath) ||
      planFileExplorerMove(moveIndex, drag.path, directoryPath).status === 'blocked' ||
      !directoryPath ||
      expanded.has(directoryPath)
    ) {
      clearHoverExpand()
      return
    }
    if (hoverExpandRef.current?.path === directoryPath) return
    clearHoverExpand()
    hoverExpandRef.current = {
      path: directoryPath,
      timer: window.setTimeout(() => {
        setExpanded((current) => new Set(current).add(directoryPath))
        hoverExpandRef.current = null
      }, 500)
    }
  }

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    const drag = event.active.data.current as FileExplorerDragData | undefined
    const drop = event.over?.data.current as FileExplorerDropData | undefined
    const scope = activeDragScopeRef.current
    activeDragScopeRef.current = null
    clearHoverExpand()
    setActiveDrag(null)
    dragVisibilityRef.current = null
    if (drag?.kind !== 'file-explorer-path' || drop?.kind !== 'file-explorer-directory' || scope?.workspaceId !== workspaceId || scope.rootPath !== rootPath) return
    try {
      await movePathToDirectory(drag.path, drop.directoryPath)
    } catch {
      // renamePath already projects the typed failure through the app error owner.
    }
  }

  function toggle(node: TreeNode): void {
    if (!node.isDirectory) return
    fileRevealRef.current?.abort()
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      return next
    })
  }

  function collapseAll(): void {
    fileRevealRef.current?.abort()
    clearHoverExpand()
    lastRevealedPathRef.current = activePath ?? null
    setScrollTarget(null)
    const retained = new Set<string>()
    // An active edit/menu/move must keep its original row and parent available.
    for (const path of [editPath, menuPath, activeDrag?.path]) {
      if (path === null || path === undefined) continue
      for (const ancestor of getRevealAncestorPaths(path)) retained.add(ancestor)
      if (path === editPath && inlineEdit?.kind !== 'rename') retained.add(path)
    }
    if (activeDrag) for (const path of expanded) retained.add(path)
    if (focusedPath && getRevealAncestorPaths(focusedPath).some(path => expanded.has(path) && !retained.has(path))) {
      treeRootRef.current?.focus({ preventScroll: true })
      setFocusedPath(null)
    }
    setExpanded(current => new Set([...current].filter(path => retained.has(path))))
  }

  function beginCreate(kind: 'create-file' | 'create-directory', targetParent = createParent): void {
    fileRevealRef.current?.abort()
    if (!workspaceId || editSubmissionRef.current) return
    fileRevealRef.current = new AbortController()
    setExpanded((current) => new Set(current).add(targetParent))
    setInlineEdit({ id: ++editIntent.current, kind, parentPath: targetParent, workspaceId, workspacePath, rootPath })
    setEditValue('')
    setEditError(null)
  }

  useEffect(() => {
    if (active && createRequest && fileExplorerContains(rootPath, createRequest.parentPath)) {
      beginCreate('create-file', createRequest.parentPath); onCreateRequestHandled?.()
    }
  }, [active, createRequest, workspaceId, rootPath])

  function pathsForContext(node: TreeNode): string[] {
    return selection.selectedPaths.has(node.path)
      ? [...selection.selectedPaths].filter(path => fileExplorerContains(rootPath, path))
      : [node.path]
  }

  function filePathTitle(node: TreeNode): string {
    if (!workspace) return ''
    const physical = scratchWorkspaceFilePath(workspace, scratchTopics, node.path)
    return [physical === null ? '' : displayPath(physical, workspace.hostId),
      node.isSymlink && node.linkTarget ? `→ ${displayPath(node.linkTarget, workspace.hostId)}` : ''
    ].filter(Boolean).join(' ')
  }

  function physicalFilePath(path: string): string | null {
    if (!workspace) return null
    const absolute = scratchWorkspaceFilePath(workspace,
      scratchTopicsForWorkspace(useAppStore.getState().scratchTopicSnapshots, workspace), path)
    if (absolute === null) reportError(new Error('The original directory read is not confirmed. Refresh Files and retry this operation.'))
    return absolute
  }

  async function copyContextPaths(node: TreeNode, kind: 'absolute' | 'relative'): Promise<void> {
    if (!workspace) return
    const paths = pathsForContext(node)
    const absolutePaths = kind === 'absolute' ? paths.map(physicalFilePath) : null
    if (absolutePaths?.some(path => path === null)) return
    // 缩写只对本机绝对路径做：相对路径不含 home，远程主机的路径套本机 home 会指向对面不存在的地方。
    const text = absolutePaths
      ? absolutePaths.map(path => displayPath(path!, workspace.hostId)).join('\n')
      : formatPathsForCopy(paths, kind, workspace.path)
    await copyTextToClipboard(text, reportError)
  }

  async function openDirectoryInTerminal(node: TreeNode): Promise<void> {
    if (!node.isDirectory) return
    if (onOpenTerminal) { await onOpenTerminal(node.path); return }
    if (!workspace || !activePaneId) return
    const path = physicalFilePath(node.path)
    if (path === null) return
    await launchTerminal(activePaneId, undefined, path)
  }

  async function openDirectoryAsProject(node: TreeNode): Promise<void> {
    if (!workspace || !node.isDirectory) return
    try {
      const projectInput = createDirectoryProjectInput({
        workspace,
        relativePath: node.path,
        name: node.name,
        isDirectory: node.isDirectory
      })
      if (!projectInput) return
      const path = physicalFilePath(node.path)
      if (path === null) return
      // Main resolves duplicates atomically and publishes before replying; do not replay a get snapshot.
      const created = await api.workspaces.add({ ...projectInput, path })
      await useAppStore.getState().selectWorkspace(created.id)
    } catch (error) {
      reportError(error)
    }
  }

  async function rebindWorkspacePath(): Promise<void> {
    if (
      !workspaceId ||
      !workspace ||
      workspace.hostId !== 'local' ||
      !isFolderWorkspace(workspace) ||
      relinking
    ) return
    setRelinking(true)
    try {
      const updated = await api.workspaces.rebindLocalFolder(workspaceId)
      if (!updated) return
      const current = useAppStore.getState().config
      if (!current) return
      setConfig(applyWorkspacePathRebind(current, updated))
      await refreshExplorer()
    } catch (error) {
      reportError(error)
    } finally {
      setRelinking(false)
    }
  }

  async function revealLocalPath(node: TreeNode): Promise<void> {
    if (!workspaceId || workspace?.hostId !== 'local') return
    try {
      await api.files.reveal(workspaceId, node.path)
    } catch (error) {
      reportError(error)
    }
  }

  function beginRename(node: TreeNode): void {
    fileRevealRef.current?.abort()
    if (!workspaceId || editSubmissionRef.current || !canRenameFileExplorerNode(workspaceId, node)) return
    setSelection(createSingleFileExplorerSelection(node.path))
    setInlineEdit({ id: ++editIntent.current, kind: 'rename', node, workspaceId, workspacePath, rootPath })
    setEditValue(node.name)
    setEditError(null)
  }

  async function commitEdit(value = editValue): Promise<void> {
    const edit = inlineEdit
    const name = value.trim()
    if (!edit || editSubmissionRef.current || edit.workspaceId !== workspaceId || edit.workspacePath !== workspacePath || edit.rootPath !== rootPath) return
    if (!validName(name)) { setEditError('Enter a name without / or \\; . and .. are not file names.'); return }
    editSubmissionRef.current = edit
    const navigation = fileNavigationSelection(useAppStore.getState())
    const navigationIntent = fileRevealRef.current
    const navigationSignal = navigationIntent?.signal
    const releaseNavigation = edit.kind === 'create-file' ? useAppStore.subscribe(state => {
      if (fileNavigationSelection(state) !== navigation) navigationIntent?.abort()
    }) : () => {}
    setEditPending(true)
    setEditError(null)
    try {
      if (edit.kind === 'rename') {
        const nextPath = joinPath(workspacePathParent(edit.node.path), name)
        if (nextPath !== edit.node.path) await movePath(edit.node.path, nextPath)
      } else {
        const path = joinPath(edit.parentPath, name)
        // createPath 返回它**实际建在**哪个 Workspace。下面几个 await 之间侧栏完全可点，
        // 若让 openFile 自己再解析一次活动 Workspace，用户切了项目就会打开另一个项目里的
        // 同名文件——症状不是报错而是静默开错文件（index.ts / README.md 这类名字很容易撞）。
        const createdIn = await createPath({
          path,
          kind: edit.kind === 'create-file' ? 'file' : 'directory'
        }, edit.workspaceId)
        await tree.refreshDir(edit.parentPath)
        if (editSubmissionRef.current === edit && editContextRef.current.workspaceId === edit.workspaceId && editContextRef.current.workspacePath === edit.workspacePath && editContextRef.current.rootPath === edit.rootPath) {
          setSelection(createSingleFileExplorerSelection(path), false)
          if (edit.kind === 'create-file' && !navigationSignal?.aborted && fileNavigationSelection(useAppStore.getState()) === navigation) await openFile(path, undefined, undefined, createdIn)
        }
      }
      setInlineEdit(current => current === edit ? null : current)
    } catch (error) {
      // The file owner reports transaction failure. Keep only this scope's draft retryable.
      if (editSubmissionRef.current === edit && editContextRef.current.workspaceId === edit.workspaceId && editContextRef.current.workspacePath === edit.workspacePath && editContextRef.current.rootPath === edit.rootPath) setEditError(presentError(error))
    } finally {
      releaseNavigation()
      if (editSubmissionRef.current === edit) {
        editSubmissionRef.current = null
        setEditPending(false)
      }
    }
  }

  async function confirmDelete(): Promise<void> {
    const request = deleteRequest
    if (!request || deleting || request.workspaceId !== workspaceId || request.rootPath !== rootPath) return
    const node = request.node
    setDeleting(true)
    try {
      await deletePath(node.path, request.workspaceId)
      await tree.refreshDir(workspacePathParent(node.path))
      setDeleteRequest(current => current === request ? null : current)
    } finally {
      setDeleting(false)
    }
  }

  function handleTreeKeyDown(event: React.KeyboardEvent): void {
    if (inlineEdit || visibleRows.length === 0) return
    const focusedRow = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '[data-tree-index]'
    )
    const focusedIndex = focusedRow?.dataset.treeIndex
      ? Number(focusedRow.dataset.treeIndex)
      : null
    const selectedIndex = selectedPath ? rowProjection.getIndexByPath(selectedPath) : null
    const currentIndex = Number.isInteger(focusedIndex) ? focusedIndex : selectedIndex

    if (
      isNavigationKey(event.key) &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const resolved = resolveFileExplorerNavigationTarget({
        key: event.key,
        currentIndex,
        rowProjection,
        total: rowProjection.getVisibleCount(),
        isExpanded: (path) => expanded.has(path)
      })
      if (resolved.type === 'toggle-expand' || resolved.type === 'toggle-collapse') {
        const node = rowProjection.getRowAtIndex(resolved.currentIndex)
        if (node) {
          event.preventDefault()
          event.stopPropagation()
          toggle(node)
        }
        return
      }
      if (resolved.type === 'move') {
        const node = rowProjection.getRowAtIndex(resolved.targetIndex)
        if (!node) return
        event.preventDefault()
        event.stopPropagation()
        setSelection((current) => updateFileExplorerSelection(
          current,
          rowProjection.getOrderedPaths(),
          node.path,
          event.shiftKey && currentIndex !== null ? 'range' : 'replace'
        ))
        setScrollTarget({ path: node.path, requestId: ++autoRevealRequestIdRef.current, focus: true })
        return
      }
    }

    const actionNode = currentIndex === null
      ? selectedNode
      : rowProjection.getRowAtIndex(currentIndex)
    if (isFileExplorerMenuKey(event) && actionNode) {
      event.preventDefault()
      setScrollTarget({ path: actionNode.path, requestId: ++autoRevealRequestIdRef.current, focus: true, openMenu: true })
    } else if ((event.key === 'Enter' || event.key === ' ') && actionNode) {
      event.preventDefault()
      actionNode.isDirectory ? toggle(actionNode) : void openFile(actionNode.path)
    } else if (FILE_EXPLORER_RENAME_KEY.matches(event) && actionNode) {
      event.preventDefault()
      if (workspaceId && canRenameFileExplorerNode(workspaceId, actionNode)) beginRename(actionNode)
    } else if (FILE_EXPLORER_DELETE_KEY.matches(event) && actionNode) {
      event.preventDefault()
      if (workspaceId) setDeleteRequest({ node: actionNode, workspaceId, rootPath })
    }
  }

  if (!workspaceId) return null
  const createEdit = inlineEdit?.kind === 'create-file' || inlineEdit?.kind === 'create-directory'
    ? inlineEdit
    : null
  const createRow = createEdit ? (
    <div className="tree-create-row" style={{ '--tree-depth': (createEdit.parentPath ? createEdit.parentPath.split('/').length : 0) - (rootPath ? rootPath.split('/').length : 0) } as React.CSSProperties}>
      {createEdit.kind === 'create-directory' ? <Folder size={14} /> : <FilePlus2 size={13} />}
      <InlineRenameField inputClassName="tree-inline-input" key={createEdit.id}
        label={createEdit.kind === 'create-directory' ? 'New folder name' : 'New file name'}
        error={editError}
        pending={editPending}
        value={editValue}
        placeholder={createEdit.kind === 'create-directory' ? 'folder name' : 'file name'}
        onValueChange={value => { setEditValue(value); setEditError(null) }}
        onCommit={commitEdit}
        onCancel={() => { setInlineEdit(null); setEditError(null) }}
      />
    </div>
  ) : null
  const toolbar = <div className="explorer-header__actions" role="group" aria-label="File actions">
    <button onClick={() => beginCreate('create-file')} title="New file"><FilePlus2 size={13} /></button>
    <button onClick={() => beginCreate('create-directory')} title="New folder"><FolderPlus size={13} /></button>
    <button onClick={() => void refreshExplorer()} title="Refresh explorer">
      {tree.rootCache?.loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
    </button>
    <button onClick={collapseAll} title="Collapse all folders" aria-label="Collapse all folders"><ChevronsDownUp size={13} /></button>
    <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" aria-label="Explorer options" title="Explorer options"><MoreHorizontal size={13} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu file-options-menu" align="end" sideOffset={6} collisionPadding={8}>
        <DropdownMenu.CheckboxItem className="tab-context-menu__item" checked={showHidden} onSelect={event => event.preventDefault()} onCheckedChange={() => toggleShowHidden()}><Eye size={13} /><span>Show hidden files</span><DropdownMenu.ItemIndicator className="file-menu-check"><Check size={12} /></DropdownMenu.ItemIndicator></DropdownMenu.CheckboxItem>
        <DropdownMenu.CheckboxItem className="tab-context-menu__item" checked={showIgnored} onSelect={event => event.preventDefault()} onCheckedChange={() => toggleShowIgnored()}><GitBranch size={13} /><span>Show Git ignored files</span><DropdownMenu.ItemIndicator className="file-menu-check"><Check size={12} /></DropdownMenu.ItemIndicator></DropdownMenu.CheckboxItem>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>
  return (
    <section className={`file-explorer ${toolbarTarget !== undefined ? 'file-explorer--shared-header' : ''}`} data-file-workspace={workspaceId} data-file-root={rootPath}>
      {toolbarTarget !== undefined
        ? toolbarTarget ? createPortal(toolbar, toolbarTarget) : null
        : <div className="explorer-header"><span>Explorer</span>{toolbar}</div>}
      <label className="file-search">
        <Search size={13} />
        <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find loaded files" />
        {query ? <button onClick={() => setQuery('')} title="Clear"><X size={11} /></button> : null}
      </label>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        autoScroll
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragCancel={() => { clearHoverExpand(); setActiveDrag(null); dragVisibilityRef.current = null }}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        {new URLSearchParams(window.location.search).get('agentmux-file-editing-report') === '1'
          ? <FileExplorerCancelTraceObserver workspaceId={workspaceId} /> : null}
        <div
          className="file-tree"
          ref={treeRootRef}
          role="tree"
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
          onFocusCapture={event => setFocusedPath((event.target as HTMLElement).closest<HTMLElement>('[data-tree-path]')?.dataset.treePath ?? null)}
          onBlurCapture={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedPath(null)
          }}
        >
          <div className="file-tree__prefix" ref={viewport.prefixRef}>
            <FileExplorerRootDropTarget disabled={isMoveDropDisabled(rootPath)} rootPath={rootPath} rootLabel={rootLabel} />
            {createEdit?.parentPath === rootPath ? createRow : null}
          </div>
          <div className="file-tree__rows" ref={viewport.rowsRef} style={{ height: viewport.virtualizer.getTotalSize() }}>
          {viewport.virtualizer.getVirtualItems().map(item => {
            const node = rowProjection.getRowAtIndex(item.index)!
            const rowIndex = item.index
            return <div className="file-tree__virtual-row" key={node.path} data-index={rowIndex}
              ref={viewport.virtualizer.measureElement}
              style={{ transform: `translateY(${item.start - viewport.scrollMargin}px)` }}>
              <FileTreeRow
            key={node.path}
            node={node}
            rowIndex={rowIndex}
            expanded={expanded.has(node.path)}
            // 判据来自 presentExpandedDir 那一处纯函数，不在这里重新读一遍 error：只有它知道
            // 「刷新失败但留着旧内容」也算失败，而按 children 是否为空判会把那种情况画成正常。
            loadFailure={
              node.isDirectory && expanded.has(node.path) &&
              presentExpandedDir(tree.dirCache[node.path]) === 'failed'
                ? tree.dirCache[node.path]?.error ?? null
                : null
            }
            selected={selection.selectedPaths.has(node.path) || activePath === node.path}
            dirty={Boolean(workspaceId && dirtyDocuments[documentKey(workspaceId, node.path)])}
            gitStatus={gitStatusIndex.get(node.path, node.isDirectory)}
            editing={inlineEdit?.kind === 'rename' && inlineEdit.node.path === node.path}
            editId={inlineEdit?.id}
            editPending={editPending}
            editError={editError}
            pathTitle={filePathTitle(node)}
            editValue={editValue}
            onEditValue={(value) => { setEditValue(value); setEditError(null) }}
            onCommitEdit={commitEdit}
            onCancelEdit={() => { setInlineEdit(null); setEditError(null) }}
            onContextMenuChange={open => {
              if (open) fileRevealRef.current?.abort()
              setMenuPath(current => open ? node.path : current === node.path ? null : current)
              if (open && !selection.selectedPaths.has(node.path)) {
                setSelection(createSingleFileExplorerSelection(node.path))
              }
            }}
            onSelect={(event) => {
              const mode = getFileExplorerSelectionMode(event, isMac)
              setSelection(current => updateFileExplorerSelection(current, rowProjection.getOrderedPaths(), node.path, mode))
            }}
            onCreate={(kind) => beginCreate(
              kind === 'file' ? 'create-file' : 'create-directory',
              node.isDirectory ? node.path : workspacePathParent(node.path)
            )}
            onCopyPaths={(kind) => void copyContextPaths(node, kind)}
      onOpenTerminal={() => void openDirectoryInTerminal(node).catch(() => {})}
            onOpenAsProject={() => void openDirectoryAsProject(node)}
            onViewFile={() => {
              if (!node.isDirectory && !node.linkIssue) void openFile(node.path)
            }}
            onMove={(directoryPath) => {
              setSelection(createSingleFileExplorerSelection(node.path))
              void movePathToDirectory(node.path, directoryPath).catch(() => {})
            }}
            getMoveTargets={() => canRenameFileExplorerNode(workspaceId, node)
              ? fileExplorerMoveTargets(moveIndex, node.path).filter(target => fileExplorerContains(rootPath, target.path)).map(target => target.path === rootPath ? { ...target, label: rootLabel } : target)
              : []}
            onCollapse={() => setExpanded((current) => {
              const next = new Set(current)
              next.delete(node.path)
              return next
            })}
            onReveal={() => void revealLocalPath(node)}
            onClick={(event) => {
              const mode = getFileExplorerSelectionMode(event, isMac)
              setSelection((current) => updateFileExplorerSelection(
                current,
                rowProjection.getOrderedPaths(),
                node.path,
                mode
              ))
              // Range/toggle clicks change selection only; activation belongs
              // to a plain replacement click.
              if (mode === 'replace') {
                if (node.isDirectory) toggle(node)
                else if (!node.linkIssue) void openFile(node.path)
              }
            }}
            onToggle={() => toggle(node)}
            onRename={() => beginRename(node)}
            onDelete={() => setDeleteRequest({ node, workspaceId, rootPath })}
            canOpenTerminal={workspace?.hostId === 'local'}
            canMove={canRenameFileExplorerNode(workspaceId, node)}
            dropDisabled={isMoveDropDisabled(fileExplorerDropDirectory(node))}
            canRename={canRenameFileExplorerNode(workspaceId, node)}
            isLocal={workspace?.hostId === 'local'}
            selectionSize={pathsForContext(node).length}
              />
              {createEdit?.parentPath === node.path ? createRow : null}
            </div>
          })}
          </div>
          {tree.rootError ? (
            <div className="tree-empty tree-empty--error">
              <strong>Could not read workspace</strong>
              <span>{tree.rootError}</span>
              <div className="tree-empty__actions">
                <button className="small-button" onClick={() => void refreshExplorer()}>Retry</button>
                {workspace?.hostId === 'local' && isFolderWorkspace(workspace) ? (
                  <button className="small-button" disabled={relinking} onClick={() => void rebindWorkspacePath()}>
                    {relinking ? <LoaderCircle className="spin" size={12} /> : <FolderOpen size={12} />}
                    {relinking ? 'Choosing…' : 'Choose new folder'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : !tree.rootCache?.loading && visibleRows.length === 0 ? (
            <div className="tree-empty"><strong>{query ? 'No loaded files match' : rows.length ? 'No visible files' : rootPath ? 'This directory is empty' : 'Workspace is empty'}</strong><span>{query ? 'Expand more folders or change the search.' : rows.length ? 'Change file visibility in Explorer options.' : 'Create a file or folder to begin.'}</span></div>
          ) : null}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeDrag ? (
            <div className="file-tree-drag-preview"><GripVertical size={12} /><span>{activeDrag.name}</span></div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <ConfirmationDialog
        open={deleteRequest !== null}
        title={`Delete ${deleteRequest?.node.isDirectory ? 'folder' : 'file'}?`}
        description={
          workspace?.hostId === 'local'
            ? 'AgentMux will permanently remove this path. This cannot be undone.'
            : 'AgentMux will permanently remove this path from the remote host. This cannot be undone.'
        }
        {...(deleteRequest ? { subject: deleteRequest.node.path } : {})}
        confirmLabel="Delete"
        busy={deleting}
        onCancel={() => {
          if (!deleting) setDeleteRequest(null)
        }}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  )
}
