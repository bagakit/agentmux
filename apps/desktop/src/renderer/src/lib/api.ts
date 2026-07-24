import type {
  AgentActivity,
  AgentMuxDesktopApi,
  AppConfig,
  BrowserEvent,
  BrowserSnapshot,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionSnapshot,
  WorkspaceBranchRecord
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
    traex: { command: 'traex', args: [], env: {} },
    hermes: { command: 'hermes', args: [], env: {} },
    pi: { command: 'pi', args: [], env: {} }
  },
  workspaces: [
    { id: 'workspace-demo', name: 'agentmux', hostId: 'local', path: '/Users/river/agentmux', kind: 'folder' },
    { id: 'workspace-remote', name: 'render-lab', hostId: 'studio', path: '/srv/render-lab', kind: 'worktree', branch: 'feat/materials' }
  ]
}

let mockFiles = new Map<string, string | null>([
  ['README.md', '# README.md\n\nAgentMux workspace document.\n'],
  ['package.json', '{\n  "name": "agentmux"\n}\n'],
  ['packages', null],
  ['packages/core', null],
  ['packages/core/src', null],
  ['packages/core/src/runtime.ts', "export class AgentMuxRuntime {\n  // One owner for every agent session.\n}\n"],
  ['packages/core/src/agent-provider.ts', 'export type AgentProvider = {}\n'],
  ['apps', null],
  ['apps/desktop', null],
  ['apps/desktop/src', null],
  ['apps/desktop/src/renderer', null],
  ['apps/desktop/src/renderer/src', null],
  ['apps/desktop/src/renderer/src/App.tsx', 'export function App() { return null }\n'],
  ['docs', null],
  ['docs/orca-agent-runtime-notes.md', '# Orca runtime notes\n']
])

