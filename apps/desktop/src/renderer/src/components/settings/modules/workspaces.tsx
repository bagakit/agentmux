import { FolderGit2 } from 'lucide-react'
import { WorkspaceSettingsPane } from '../WorkspaceSettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const workspacesSettingsModule = {
  id: 'workspaces',
  group: 'resources',
  title: 'Workspaces',
  description: 'Project folders and their worktrees.',
  icon: FolderGit2,
  keywords: 'project folder repo branch worktree create run on agent',
  savedSummary: (config) => `${config.workspaces.length} ${config.workspaces.length === 1 ? 'workspace' : 'workspaces'}`,
  Pane({ config, onClose }) {
    return <WorkspaceSettingsPane config={config} onClose={onClose} />
  }
} as const satisfies SettingsModule
