import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
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
  isPathWithinSubtree,
  remapPathWithinSubtree
} from '../lib/workspace-paths'
import { createFileExplorerRowProjection } from './file-tree/file-explorer-row-projection'
import {
  createEmptyFileExplorerSelection,
  createSingleFileExplorerSelection,
  getFileExplorerSelectionMode,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths
} from './file-tree/file-explorer-selection'
import {
  flattenFileTree,
  useWorkspaceFileTree,
  type TreeNode
} from './file-tree/useWorkspaceFileTree'

type InlineEdit =
  | { kind: 'create-file' | 'create-directory'; parentPath: string }
  | { kind: 'rename'; node: TreeNode }

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function validName(value: string): boolean {
  const name = value.trim()
  return Boolean(name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'))
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
  onToggle,
  onRename,
  onDelete
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
  onToggle: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const FileIcon = getFileTypeIcon(node.path)
  return (
    <div
      className={`tree-row ${selected ? 'tree-row--selected' : ''}`}
      style={{ '--tree-depth': node.depth } as React.CSSProperties}
      data-tree-path={node.path}
      data-tree-index={rowIndex}
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
          <button type="button" title={`Rename ${node.name}`} onClick={(event) => { event.stopPropagation(); onRename() }}><Pencil size={11} /></button>
          <button type="button" title={`Delete ${node.name}`} onClick={(event) => { event.stopPropagation(); onDelete() }}><Trash2 size={11} /></button>
        </span>
      ) : null}
    </div>
  )
}

export function FileExplorer() {
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
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState(createEmptyFileExplorerSelection)
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null)
  const [editValue, setEditValue] = useState('')
  const [deleteRequest, setDeleteRequest] = useState<TreeNode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const treeRootRef = useRef<HTMLDivElement>(null)
  const lastRevealedPathRef = useRef<string | null>(null)
  const tree = useWorkspaceFileTree(workspaceId ?? 'missing-workspace', expanded)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const selectedPath = selection.activePath

  useEffect(() => {
    setExpanded(new Set())
    setSelection(createEmptyFileExplorerSelection())
    lastRevealedPathRef.current = null
    setInlineEdit(null)
  }, [workspaceId])

  // Orca auto-reveal adapted to AgentMux's relative Workspace paths and DOM
  // rows: expand every ancestor, retain one selection owner, then scroll once
  // the async directory reads have projected the target row.
  useEffect(() => {
    if (!activePath || activePath === lastRevealedPathRef.current) return
    lastRevealedPathRef.current = activePath
    setExpanded((current) => {
      const next = new Set(current)
      for (const path of getRevealAncestorPaths(activePath)) next.add(path)
      return next
    })
    setSelection(createSingleFileExplorerSelection(activePath))
  }, [activePath, workspaceId])

  useEffect(() => {
    if (!activePath) return
    const row = [...(treeRootRef.current?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])]
      .find((candidate) => candidate.dataset.treePath === activePath)
    row?.scrollIntoView({ block: 'nearest' })
  }, [activePath, tree.dirCache])

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
  const createParent = selectedNode?.isDirectory ? selectedNode.path : selectedNode ? parentPath(selectedNode.path) : ''

  function toggle(node: TreeNode): void {
    if (!node.isDirectory) return
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      return next
    })
  }

  function beginCreate(kind: 'create-file' | 'create-directory'): void {
    setExpanded((current) => new Set(current).add(createParent))
    setInlineEdit({ kind, parentPath: createParent })
    setEditValue('')
  }

  function beginRename(node: TreeNode): void {
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
        const nextPath = joinPath(parentPath(edit.node.path), name)
        if (nextPath !== edit.node.path) await renamePath(edit.node.path, nextPath)
        await tree.refreshDir(parentPath(edit.node.path))
        setSelection((current) =>
          updateFileExplorerSelectionPaths(current, (path) =>
            remapPathWithinSubtree(path, edit.node.path, nextPath)
          )
        )
        setExpanded((current) => new Set(
          [...current].map((path) => remapPathWithinSubtree(path, edit.node.path, nextPath))
        ))
      } else {
        const path = joinPath(edit.parentPath, name)
        await createPath({ path, kind: edit.kind === 'create-file' ? 'file' : 'directory' })
        await tree.refreshDir(edit.parentPath)
        setSelection(createSingleFileExplorerSelection(path))
        if (edit.kind === 'create-file') await openFile(path)
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
      await tree.refreshDir(parentPath(node.path))
      setSelection((current) =>
        updateFileExplorerSelectionPaths(current, (path) =>
          isPathWithinSubtree(path, node.path) ? null : path
        )
      )
      setExpanded((current) => new Set(
        [...current].filter((path) => !isPathWithinSubtree(path, node.path))
      ))
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
    if ((event.key === 'Enter' || event.key === ' ') && actionNode) {
      event.preventDefault()
      actionNode.isDirectory ? toggle(actionNode) : void openFile(actionNode.path)
    } else if (event.key === 'F2' && actionNode) {
      event.preventDefault()
      beginRename(actionNode)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && actionNode) {
      event.preventDefault()
      setDeleteRequest(actionNode)
    }
  }

  if (!workspaceId) return null
  const creating = inlineEdit?.kind === 'create-file' || inlineEdit?.kind === 'create-directory'
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
      <div
        className="file-tree"
        ref={treeRootRef}
        role="tree"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
      >
        {creating ? (
          <div className="tree-create-row" style={{ '--tree-depth': inlineEdit.parentPath ? inlineEdit.parentPath.split('/').length : 0 } as React.CSSProperties}>
            {inlineEdit.kind === 'create-directory' ? <Folder size={14} /> : <FilePlus2 size={13} />}
            <input
              autoFocus
              className="tree-inline-input"
              value={editValue}
              placeholder={inlineEdit.kind === 'create-directory' ? 'folder name' : 'file name'}
              onChange={(event) => setEditValue(event.target.value)}
              onBlur={() => void commitEdit()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitEdit()
                if (event.key === 'Escape') setInlineEdit(null)
              }}
            />
          </div>
        ) : null}
        {visibleRows.map((node, rowIndex) => (
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
            onClick={(event) => {
              const mode = getFileExplorerSelectionMode(event, isMac)
              setSelection((current) => updateFileExplorerSelection(
                current,
                rowProjection.getOrderedPaths(),
                node.path,
                mode
              ))
              // Match Orca's selectRowWithModifiers contract: range/toggle
              // clicks change selection only; activation belongs to a plain
              // replacement click.
              if (mode === 'replace') {
                if (node.isDirectory) toggle(node)
                else if (!node.isSymlink) void openFile(node.path)
              }
            }}
            onToggle={() => toggle(node)}
            onRename={() => beginRename(node)}
            onDelete={() => setDeleteRequest(node)}
          />
        ))}
        {tree.rootError ? (
          <div className="tree-empty tree-empty--error"><strong>Could not read workspace</strong><span>{tree.rootError}</span><button className="small-button" onClick={() => void tree.refreshTree()}>Retry</button></div>
        ) : !tree.rootCache?.loading && visibleRows.length === 0 ? (
          <div className="tree-empty"><strong>{query ? 'No loaded files match' : 'Workspace is empty'}</strong><span>{query ? 'Expand more folders or change the search.' : 'Create a file or folder to begin.'}</span></div>
        ) : null}
      </div>
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
