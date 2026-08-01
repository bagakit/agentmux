import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { scratchTopicIdFromDirectoryName } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { applyWorkspacePathRebind } from '../lib/workspace-path-recovery'
import { getFileTypeIcon } from '../lib/file-type-icons'
import { documentKey } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'
import {
  isNavigationKey,
  resolveFileExplorerNavigationTarget
} from './file-tree/file-explorer-keyboard-navigation'
import {
  getRevealAncestorPaths,
  joinWorkspacePath
} from '../lib/workspace-paths'
import { copyTextToClipboard, formatPathsForCopy } from '../lib/clipboard-copy'
import { createFileExplorerRowProjection } from './file-tree/file-explorer-row-projection'
import {
  createSingleFileExplorerSelection,
  createEmptyFileExplorerViewState,
  getFileExplorerSelectionMode,
  revealFileExplorerPath,
  updateFileExplorerSelection,
  type FileExplorerSelectionState
} from '../lib/file-explorer-selection'
import {
  flattenFileTree,
  useWorkspaceFileTree,
  type TreeNode
} from './file-tree/useWorkspaceFileTree'
import { observeRejectedFileExplorerDirectoryLoads } from './file-tree/file-explorer-report-probe'
import { FileTreeContextMenu } from './file-tree/FileTreeContextMenu'
import {
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

type InlineEdit =
  | { kind: 'create-file' | 'create-directory'; parentPath: string }
  | { kind: 'rename'; node: TreeNode }

const EMPTY_EXPLORER_STATE = createEmptyFileExplorerViewState()

type FileExplorerDragData = { kind: 'file-explorer-path'; path: string; name: string }
type FileExplorerDropData = { kind: 'file-explorer-directory'; directoryPath: string }

export type FileExplorerRevealRequest = {
  workspaceId: string
  path: string
  requestId: number
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
  selected,
  dirty,
  editing,
  editValue,
  onEditValue,
  onCommitEdit,
  onCancelEdit,
  onClick,
  onCollapse,
  onContextMenuOpen,
  onCopyPaths,
  onCreate,
  onToggle,
  onOpenTerminal,
  onRename,
  onDelete,
  onReveal,
  onViewFile,
  onMove,
  moveTargets,
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
  selected: boolean
  dirty: boolean
  editing: boolean
  editValue: string
  onEditValue: (value: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onClick: (event: React.MouseEvent) => void
  onCollapse: () => void
  onContextMenuOpen: () => void
  onCopyPaths: (kind: 'absolute' | 'relative') => void
  onCreate: (kind: 'file' | 'directory') => void
  onToggle: () => void
  onOpenTerminal: () => void
  onRename: () => void
  onDelete: () => void
  onReveal: () => void
  onViewFile: () => void
  onMove: (directoryPath: string) => void
  moveTargets: readonly FileExplorerMoveTarget[]
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
      moveTargets={moveTargets}
      onOpenChange={(open) => {
        if (open) onContextMenuOpen()
      }}
      onCreate={onCreate}
      onCopyPaths={onCopyPaths}
      onOpenTerminal={onOpenTerminal}
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
        className={`tree-row ${selected ? 'tree-row--selected' : ''} ${isDragging ? 'tree-row--dragging' : ''} ${isOver ? 'tree-row--drop-over' : ''}`}
        style={{ '--tree-depth': node.depth } as React.CSSProperties}
        data-tree-path={node.path}
        data-tree-index={rowIndex}
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
        <span className="tree-row__icon">
          {node.isDirectory
            ? expanded ? <FolderOpen size={14} /> : <Folder size={14} />
            : <FileIcon size={13} />}
        </span>
        {editing ? (
          <input
            autoFocus
            className="tree-inline-input"
            value={editValue}
            onChange={(event) => onEditValue(event.target.value)}
            onBlur={onCommitEdit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onCommitEdit()
              if (event.key === 'Escape') onCancelEdit()
            }}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <button
            type="button"
            className="tree-row__label"
            tabIndex={-1}
          >
            {node.name}
          </button>
        )}
        {dirty ? <i className="tree-row__dirty" aria-label="Unsaved changes" /> : null}
        {node.isSymlink ? <span className="tree-row__badge">link</span> : null}
        {!editing ? (
          <span className="tree-row__actions">
            {canRename ? <button type="button" title={`Rename ${node.name}`} onClick={(event) => { event.stopPropagation(); onRename() }}><Pencil size={11} /></button> : null}
            <button type="button" title={`Delete ${node.name}`} onClick={(event) => { event.stopPropagation(); onDelete() }}><Trash2 size={11} /></button>
          </span>
        ) : null}
      </div>
    </FileTreeContextMenu>
  )
}