function mockParent(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function mockName(path: string): string {
  return path.split('/').at(-1) ?? path
}

const mockSessions: SessionSnapshot[] = [
  {
    id: 'session-codex',
    tmuxSession: 'agentmux-session-codex',
    kind: 'agent',
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
    kind: 'agent',
    agentId: 'claude',
    hostId: 'studio',
    workspacePath: '/srv/render-lab',
    label: 'Claude · material audit',
    createdAt: now - 38 * 60_000,
    updatedAt: now - 20_000,
    processState: 'unknown',
    status: { state: 'disconnected', source: 'tmux', observedAt: now - 20_000, detail: 'SSH connection to Studio Box is unavailable.' },
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
const sessionListeners = new Set<(event: RuntimeEvent) => void>()
const browserListeners = new Set<(event: BrowserEvent) => void>()
const mockBrowsers = new Map<string, BrowserSnapshot>()

function requireMockBrowser(id: string): BrowserSnapshot {
  const browser = mockBrowsers.get(id)
  if (!browser) throw new Error(`Unknown browser: ${id}`)
  return browser
}

function normalizeMockBrowserUrl(value: string): string {
  const input = value.trim()
  if (!input || input === 'about:blank') return 'about:blank'
  if (/\s/.test(input)) return `https://www.google.com/search?q=${encodeURIComponent(input)}`
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(input)) return new URL(input).toString()
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(input)
  return new URL(`${local ? 'http' : 'https'}://${input}`).toString()
}

const mockApi: AgentMuxDesktopApi = {
  config: {
    get: async () => structuredClone(mockConfig),
    save: async (config) => (mockConfig = structuredClone(config))
  },
  hosts: { check: async (host) => ({ ok: true, detail: host.kind === 'ssh' ? `tmux 3.5a · ${host.hostname}` : 'tmux 3.5a' }) },
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
    listBranches: async (workspaceId) => {
      const workspace = mockConfig.workspaces.find((item) => item.id === workspaceId)
      if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
      const repoPath = workspace.repoPath ?? workspace.path
      const related = mockConfig.workspaces.filter(
        (item) => item.hostId === workspace.hostId && (item.repoPath ?? item.path) === repoPath
      )
      const records: WorkspaceBranchRecord[] = related.map((item) => ({
        name: item.branch ?? 'main',
        worktreePath: item.path,
        workspaceId: item.id,
        isCurrent: item.id === workspaceId
      }))
      if (workspace.hostId === 'local' && !records.some((item) => item.name === 'feature/new-tab')) {
        records.push({ name: 'feature/new-tab', worktreePath: null, workspaceId: null, isCurrent: false })
      }
      return { hostId: workspace.hostId, repoPath, branches: records }
    },
    openBranch: async (workspaceId, branch) => {
      const snapshot = await mockApi.workspaces.listBranches(workspaceId)
      const record = snapshot.branches.find((item) => item.name === branch)
      if (!record?.worktreePath) throw new Error(`Branch has no worktree: ${branch}`)
      let workspace = mockConfig.workspaces.find(
        (item) => item.hostId === snapshot.hostId && item.path === record.worktreePath
      )
      if (!workspace) {
        workspace = {
          id: crypto.randomUUID(),
          name: branch,
          hostId: snapshot.hostId,
          path: record.worktreePath,
          kind: 'worktree',
          repoPath: snapshot.repoPath,
          branch
        }
        mockConfig.workspaces.push(workspace)
      }
      return { config: structuredClone(mockConfig), workspace: structuredClone(workspace) }
    },
    createWorktreeForBranch: async (input) => {
      const source = mockConfig.workspaces.find((item) => item.id === input.workspaceId)
      if (!source) throw new Error(`Unknown workspace: ${input.workspaceId}`)
      const workspace = {
        id: crypto.randomUUID(),
        name: input.branch,
        hostId: source.hostId,
        path: input.path,
        kind: 'worktree' as const,
        repoPath: source.repoPath ?? source.path,
        branch: input.branch
      }
      mockConfig.workspaces.push(workspace)
      return { config: structuredClone(mockConfig), workspace: structuredClone(workspace) }
    }
  },
  files: {
    readDirectory: async (_workspaceId, path) =>
      [...mockFiles.entries()]
        .filter(([entryPath]) => mockParent(entryPath) === path)
        .map(([entryPath, content]) => ({
          name: mockName(entryPath),
          path: entryPath,
          isDirectory: content === null,
          isSymlink: false
        }))
        .sort((a, b) =>
          a.isDirectory === b.isDirectory
            ? a.name.localeCompare(b.name)
            : a.isDirectory
              ? -1
              : 1
        ),
    read: async (_workspaceId, path) => {
      const content = mockFiles.get(path)
      if (typeof content !== 'string') throw new Error(`File not found: ${path}`)
      return { path, content }
    },
    write: async (_workspaceId, document) => {
      mockFiles.set(document.path, document.content)
    },
    create: async (_workspaceId, input) => {
      if (mockFiles.has(input.path)) throw new Error(`Path already exists: ${input.path}`)
      mockFiles.set(input.path, input.kind === 'directory' ? null : '')
    },
    rename: async (_workspaceId, input) => {
      if (!mockFiles.has(input.path)) throw new Error(`Path not found: ${input.path}`)
      if (mockFiles.has(input.nextPath)) throw new Error(`Path already exists: ${input.nextPath}`)
      const entries = [...mockFiles.entries()]
      for (const [path, content] of entries) {
        if (path === input.path || path.startsWith(`${input.path}/`)) {
          mockFiles.delete(path)
          mockFiles.set(`${input.nextPath}${path.slice(input.path.length)}`, content)
        }
      }
    },
    delete: async (_workspaceId, path) => {
      for (const candidate of [...mockFiles.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) mockFiles.delete(candidate)
      }
    }
  },
  agents: {
    detect: async (agentId, hostId) => ({
      agentId,
      hostId,
      installed: !(hostId === 'studio' && ['hermes', 'pi'].includes(agentId))
    })
  },
  sessions: {
    snapshot: async () => structuredClone(mockSnapshot),
    launchAgent: async (input) => {
      const session: SessionSnapshot = {
        id: input.sessionId ?? crypto.randomUUID(),
        tmuxSession: `agentmux-${crypto.randomUUID()}`,
        kind: 'agent',
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
      sessionListeners.forEach((listener) => listener({ type: 'session', session }))
      return session
    },
    launchTerminal: async (input) => {
      const session: SessionSnapshot = {
        id: input.sessionId ?? crypto.randomUUID(),
        tmuxSession: `agentmux-${crypto.randomUUID()}`,
        kind: 'terminal',
        agentId: null,
        hostId: input.hostId || 'local',
        workspacePath: input.workspacePath,
        label: input.label || 'Terminal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        processState: 'running',
        status: { state: 'running', source: 'tmux', observedAt: Date.now(), detail: 'zsh' },
        terminalSnapshot: '$ '
      }
      mockSnapshot.sessions.push(session)
      sessionListeners.forEach((listener) => listener({ type: 'session', session }))
      return session
    },
    send: async (sessionId, text) => {
      const session = mockSnapshot.sessions.find((item) => item.id === sessionId)
      if (session?.kind !== 'agent') return
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
      sessionListeners.forEach((listener) => listener({ type: 'activity', sessionId, activity }))
    },
    interrupt: async () => {},
    resize: async () => {},
    refresh: async (sessionId) => {
      const session = mockSnapshot.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      if (session.status.state === 'disconnected') {
        session.processState = 'running'
        session.status = {
          state: 'running',
          source: 'tmux',
          observedAt: Date.now(),
          ...(session.paneCommand ? { detail: session.paneCommand } : {})
        }
      }
      return structuredClone(session)
    },
    stop: async (sessionId) => {
      mockSnapshot.sessions = mockSnapshot.sessions.filter((item) => item.id !== sessionId)
      sessionListeners.forEach((listener) => listener({ type: 'removed', sessionId }))
    },
    onEvent(listener) {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    }
  },
  browser: {
    create: async (id, url) => {
      const browser: BrowserSnapshot = {
        id,
        url: url.trim() || 'about:blank',
        title: 'New Tab',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null
      }
      mockBrowsers.set(id, browser)
      browserListeners.forEach((listener) => listener({ type: 'updated', browser: structuredClone(browser) }))
      return structuredClone(browser)
    },
    navigate: async (id, rawUrl) => {
      const current = mockBrowsers.get(id)
      if (!current) throw new Error(`Unknown browser: ${id}`)
      const url = normalizeMockBrowserUrl(rawUrl)
      const browser = { ...current, url, title: url === 'about:blank' ? 'New Tab' : new URL(url).hostname, error: null }
      mockBrowsers.set(id, browser)
      browserListeners.forEach((listener) => listener({ type: 'updated', browser: structuredClone(browser) }))
      return structuredClone(browser)
    },
    back: async (id) => structuredClone(requireMockBrowser(id)),
    forward: async (id) => structuredClone(requireMockBrowser(id)),
    reload: async (id) => structuredClone(requireMockBrowser(id)),
    setBounds: async () => {},
    close: async (id) => {
      if (!mockBrowsers.delete(id)) return
      browserListeners.forEach((listener) => listener({ type: 'closed', id }))
    },
    onEvent(listener) {
      browserListeners.add(listener)
      return () => browserListeners.delete(listener)
    }
  }
}

function requireDesktopApi(): AgentMuxDesktopApi {
  if (!window.agentmux) throw new Error('AgentMux preload API is unavailable')
  return window.agentmux
}

export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()
