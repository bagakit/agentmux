import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
export const workspace = { id: 'branch-style', name: 'AgentMux', hostId: 'local', path: _hygiene_fixturePath("Users/reviewer/proj/agentmux"), branch: 'main', kind: 'folder' }
const path = workspace.path
export const branches = [
  { name: 'main', worktreePath: path, workspaceId: workspace.id, isCurrent: true },
  { name: 'agentmux/continuous-progress-review', worktreePath: path + '/.worktrees/continuous-progress', workspaceId: 'wt-1', isCurrent: false },
  { name: 'feat/agentmux-private-mobile-preview', worktreePath: path + '/.worktrees/mobile-preview', workspaceId: 'wt-2', isCurrent: false },
  { name: 'feat/conversation-history-current-source', worktreePath: path + '/.worktrees/history', workspaceId: 'wt-3', isCurrent: false },
  { name: 'feat/compact-status-markers', worktreePath: path + '/.worktrees/compact-status', workspaceId: 'wt-4', isCurrent: false },
  { name: 'feat/semantic-recovery', worktreePath: path + '/.worktrees/recovery', workspaceId: 'wt-5', isCurrent: false },
  { name: 'release/next', worktreePath: null, workspaceId: null, isCurrent: false },
  { name: 'experiment/branch-without-worktree', worktreePath: null, workspaceId: null, isCurrent: false }
]
export const calls: unknown[] = []
const sessions = ['codex', 'claude'].map((providerId, index) => ({
  kind: 'agent', id: `branch-style-agent-${index}`, agentSessionId: `branch-style-agent-${index}`,
  hostId: 'local', workspacePath: path, providerId, executorId: providerId,
  processState: 'running', status: { state: index ? 'idle' : 'working' }, updatedAt: 2 - index
}))
const state = {
  localHome: _hygiene_fixturePath("Users/reviewer"), sessions, pinnedItems: {},
  config: { projects: [], hosts: [{ id: 'local', kind: 'local' }], executors: { codex: { providerId: 'codex', label: 'Codex' }, claude: { providerId: 'claude', label: 'Claude' } }, appearance: {} },
  activateWorkspaceSelection: (value: unknown) => calls.push(['activate', value]),
  togglePinnedItem: (...args: unknown[]) => calls.push(['pin', ...args])
}
export const useAppStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state })
export const api = { workspaces: {
  listBranches: async () => ({ kind: 'git-repository', hostId: 'local', repoPath: path, branches }),
  openBranch: async (_workspaceId: string, name: string) => { calls.push(['open', name]); return workspace }
} }