function FileExplorerRootDropTarget({ disabled }: { disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'file-explorer-target:workspace-root',
    data: { kind: 'file-explorer-directory', directoryPath: '' } satisfies FileExplorerDropData,
    disabled
  })
  return (
    <div
      ref={setNodeRef}
      className={`file-tree-root-target ${isOver ? 'file-tree-root-target--over' : ''}`}
      data-move-drop-disabled={disabled ? 'true' : 'false'}
    >
      <FolderOpen size={12} /><span>Workspace Root</span>
    </div>
  )
}

export function FileExplorer({
  revealRequest
}: {
  revealRequest?: FileExplorerRevealRequest | undefined
}) {
  const workspaceId = useAppStore((state) => state.activeWorkspaceId)
  const workspace = useAppStore((state) =>
    state.config?.workspaces.find((item) => item.id === state.activeWorkspaceId)
  )
  const activePath = useAppStore((state) =>
    workspaceId ? state.lastActiveFileByWorkspace[workspaceId] : undefined
  )
  const openFile = useAppStore((state) => state.openFile)
  const createPath = useAppStore((state) => state.createPath)
  const renamePath = useAppStore((state) => state.renamePath)
  const deletePath = useAppStore((state) => state.deletePath)
  const launchTerminal = useAppStore((state) => state.launchTerminal)
  const reportError = useAppStore((state) => state.reportError)
  const setConfig = useAppStore((state) => state.setConfig)
  const activePaneId = useAppStore((state) => (
    state.activeWorkspaceId ? state.layouts[state.activeWorkspaceId]?.activeGroupId : undefined
  ))
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  const workspaceFileRevision = useAppStore((state) => (
    workspaceId ? (state.workspaceFileRevisions[workspaceId] ?? 0) : 0
  ))
  const explorerState = useAppStore((state) => (
    workspaceId ? state.fileExplorerStates[workspaceId] : undefined
  )) ?? EMPTY_EXPLORER_STATE
  const updateExplorerState = useAppStore((state) => state.updateFileExplorerState)
  const [query, setQuery] = useState('')
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null)
  const [editValue, setEditValue] = useState('')
  const [deleteRequest, setDeleteRequest] = useState<TreeNode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [relinking, setRelinking] = useState(false)
  const [activeDrag, setActiveDrag] = useState<FileExplorerDragData | null>(null)
  const [scrollTarget, setScrollTarget] = useState<{
    path: string
    requestId: number
    focus: boolean
  } | null>(null)
  const treeRootRef = useRef<HTMLDivElement>(null)
  const lastRevealedPathRef = useRef<string | null>(null)
  const lastRevealRequestIdRef = useRef<number | null>(null)
  const autoRevealRequestIdRef = useRef(0)
  const observedFileRevisionRef = useRef(workspaceFileRevision)
  const expanded = explorerState.expandedPaths
  const selection = explorerState.selection
  const selectedPath = selection.activePath
  const tree = useWorkspaceFileTree(workspaceId ?? 'missing-workspace', expanded)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const hoverExpandRef = useRef<{ path: string; timer: number } | null>(null)

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('agentmux-file-editing-report') !== '1') {
      return
    }
    let total = 0
    let byWorkspace: Record<string, number> = {}
    let rejectedDirectoryLoads: Array<{ workspaceId: string; path: string }> = []
    const publish = () => {
      if (!treeRootRef.current) return
      treeRootRef.current.dataset.fileEditingExplorerEvidence = JSON.stringify({
        total,
        byWorkspace,
        rejectedDirectoryLoads
      })
    }
    const unsubscribeStore = useAppStore.subscribe((state, previous) => {
      if (state.fileExplorerStates === previous.fileExplorerStates) return
      total += 1
      for (const id of new Set([
        ...Object.keys(state.fileExplorerStates),
        ...Object.keys(previous.fileExplorerStates)
      ])) {
        if (state.fileExplorerStates[id] !== previous.fileExplorerStates[id]) {
          byWorkspace[id] = (byWorkspace[id] ?? 0) + 1
        }
      }
      publish()
    })
    const unsubscribeRejectedLoads = observeRejectedFileExplorerDirectoryLoads((receipt) => {
      rejectedDirectoryLoads = [...rejectedDirectoryLoads, receipt]
      publish()
    })
    publish()
    return () => {
      unsubscribeStore()
      unsubscribeRejectedLoads()
    }
  }, [])

  function setExpanded(update: SetStateAction<Set<string>>): void {
    if (!workspaceId) return
    updateExplorerState(workspaceId, (current) => ({
      ...current,
      expandedPaths: typeof update === 'function' ? update(current.expandedPaths) : update
    }))
  }

  function setSelection(update: SetStateAction<FileExplorerSelectionState>): void {
    if (!workspaceId) return
    updateExplorerState(workspaceId, (current) => ({
      ...current,
      selection: typeof update === 'function' ? update(current.selection) : update
    }))
  }

  useEffect(() => {
    clearHoverExpand()
    setActiveDrag(null)
    lastRevealedPathRef.current = null
    lastRevealRequestIdRef.current = null
    setScrollTarget(null)
    setInlineEdit(null)
    return () => clearHoverExpand()
  }, [workspaceId])

  useEffect(() => {
    if (observedFileRevisionRef.current === workspaceFileRevision) return
    observedFileRevisionRef.current = workspaceFileRevision
    void tree.refreshTree()
  }, [tree.refreshTree, workspaceFileRevision])

  // Expand each relative Workspace ancestor without replacing an existing
  // multi-selection, then scroll after async reads project the target row.
  useEffect(() => {
    if (!activePath || activePath === lastRevealedPathRef.current) return
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
  }, [activePath, explorerState, updateExplorerState, workspaceId])

  useEffect(() => {
    if (
      !revealRequest ||
      revealRequest.workspaceId !== workspaceId ||
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
  }, [revealRequest, workspaceId])

  useEffect(() => {
    if (!scrollTarget) return
    const row = [...(treeRootRef.current?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])]
      .find((candidate) => candidate.dataset.treePath === scrollTarget.path)
    if (scrollTarget.focus) row?.focus()
    row?.scrollIntoView({ block: 'nearest' })
  }, [scrollTarget, tree.dirCache])

  // Continuous filesystem watch would need a cross-host owner. Until the mux
  // decision, refresh on application focus through the same Local/SSH IPC
  // instead of introducing a local-only watcher with conflicting semantics.
  useEffect(() => {
    const refreshOnFocus = () => void tree.refreshTree()
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [tree.refreshTree])

  const rows = useMemo(
    () => flattenFileTree(tree.rootCache?.children ?? [], tree.dirCache, expanded),
    [expanded, tree.dirCache, tree.rootCache?.children]
  )
  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized
      ? rows.filter((node) => node.name.toLowerCase().includes(normalized) || node.path.toLowerCase().includes(normalized))
      : rows
  }, [query, rows])
  const rowProjection = useMemo(
    () => createFileExplorerRowProjection(visibleRows),
    [visibleRows]
  )
  const selectedNode = selectedPath ? rowProjection.getRowByPath(selectedPath) : null
  const createParent = selectedNode?.isDirectory
    ? selectedNode.path
    : selectedNode ? workspacePathParent(selectedNode.path) : ''
  const loadedTreeNodes = useMemo(
    () => Object.values(tree.dirCache).flatMap((entry) => entry.children),
    [tree.dirCache]
  )

  function clearHoverExpand(): void {
    const pending = hoverExpandRef.current
    if (pending) window.clearTimeout(pending.timer)
    hoverExpandRef.current = null
  }

  function isMoveDropDisabled(directoryPath: string): boolean {
    return activeDrag !== null &&
      planFileExplorerMove(loadedTreeNodes, activeDrag.path, directoryPath).status === 'blocked'
  }

  async function movePath(sourcePath: string, destinationPath: string): Promise<void> {
    await runFileExplorerMove({
      sourcePath,
      destinationPath,
      move: renamePath,
      refreshDirectory: tree.refreshDir
    })
  }

  async function movePathToDirectory(sourcePath: string, directoryPath: string): Promise<void> {
    const plan = planFileExplorerMove(loadedTreeNodes, sourcePath, directoryPath)
    if (plan.status === 'blocked') return
    await movePath(plan.sourcePath, plan.destinationPath)
  }

  function handleDragStart(event: DragStartEvent): void {
    const data = event.active.data.current as FileExplorerDragData | undefined
    if (data?.kind === 'file-explorer-path') {
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
      directoryPath === null ||
      planFileExplorerMove(loadedTreeNodes, drag.path, directoryPath).status === 'blocked' ||
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
    clearHoverExpand()
    setActiveDrag(null)
    if (drag?.kind !== 'file-explorer-path' || drop?.kind !== 'file-explorer-directory') return
    try {
      await movePathToDirectory(drag.path, drop.directoryPath)
    } catch {
      // renamePath already projects the typed failure through the app error owner.
    }
  }

  function toggle(node: TreeNode): void {
    if (!node.isDirectory) return
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      return next
    })
  }

  function beginCreate(kind: 'create-file' | 'create-directory', targetParent = createParent): void {
    setExpanded((current) => new Set(current).add(targetParent))
    setInlineEdit({ kind, parentPath: targetParent })
    setEditValue('')
  }

  function pathsForContext(node: TreeNode): string[] {
    return selection.selectedPaths.has(node.path)
      ? [...selection.selectedPaths]
      : [node.path]
  }

  async function copyContextPaths(node: TreeNode, kind: 'absolute' | 'relative'): Promise<void> {
    if (!workspace) return
    await copyTextToClipboard(
      formatPathsForCopy(pathsForContext(node), kind, workspace.path),
      reportError
    )
  }

  async function openDirectoryInTerminal(node: TreeNode): Promise<void> {
    if (!workspace || !activePaneId || !node.isDirectory) return
    await launchTerminal(activePaneId, undefined, joinWorkspacePath(workspace.path, node.path))
  }

  async function rebindWorkspacePath(): Promise<void> {
    if (
      !workspaceId ||
      !workspace ||
      workspace.hostId !== 'local' ||
      workspace.kind !== 'folder' ||
      relinking
    ) return
    setRelinking(true)
    try {
      const updated = await api.workspaces.rebindLocalFolder(workspaceId)
      if (!updated) return
      const current = useAppStore.getState().config
      if (!current) return
      setConfig(applyWorkspacePathRebind(current, updated))
      await tree.refreshTree()
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
    if (!workspaceId || !canRenameFileExplorerNode(workspaceId, node)) return
    setSelection(createSingleFileExplorerSelection(node.path))
    setInlineEdit({ kind: 'rename', node })
    setEditValue(node.name)
  }

  async function commitEdit(): Promise<void> {
    const edit = inlineEdit
    const name = editValue.trim()
    if (!edit || !validName(name) || !workspaceId) {
      setInlineEdit(null)
      return
    }
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
        })
        await tree.refreshDir(edit.parentPath)
        setSelection(createSingleFileExplorerSelection(path))
        if (edit.kind === 'create-file') await openFile(path, undefined, undefined, createdIn)
      }
    } finally {
      setInlineEdit(null)
    }
  }

  async function confirmDelete(): Promise<void> {
    const node = deleteRequest
    if (!node || deleting) return
    setDeleting(true)
    try {
      await deletePath(node.path)
      await tree.refreshDir(workspacePathParent(node.path))
      setDeleteRequest(null)
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
        requestAnimationFrame(() => {
          const row = treeRootRef.current?.querySelector<HTMLElement>(
            `[data-tree-index="${resolved.targetIndex}"]`
          )
          row?.focus()
          row?.scrollIntoView({ block: 'nearest' })
        })
        return
      }
    }

    const actionNode = currentIndex === null
      ? selectedNode
      : rowProjection.getRowAtIndex(currentIndex)
    if (isFileExplorerMenuKey(event) && actionNode) {
      event.preventDefault()
      const row = treeRootRef.current?.querySelector<HTMLElement>(
        `[data-tree-path="${CSS.escape(actionNode.path)}"]`
      )
      const rect = row?.getBoundingClientRect()
      row?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: rect?.left ?? 0,
        clientY: rect?.top ?? 0
      }))
    } else if ((event.key === 'Enter' || event.key === ' ') && actionNode) {
      event.preventDefault()
      actionNode.isDirectory ? toggle(actionNode) : void openFile(actionNode.path)
    } else if (FILE_EXPLORER_RENAME_KEY.matches(event) && actionNode) {
      event.preventDefault()
      if (workspaceId && canRenameFileExplorerNode(workspaceId, actionNode)) beginRename(actionNode)
    } else if (FILE_EXPLORER_DELETE_KEY.matches(event) && actionNode) {
      event.preventDefault()
      setDeleteRequest(actionNode)
    }
  }

  if (!workspaceId) return null
  const createEdit = inlineEdit?.kind === 'create-file' || inlineEdit?.kind === 'create-directory'
    ? inlineEdit
    : null
  const createRow = createEdit ? (
    <div className="tree-create-row" style={{ '--tree-depth': createEdit.parentPath ? createEdit.parentPath.split('/').length : 0 } as React.CSSProperties}>
      {createEdit.kind === 'create-directory' ? <Folder size={14} /> : <FilePlus2 size={13} />}
      <input
        autoFocus
        className="tree-inline-input"
        value={editValue}
        placeholder={createEdit.kind === 'create-directory' ? 'folder name' : 'file name'}
        onChange={(event) => setEditValue(event.target.value)}
        onBlur={() => void commitEdit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commitEdit()
          if (event.key === 'Escape') setInlineEdit(null)
        }}
      />
    </div>
  ) : null
  return (
    <section className="file-explorer">
      <div className="explorer-header">
        <span>Explorer</span>
        <div className="explorer-header__actions">
          <button onClick={() => beginCreate('create-file')} title="New file"><FilePlus2 size={13} /></button>
          <button onClick={() => beginCreate('create-directory')} title="New folder"><FolderPlus size={13} /></button>
          <button onClick={() => void tree.refreshTree()} title="Refresh explorer">
            {tree.rootCache?.loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>
      <label className="file-search">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find loaded files" />
        {query ? <button onClick={() => setQuery('')} title="Clear"><X size={11} /></button> : null}
      </label>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        autoScroll
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragCancel={() => { clearHoverExpand(); setActiveDrag(null) }}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        <div
          className="file-tree"
          ref={treeRootRef}
          role="tree"
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
        >
          <FileExplorerRootDropTarget disabled={isMoveDropDisabled('')} />
          {createEdit && !createEdit.parentPath ? createRow : null}
          {visibleRows.map((node, rowIndex) => (
            <Fragment key={node.path}>
              <FileTreeRow
            key={node.path}
            node={node}
            rowIndex={rowIndex}
            expanded={expanded.has(node.path)}
            selected={selection.selectedPaths.has(node.path) || activePath === node.path}
            dirty={Boolean(workspaceId && dirtyDocuments[documentKey(workspaceId, node.path)])}
            editing={inlineEdit?.kind === 'rename' && inlineEdit.node.path === node.path}
            editValue={editValue}
            onEditValue={setEditValue}
            onCommitEdit={() => void commitEdit()}
            onCancelEdit={() => setInlineEdit(null)}
            onContextMenuOpen={() => {
              if (!selection.selectedPaths.has(node.path)) {
                setSelection(createSingleFileExplorerSelection(node.path))
              }
            }}
            onCreate={(kind) => beginCreate(
              kind === 'file' ? 'create-file' : 'create-directory',
              node.isDirectory ? node.path : workspacePathParent(node.path)
            )}
            onCopyPaths={(kind) => void copyContextPaths(node, kind)}
            onOpenTerminal={() => void openDirectoryInTerminal(node).catch(() => {})}
            onViewFile={() => {
              if (!node.isDirectory && !node.isSymlink) void openFile(node.path)
            }}
            onMove={(directoryPath) => {
              setSelection(createSingleFileExplorerSelection(node.path))
              void movePathToDirectory(node.path, directoryPath).catch(() => {})
            }}
            moveTargets={canRenameFileExplorerNode(workspaceId, node)
              ? fileExplorerMoveTargets(loadedTreeNodes, node.path)
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
                else if (!node.isSymlink) void openFile(node.path)
              }
            }}
            onToggle={() => toggle(node)}
            onRename={() => beginRename(node)}
            onDelete={() => setDeleteRequest(node)}
            canOpenTerminal={workspace?.hostId === 'local'}
            canMove={canRenameFileExplorerNode(workspaceId, node)}
            dropDisabled={isMoveDropDisabled(fileExplorerDropDirectory(node))}
            canRename={canRenameFileExplorerNode(workspaceId, node)}
            isLocal={workspace?.hostId === 'local'}
            selectionSize={pathsForContext(node).length}
              />
              {createEdit?.parentPath === node.path ? createRow : null}
            </Fragment>
          ))}
          {tree.rootError ? (
            <div className="tree-empty tree-empty--error">
              <strong>Could not read workspace</strong>
              <span>{tree.rootError}</span>
              <div className="tree-empty__actions">
                <button className="small-button" onClick={() => void tree.refreshTree()}>Retry</button>
                {workspace?.hostId === 'local' && workspace.kind === 'folder' ? (
                  <button className="small-button" disabled={relinking} onClick={() => void rebindWorkspacePath()}>
                    {relinking ? <LoaderCircle className="spin" size={12} /> : <FolderOpen size={12} />}
                    {relinking ? 'Choosing…' : 'Choose new folder'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : !tree.rootCache?.loading && visibleRows.length === 0 ? (
            <div className="tree-empty"><strong>{query ? 'No loaded files match' : 'Workspace is empty'}</strong><span>{query ? 'Expand more folders or change the search.' : 'Create a file or folder to begin.'}</span></div>
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
        title={`Delete ${deleteRequest?.isDirectory ? 'folder' : 'file'}?`}
        description={
          workspace?.hostId === 'local'
            ? 'AgentMux will permanently remove this path. This cannot be undone.'
            : 'AgentMux will permanently remove this path from the remote host. This cannot be undone.'
        }
        {...(deleteRequest ? { subject: deleteRequest.path } : {})}
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
