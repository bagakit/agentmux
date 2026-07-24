import type {
  AgentActivity,
  AgentMuxDesktopApi,
  AgentRuntimeEvent,
  AgentSessionSnapshot,
  AppConfig,
  RuntimeSnapshot
} from '../../../shared/contracts'

const now = Date.now()
let mockConfig: AppConfig = {
  version: 1,
  hosts: [
    { id: 'local', kind: 'local', label: 'This Mac' },
    { id: 'studio', kind: 'ssh', label: 'Studio Box', hostname: 'studio.example.com', user: 'river' }
  ],
  agents: {
    codex: { command: 'codex', args: ['--full-auto'], env: {} },
    claude: { command: 'claude', args: [], env: {} },
    hermes: { command: 'hermes', args: [], env: {} },
    pi: { command: 'pi', args: [], env: {} }
  },
  workspaces: [
    { id: 'workspace-demo', name: 'agentmux', hostId: 'local', path: '/Users/river/agentmux', kind: 'folder' },
    { id: 'workspace-remote', name: 'render-lab', hostId: 'studio', path: '/srv/render-lab', kind: 'worktree', branch: 'feat/materials' }
  ]
}

const mockSessions: AgentSessionSnapshot[] = [
  {
    id: 'session-codex',
    tmuxSession: 'agentmux-session-codex',
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/Users/river/agentmux',
    label: 'Codex · runtime core',
    createdAt: now - 12 * 60_000,
    updatedAt: now,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: now, detail: 'PreToolUse' },
    terminalSnapshot:
      '\u001b[1;36mAgentMux core\u001b[0m\n\n✓ tmux session attached\n✓ local provider ready\n\nEditing packages/core/src/runtime.ts\nRunning pnpm test…',
    paneCommand: 'codex',
    panePid: 48126
  },
  {
    id: 'session-claude',
    tmuxSession: 'agentmux-session-claude',
    agentId: 'claude',
    hostId: 'studio',
    workspacePath: '/srv/render-lab',
    label: 'Claude · material audit',
    createdAt: now - 38 * 60_000,
    updatedAt: now - 20_000,
    processState: 'running',
    status: { state: 'waiting', source: 'native-hook', observedAt: now - 20_000, detail: 'PermissionRequest' },
    terminalSnapshot: 'Claude Code\n\nI need permission to run the material snapshot suite.',
    paneCommand: 'claude',
    panePid: 7742
  }
]

const mockActivities: Record<string, AgentActivity[]> = {
  'session-codex': [
    {
      id: 'a1',
      sessionId: 'session-codex',
      kind: 'prompt',
      source: 'user',
      createdAt: now - 11 * 60_000,
      title: 'Prompt',
      content: 'Make the tmux runtime observable without coupling it to Electron.'
    },
    {
      id: 'a2',
      sessionId: 'session-codex',
      kind: 'tool',
      source: 'native-hook',
      createdAt: now - 4 * 60_000,
      title: 'Edit',
      toolName: 'Edit',
      toolInput: 'packages/core/src/runtime.ts'
    },
    {
      id: 'a3',
      sessionId: 'session-codex',
      kind: 'assistant',
      source: 'native-hook',
      createdAt: now - 50_000,
      title: 'Assistant response',
      content: 'The runtime now emits typed session, status, terminal, and activity events from one owner.'
    }
  ],
  'session-claude': [
    {
      id: 'b1',
      sessionId: 'session-claude',
      kind: 'permission',
      source: 'native-hook',
      createdAt: now - 20_000,
      title: 'Bash permission',
      toolName: 'Bash',
      toolInput: 'pnpm test:visual'
    }
  ]
}

let mockSnapshot: RuntimeSnapshot = { sessions: mockSessions, activities: mockActivities }
const listeners = new Set<(event: AgentRuntimeEvent) => void>()

const mockApi: AgentMuxDesktopApi = {
  config: {
    get: async () => structuredClone(mockConfig),
    save: async (config) => (mockConfig = structuredClone(config))
  },
  hosts: { check: async () => ({ ok: true, detail: 'tmux 3.5a' }) },
  workspaces: {
    chooseLocalFolder: async () => null,
    add: async (input) => {
      const item = {
        id: crypto.randomUUID(),
        name: input.name || input.path.split('/').pop() || input.path,
        hostId: input.hostId,
        path: input.path,
        kind: 'folder' as const
      }
      mockConfig.workspaces.push(item)
      return item
    },
    createWorktree: async (input) => {
      const item = {
        id: crypto.randomUUID(),
        name: input.name || input.path.split('/').pop() || input.branch,
        hostId: input.hostId,
        path: input.path,
        kind: 'worktree' as const,
        repoPath: input.repoPath,
        branch: input.branch
      }
      mockConfig.workspaces.push(item)
      return item
    }
  },
  files: {
    list: async () => [
      'README.md',
      'package.json',
      'packages/core/src/runtime.ts',
      'packages/core/src/agent-provider.ts',
      'apps/desktop/src/renderer/src/App.tsx',
      'docs/orca-agent-runtime-notes.md'
    ],
    read: async (_workspaceId, path) => ({
      path,
      content:
        path.endsWith('runtime.ts')
          ? "export class AgentMuxRuntime {\n  // One owner for every agent session.\n  async launch(request: AgentLaunchRequest) {\n    return this.tmux.start(request)\n  }\n}\n"
          : `# ${path}\n\nAgentMux workspace document.\n`
    }),
    write: async () => {}
  },
  agents: {
    snapshot: async () => structuredClone(mockSnapshot),
    detect: async (agentId, hostId) => ({ agentId, hostId, installed: true }),
    launch: async (input) => {
      const session: AgentSessionSnapshot = {
        id: crypto.randomUUID(),
        tmuxSession: `agentmux-${crypto.randomUUID()}`,
        agentId: input.agentId,
        hostId: input.hostId || 'local',
        workspacePath: input.workspacePath,
        label: input.label || `${input.agentId} · new session`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        processState: 'running',
        status: { state: 'running', source: 'tmux', observedAt: Date.now() },
        terminalSnapshot: 'Starting agent…'
      }
      mockSnapshot.sessions.push(session)
      listeners.forEach((listener) => listener({ type: 'session', session }))
      return session
    },
    send: async (sessionId, text) => {
      const activity: AgentActivity = {
        id: crypto.randomUUID(),
        sessionId,
        kind: 'prompt',
        source: 'user',
        createdAt: Date.now(),
        title: 'Prompt',
        content: text
      }
      ;(mockSnapshot.activities[sessionId] ??= []).push(activity)
      listeners.forEach((listener) => listener({ type: 'activity', sessionId, activity }))
    },
    interrupt: async () => {},
    resize: async () => {},
    stop: async (sessionId) => {
      mockSnapshot.sessions = mockSnapshot.sessions.filter((item) => item.id !== sessionId)
      listeners.forEach((listener) => listener({ type: 'removed', sessionId }))
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function requireDesktopApi(): AgentMuxDesktopApi {
  if (!window.agentmux) throw new Error('AgentMux preload API is unavailable')
  return window.agentmux
}

export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()
