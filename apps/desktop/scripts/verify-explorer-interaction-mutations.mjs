import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const base = 'apps/desktop/src/renderer/src/'
const explorer = `${base}components/FileExplorer.tsx`
const frame = `${base}components/WorkspaceFilesFrame.tsx`
const modes = `${base}components/SurfaceModeSwitch.tsx`
const branches = `${base}components/BranchesPanel.tsx`
await verifyRendererSourceMutations({
  name: ("explorer-interactions-" + (globalThis.crypto.randomUUID()) + "-" + (randomUUID().slice(0, 8)) + ""),
  tests: ['apps/desktop/test/explorer-redesign.test.tsx'],
  sources: [explorer, frame, modes, branches, `${base}components/ChangesPanel.tsx`,
    `${base}styles/dock.css`, `${base}styles/file-explorer.css`, `${base}styles/source-control.css`, `${base}styles/surface-mode-switch.css`,
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'shared-header-actions', file: frame,
      before: 'ref={setToolbarTarget}', after: 'ref={undefined}' },
    { label: 'collapsed-recovery', file: frame,
      before: 'const collapsed = resolveExplorerCollapsed(override, presentation.explorerCollapsedByDefault)',
      after: 'const collapsed = false' },
    { label: 'name-select-without-activation', file: explorer,
      before: 'onClick={(event) => { event.stopPropagation(); onSelect(event) }}',
      after: 'onClick={(event) => { event.stopPropagation(); onClick(event) }}' },
    { label: 'double-click-rename', file: explorer,
      before: 'if (canRename && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) onRename()',
      after: 'if (false) onRename()' },
    { label: 'rename-ime-boundary', file: explorer,
      before: 'if (isImeCompositionKeyDown(event)) return\n              if (editPending) return',
      after: 'if (editPending) return' },
    { label: 'rename-single-submission', file: explorer,
      before: 'if (!edit || editSubmissionRef.current || edit.workspaceId !== workspaceId || edit.workspacePath !== workspacePath) return',
      after: 'if (!edit || edit.workspaceId !== workspaceId || edit.workspacePath !== workspacePath) return' },
    { label: 'rename-failure-draft', file: explorer,
      before: 'if (editSubmissionRef.current === edit && editContextRef.current.workspaceId === edit.workspaceId && editContextRef.current.workspacePath === edit.workspacePath) setEditError(presentError(error))',
      after: 'if (editContextRef.current.workspaceId === edit.workspaceId) setInlineEdit(null)' },
    { label: 'rename-error-presentation', file: explorer,
      before: 'setEditError(presentError(error))',
      after: 'setEditError(error instanceof Error ? error.message : String(error))' },
    { label: 'rename-rebound-path-context', file: explorer,
      before: '}, [workspaceId, workspacePath])',
      after: '}, [workspaceId])' },
    { label: 'shared-header-project-path', file: frame,
      before: '<span title={displayPath(workspace.path, workspace.hostId)}>',
      after: '<span title={workspace.path}>' },
    { label: 'file-project-path-hover', file: explorer,
      before: "physical === null ? '' : displayPath(physical, workspace.hostId)",
      after: "physical === null ? '' : physical" },
    { label: 'worktree-path-deduplication', file: branches,
      before: "subtitle={worktree && worktree !== workspace.path ? displayPath(worktree, workspace.hostId) : null}",
      after: "subtitle={worktree ? displayPath(worktree, workspace.hostId) : null}" },
    { label: 'git-keyboard-navigation', file: modes,
      before: 'tabs[next]!.click()', after: 'tabs[index]!.click()' },
    { label: 'git-material-surface-connection', file: modes,
      before: 'className="surface-mode-switch" role="tablist"',
      after: 'className="surface-mode-disconnected" role="tablist"' }
  ]
})
