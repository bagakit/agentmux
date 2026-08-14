import type {
  AgentExecutorConfig,
  AgentTimelineSnapshot,
  AgentMuxDesktopApi,
  AgentMuxPreloadApi,
  AppConfig,
  BrowserEvent,
  BrowserProfileImportSourceSummary,
  BrowserProfileSummary,
  BrowserSnapshot,
  BrowserViewport,
  RuntimeEvent,
  RuntimeSnapshot,
  SessionSnapshot,
  WorkspaceBranchRecord
} from '../../../shared/contracts'
import { CONFIG_VERSION } from '../../../shared/contracts'
import type { AgentCatalogEntry, AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import { BUILT_IN_AGENT_PROVIDER_IDS, builtInAgentProviderLabel } from '@agentmux/core/provider-id'
import { LAUNCH_OPTIONS_BY_PROVIDER_ID, describeLaunchOptions } from '@agentmux/core/launch-option'
import { createRendererControlApi } from './control-api'
import {
  SCRATCH_TOPIC_TITLE_MAX_LENGTH,
  scratchTopicDirectoryName,
  scratchTopicIdFromDirectoryName
} from '../../../shared/scratch-topics'

const now = Date.now()
const MOCK_SCREENSHOT_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg=='
// Typed against the core contract, not a free-floating literal: the annotation makes tsc reject any
// shape that diverges from `AgentCapabilities` — a field the core type dropped (the old `hookEvents` /
// `acp` mirrors of `hookStrategy.kind` / `acpStrategy.kind`, both deleted as zero-consumer) can no
// longer linger here, and a re-added one would have to earn a place in the core type first. Same
// discipline as the launch-option lines below, which annotate against `AgentCatalogEntry['launchOptions']`
// so the preview projects the core contract rather than hand-copying a shape that can drift out of it.
const mockStructuredCapabilities: AgentCatalogEntry['capabilities'] = {
  terminal: true,
  timeline: 'complete-events',
  permission: 'observe',
  providerResume: true,
  replyCorrelation: 'none'
}
// The browser-only preview projects the SAME SSOT launch-option declarations the real core catalog
// projects — through describeLaunchOptions, exactly as defineAgentProvider does — so the preview can never
// hand-copy a diverging catalog. Imported from @agentmux/core/launch-option, the node-free module (it pulls
// only ./errors.js and ./types.js), so no Node built-in reaches the browser bundle.
//
// The preview projects one Executor and one catalog entry PER built-in Provider id — derived from the same
// node-free SSOT the identity type is built on (BUILT_IN_AGENT_PROVIDER_IDS), never a hand-copied subset.
// Core's real catalog() would give richer per-Provider fields but it drags node:path / node:crypto into the
// browser bundle, so the preview cannot import it; deriving from the id list keeps every Provider visible
// without pulling Node in.
//
// Labels come from builtInAgentProviderLabel in that same node-free module, which provider-conformance.test.ts
// pins per-id against each catalog's own label. This line used to be
// `id.charAt(0).toUpperCase() + id.slice(1)` — an algorithm, and it got 2 of 13 wrong: `traex → Traex`
// (真值 TraeX) and `opencode → Opencode` (真值 OpenCode). Nothing caught it because the only label guard
// asserted `agentProviderLabel(id) !== id`, which `Traex` also satisfies — the criterion was one notch
// coarser than the defect, so the 11 that happened to match were enough to keep it green.
//
// Launch options come from LAUNCH_OPTIONS_BY_PROVIDER_ID, the reverse lookup in that same node-free module,
// so every Provider that declares options gets its control here. This used to read
// `id === 'codex' ? … : id === 'claude' ? … : []` under a comment claiming those two were the only
// declarations exported node-free — which was never true. All eight live in that one module, so six
// Providers' controls (plus grok's posture selector) were silently missing from the preview while the
// comment vouched for the gap as honest absence. An id absent from the map declares nothing, which is the
// real answer for pi/kimi/droid/copilot; core's own catalog is what keeps the map from drifting
// (agent-provider.test.ts asserts it per Provider, both directions).
const mockProviderLaunchOptions = (id: string): AgentCatalogEntry['launchOptions'] => {
  const declarations = LAUNCH_OPTIONS_BY_PROVIDER_ID[id]
  return declarations ? describeLaunchOptions(declarations) : []
}
const mockExecutors: Record<string, AgentExecutorConfig> = Object.fromEntries(
  BUILT_IN_AGENT_PROVIDER_IDS.map((id) => [
    id,
    { label: builtInAgentProviderLabel(id), providerId: id, command: id, args: [], env: {}, injectAgentMuxGuide: true }
  ])
)
let mockConfig: AppConfig = {
  version: CONFIG_VERSION,
  hosts: [
    { id: 'local', kind: 'local', label: 'This Mac' },
    {
      id: 'studio',
      kind: 'ssh',
      label: 'Studio Box',
      hostname: 'studio.example.com',
      user: 'river'
    }
  ],
  executors: mockExecutors,
  workspaces: [
    { id: 'workspace-demo', name: 'agentmux', hostId: 'local', path: '/Users/river/agentmux', kind: 'folder' },
    { id: 'workspace-remote', name: 'render-lab', hostId: 'studio', path: '/srv/render-lab', kind: 'worktree', branch: 'feat/materials' }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: {
      selectElement: true,
      screenshot: true,
      devTools: true,
      viewport: true,
      more: true
    }
  }
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
  ['docs', null]
])
let mockRevisionSequence = 0
let mockFileRevisions = new Map<string, string>(
  [...mockFiles.entries()].flatMap(([path, content]) =>
    typeof content === 'string' ? [[path, `mock:${++mockRevisionSequence}`] as const] : []
  )
)
const mockObservedFiles = new Set<string>()
const mockFileInvalidationListeners = new Set<Parameters<AgentMuxDesktopApi['files']['onInvalidated']>[0]>()

function invalidateMockFile(workspaceId: string, path: string): void {
  if (!mockObservedFiles.has(`${workspaceId}\0${path}`)) return
  for (const listener of mockFileInvalidationListeners) listener({ workspaceId, path })
}

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
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: mockStructuredCapabilities,
    hostId: 'local',
    workspacePath: '/Users/river/agentmux',
    label: 'Codex · runtime core',
    createdAt: now - 12 * 60_000,
    updatedAt: now,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: now, detail: 'PreToolUse' },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: 'session-codex',
      run: { runId: 'run-codex' }
    }
  },
  {
    id: 'session-claude',
    kind: 'agent',
    providerId: 'claude',
    executorId: 'claude',
    capabilities: mockStructuredCapabilities,
    hostId: 'studio',
    workspacePath: '/srv/render-lab',
    label: 'Claude · material audit',
    createdAt: now - 38 * 60_000,
    updatedAt: now - 20_000,
    processState: 'interrupted',
    status: { state: 'error', source: 'run-process', observedAt: now - 20_000, detail: 'SSH connection to Studio Box is unavailable.' },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'studio',
      agentSessionId: 'session-claude',
      run: { runId: 'run-claude' }
    }
  }
]

const mockOutput = new Map<string, string>([
  ['session-codex', '\u001b[1;36mAgentMux core\u001b[0m\r\n\r\n✓ Run attached\r\n✓ local Provider ready\r\n\r\nEditing packages/core/src/runtime.ts\r\nRunning pnpm test…\r\n'],
  ['session-claude', 'Claude Code\r\n\r\nI need permission to run the material snapshot suite.\r\n']
])

const mockControlListeners = new Set<(
  request: AgentMuxControlRequest,
  signal: AbortSignal
) => AgentMuxControlResult | Promise<AgentMuxControlResult>>()

const mockTimelines: Record<string, AgentTimelineSnapshot> = {
  'session-codex': {
    agentSessionId: 'session-codex',
    revision: 3,
    items: [
      {
        id: 'a1',
        agentSessionId: 'session-codex',
        kind: 'user_message',
        status: 'complete',
        source: 'user',
        createdAt: now - 11 * 60_000,
        updatedAt: now - 11 * 60_000,
        title: 'Prompt',
        content: 'Make the Run adapter observable without coupling it to Electron.'
      },
      {
        id: 'a2',
        agentSessionId: 'session-codex',
        kind: 'tool_call',
        status: 'complete',
        source: 'native-hook',
        createdAt: now - 4 * 60_000,
        updatedAt: now - 4 * 60_000,
        title: 'Edit',
        toolName: 'Edit',
        toolInput: 'packages/core/src/runtime.ts'
      },
      {
        id: 'a3',
        agentSessionId: 'session-codex',
        kind: 'assistant_message',
        status: 'complete',
        source: 'native-hook',
        createdAt: now - 50_000,
        updatedAt: now - 50_000,
        title: 'Assistant response',
        content: 'The runtime now emits typed session, status, terminal, and activity events from one owner.'
      }
    ]
  },
  'session-claude': {
    agentSessionId: 'session-claude',
    revision: 1,
    items: [
      {
        id: 'b1',
        agentSessionId: 'session-claude',
        kind: 'permission',
        status: 'complete',
        source: 'native-hook',
        createdAt: now - 20_000,
        updatedAt: now - 20_000,
        title: 'Bash permission',
        toolName: 'Bash',
        toolInput: 'pnpm test:visual'
      }
    ]
  }
}

let mockSnapshot: RuntimeSnapshot = {
  sessions: mockSessions,
  timelines: mockTimelines,
  recoveryCandidates: []
}
const sessionListeners = new Set<(event: RuntimeEvent) => void>()
const browserListeners = new Set<(event: BrowserEvent) => void>()
const windowResizeListeners = new Set<(event: { active: boolean }) => void>()
const mockBrowsers = new Map<string, BrowserSnapshot>()
const mockDefaultBrowserProfile: BrowserProfileSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Default',
  createdAt: now,
  isDefault: true,
  source: null
}
let mockBrowserProfiles: BrowserProfileSummary[] = [mockDefaultBrowserProfile]
let mockBrowserImportSources: BrowserProfileImportSourceSummary[] = []

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
  hosts: { check: async (host) => host.kind === 'ssh'
    ? { ok: false, detail: 'Remote Runs are not yet supported.' }
    : { ok: true, detail: 'CtxMux 0.1.0 · protocol 14' } },
  workspaces: {
    appearance: async () => ({ kind: 'directory', icon: null }),
    chooseLocalFolder: async () => null,
    rebindLocalFolder: async () => null,
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
      return { kind: 'git-repository', hostId: workspace.hostId, repoPath, branches: records }
    },
    openBranch: async (workspaceId, branch) => {
      const snapshot = await mockApi.workspaces.listBranches(workspaceId)
      if (snapshot.kind !== 'git-repository') throw new Error('Workspace is not a Git repository')
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
    },
    // 预览环境没有 git，无法真的移除 worktree。`retained` 正是「还在盘上」的那个答案，所以说实话
    // 就够了，不需要第三种词汇：假装 removed 会让界面把一条还在的记录从列表里划掉。
    //
    // `git-failed` 而不是 `uncommitted-changes`：这里没有脏树，是根本没有 git。那一档会把用户带到
    // 「要不要丢弃未提交的产出？」对话框，而这里没有任何产出可丢——多点一次只会再失败一次。
    removeWorktree: async () => ({
      status: 'retained',
      retention: 'git-failed',
      reason: 'Removing a worktree needs the desktop app.'
    }),
    // The web preview has no git and no processes, so a fan-out cannot be simulated honestly. Refusing
    // is the truthful answer — a fake set of "launched" lanes would be worse than no answer.
    runFanOut: async () => ({ kind: 'rejected', reason: 'Fan-out needs the desktop app.' }),
    keepOneOfFanOut: async (input) => ({ keptWorkspaceId: input.keepWorkspaceId, outcomes: [] })
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
      if (content === null) return { status: 'directory' }
      if (typeof content !== 'string') return { status: 'deleted' }
      return {
        status: 'read',
        document: { path, content, revision: mockFileRevisions.get(path) ?? `mock:${++mockRevisionSequence}` }
      }
    },
    write: async (workspaceId, input) => {
      const observedRevision = mockFileRevisions.get(input.path) ?? null
      if (observedRevision !== input.expectedRevision) {
        return { status: 'conflict', observedRevision }
      }
      const revision = `mock:${++mockRevisionSequence}`
      mockFiles.set(input.path, input.content)
      mockFileRevisions.set(input.path, revision)
      queueMicrotask(() => invalidateMockFile(workspaceId, input.path))
      return { status: 'written', revision }
    },
    observe: async (workspaceId, path) => {
      mockObservedFiles.add(`${workspaceId}\0${path}`)
    },
    unobserve: async (workspaceId, path) => {
      mockObservedFiles.delete(`${workspaceId}\0${path}`)
    },
    onInvalidated(listener) {
      mockFileInvalidationListeners.add(listener)
      return () => mockFileInvalidationListeners.delete(listener)
    },
    create: async (_workspaceId, input) => {
      if (mockFiles.has(input.path)) throw new Error(`Path already exists: ${input.path}`)
      mockFiles.set(input.path, input.kind === 'directory' ? null : '')
      if (input.kind === 'file') mockFileRevisions.set(input.path, `mock:${++mockRevisionSequence}`)
    },
    move: async (input) => {
      if (input.source.workspaceId !== input.destination.workspaceId) {
        return {
          status: 'error',
          code: 'WORKSPACE_MOVE_CROSS_WORKSPACE',
          message: 'Moving paths between workspaces is not supported',
          finalLocation: 'source'
        }
      }
      if (!mockFiles.has(input.source.path)) {
        return {
          status: 'error',
          code: 'ENOENT',
          message: `Path not found: ${input.source.path}`,
          finalLocation: 'unknown'
        }
      }
      if (mockFiles.has(input.destination.path)) {
        return {
          status: 'error',
          code: 'WORKSPACE_MOVE_DESTINATION_EXISTS',
          message: `Path already exists: ${input.destination.path}`,
          finalLocation: 'source'
        }
      }
      const entries = [...mockFiles.entries()]
      for (const [path, content] of entries) {
        if (path === input.source.path || path.startsWith(`${input.source.path}/`)) {
          mockFiles.delete(path)
          const nextPath = `${input.destination.path}${path.slice(input.source.path.length)}`
          mockFiles.set(nextPath, content)
          const revision = mockFileRevisions.get(path)
          mockFileRevisions.delete(path)
          if (revision) mockFileRevisions.set(nextPath, revision)
        }
      }
      return { status: 'moved' }
    },
    delete: async (_workspaceId, path) => {
      for (const candidate of [...mockFiles.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) {
          mockFiles.delete(candidate)
          mockFileRevisions.delete(candidate)
        }
      }
    },
    reveal: async () => {}
  },
  scratch: {
    listTopics: async (workspaceId) => {
      const topicIds = [...mockFiles.entries()].flatMap(([path, content]) => {
        if (content !== null || path.includes('/')) return []
        const topicId = scratchTopicIdFromDirectoryName(path)
        return topicId ? [topicId] : []
      })
      topicIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      return await Promise.all(topicIds.map(async (topicId) =>
        (await mockApi.scratch.readTopic(workspaceId, topicId))!
      ))
    },
    readTopic: async (_workspaceId, topicId) => {
      const directoryPath = scratchTopicDirectoryName(topicId)
      const topicPath = `${directoryPath}/topic.md`
      const content = mockFiles.get(topicPath)
      if (typeof content !== 'string') return null
      const lines = content.split(/\r?\n/)
      const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim() || 'Untitled Topic'
      const summary = lines.find((line) => {
        const value = line.trim()
        return Boolean(value && !value.startsWith('#'))
      })?.trim() ?? ''
      return {
        id: topicId,
        directoryPath,
        topicPath,
        title,
        summary,
        collaborators: [...mockFiles.keys()].flatMap((path) => {
          const prefix = `${directoryPath}/.agents/`
          if (!path.startsWith(prefix)) return []
          const fileName = path.slice(prefix.length)
          const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.identity\.md$/.exec(fileName)
          return match ? [{ fileName, providerId: match[1]!, sessionId: match[2]! }] : []
        })
      }
    },
    ensureTopic: async (workspaceId, topicId) => {
      const directoryPath = scratchTopicDirectoryName(topicId)
      mockFiles.set(directoryPath, null)
      mockFiles.set(`${directoryPath}/outcome`, null)
      mockFiles.set(`${directoryPath}/refs`, null)
      mockFiles.set(`${directoryPath}/.agents`, null)
      const topicPath = `${directoryPath}/topic.md`
      if (!mockFiles.has(topicPath)) {
        mockFiles.set(topicPath, '# Untitled Topic\n\nDescribe the shared goal.\n')
        mockFileRevisions.set(topicPath, `mock:${++mockRevisionSequence}`)
      }
      return (await mockApi.scratch.readTopic(workspaceId, topicId))!
    },
    renameTitle: async (workspaceId, topicId, title) => {
      const normalized = title.trim()
      if (!normalized) throw new Error('Scratch Topic title cannot be empty')
      if (/[\r\n]/.test(normalized)) throw new Error('Scratch Topic title must be one line')
      if (normalized.length > SCRATCH_TOPIC_TITLE_MAX_LENGTH) {
        throw new Error(`Scratch Topic title cannot exceed ${SCRATCH_TOPIC_TITLE_MAX_LENGTH} characters`)
      }
      const topic = await mockApi.scratch.readTopic(workspaceId, topicId)
      if (!topic) throw new Error('Scratch Topic no longer exists')
      const content = mockFiles.get(topic.topicPath)
      if (typeof content !== 'string') throw new Error('Scratch Topic no longer exists')
      const heading = /^#[^\S\r\n]+[^\r\n]*(?=\r?$)/m
      const newline = content.includes('\r\n') ? '\r\n' : '\n'
      mockFiles.set(
        topic.topicPath,
        heading.test(content)
          ? content.replace(heading, `# ${normalized}`)
          : `# ${normalized}${newline}${newline}${content}`
      )
      mockFileRevisions.set(topic.topicPath, `mock:${++mockRevisionSequence}`)
      queueMicrotask(() => invalidateMockFile(workspaceId, topic.topicPath))
      return (await mockApi.scratch.readTopic(workspaceId, topicId))!
    }
  },
  ui: {
    rendererUpdateReady: async () => {},
    captureScreenshot: async () => { throw new Error('Screen selection requires the desktop app.') },
    listAgentSkills: async () => { throw new Error('Skill discovery requires the desktop app.') },
    listWorkspaceSkills: async () => { throw new Error('Skill discovery requires the desktop app.') },
    readClipboardText: async () => '',
    writeClipboardText: async () => {},
    writeClipboardImage: async () => {},
    openExternal: async () => {},
    // No native dialog outside Electron; dismissing is the honest answer.
    chooseFiles: async () => null,
    savePastedImage: async () => { throw new Error('Pasting images requires the desktop app.') },
    // A browser tab has no OS notification channel we own, so this reports unsupported rather than
    // claiming delivery. The caller's contract already handles that by falling back to the in-window
    // signal, which is all a web view can honestly offer.
    notifyAgentAttention: async () => ({
      status: 'unsupported' as const,
      reason: 'Native notifications require the desktop app.'
    }),
    // Nothing can raise one here, so nothing can be clicked; the unsubscribe is still real.
    onAgentAttentionActivate: () => () => {},
    getZoomFactor: () => 1,
    onWindowResize(listener) {
      windowResizeListeners.add(listener)
      return () => windowResizeListeners.delete(listener)
    }
  },
  providers: {
    list: async () =>
      BUILT_IN_AGENT_PROVIDER_IDS.map((id) => ({
        id,
        label: builtInAgentProviderLabel(id),
        executable: id,
        expectedProcess: id,
        promptDelivery: 'positional-argv',
        readySignal: { kind: 'foreground-process', expectedProcess: id },
        hookStrategy: { kind: 'native', installation: 'explicit-managed' },
        resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
        acpStrategy: { kind: 'none' },
        capabilities: mockStructuredCapabilities,
        launchOptions: mockProviderLaunchOptions(id)
      }))
  },
  executors: {
    detect: async (executorId, hostId) => ({
      executorId,
      providerId: mockConfig.executors[executorId]?.providerId ?? 'codex',
      hostId,
      availability: hostId === 'studio' && ['hermes', 'pi'].includes(executorId) ? 'missing' : 'available'
    })
  },
  control: {
    onRequest(listener) {
      mockControlListeners.add(listener)
      return () => mockControlListeners.delete(listener)
    }
  },
  sessions: {
    snapshot: async () => structuredClone(mockSnapshot),
    launchAgent: async (input) => {
      const executor = mockConfig.executors[input.executorId]
      if (!executor) throw new Error(`Unknown Agent Executor: ${input.executorId}`)
      const agentSessionId = input.agentSessionId ?? crypto.randomUUID()
      const runId = crypto.randomUUID()
      const session: SessionSnapshot = {
        id: agentSessionId,
        kind: 'agent',
        providerId: executor.providerId,
        executorId: input.executorId,
        capabilities: mockStructuredCapabilities,
        hostId: input.hostId || 'local',
        workspacePath: input.workspacePath,
        label: `${executor.label} · new session`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        processState: 'running',
        status: { state: 'running', source: 'run-process', observedAt: Date.now() },
        latestOutputBytes: 0,
        control: {
          kind: 'agent',
          hostId: input.hostId,
          agentSessionId,
          run: { runId }
        }
      }
      mockSnapshot.sessions.push(session)
      const timeline: AgentTimelineSnapshot = {
        agentSessionId: session.id,
        revision: 0,
        items: []
      }
      mockSnapshot.timelines[session.id] = timeline
      mockOutput.set(session.id, 'Starting agent…\r\n')
      return { session, timeline }
    },
    launchTerminal: async (input) => {
      const runId = crypto.randomUUID()
      const session: SessionSnapshot = {
        id: runId,
        kind: 'terminal',
        providerId: null,
        hostId: input.hostId || 'local',
        workspacePath: input.workspacePath,
        label: 'Terminal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        processState: 'running',
        status: { state: 'running', source: 'run-process', observedAt: Date.now() },
        latestOutputBytes: 0,
        control: {
          kind: 'terminal',
          hostId: input.hostId,
          runId,
          run: { runId }
        }
      }
      mockSnapshot.sessions.push(session)
      mockOutput.set(session.id, '$ ')
      return session
    },
    timeline: async (control) => {
      const timeline = mockSnapshot.timelines[control.agentSessionId]
      if (!timeline) throw new Error(`Timeline not found: ${control.agentSessionId}`)
      return structuredClone(timeline)
    },
    attach: async (control) => {
      const sessionId = control.kind === 'agent' ? control.agentSessionId : control.runId
      const session = mockSnapshot.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      const data = mockOutput.get(sessionId) ?? ''
      const endByte = new TextEncoder().encode(data).byteLength
      return {
        attachmentId: crypto.randomUUID(),
        session: structuredClone(session),
        replay: data ? [{
          type: 'data' as const,
          runId: control.run.runId,
          startByte: 0,
          endByte,
          data
        }] : [],
        gap: null
      }
    },
    detach: async () => {},
    write: async (control, input) => {
      const sessionId = control.kind === 'agent' ? control.agentSessionId : control.runId
      const session = mockSnapshot.sessions.find((item) => item.id === sessionId)
      if (!session) return
      // 这个 mock 只做文本回显与 timeline 记账。真实通路上 onBinary 会送 latin1 字节，
      // 但 web 预览里没有旧式鼠标 TUI，这里按字符还原成文本即可，不引第二套字节账。
      const data = typeof input === 'string' ? input : String.fromCharCode(...input)
      const previous = mockOutput.get(sessionId) ?? ''
      mockOutput.set(sessionId, `${previous}${data}`)
      if (session.kind === 'agent' && data.trim()) {
        const observedAt = Date.now()
        const timeline = mockSnapshot.timelines[session.id]
        if (!timeline) throw new Error(`Timeline not found: ${session.id}`)
        const item = {
          id: crypto.randomUUID(),
          agentSessionId: session.id,
          kind: 'user_message' as const,
          status: 'complete' as const,
          source: 'user' as const,
          createdAt: observedAt,
          updatedAt: observedAt,
          title: 'Prompt',
          content: data.trim()
        }
        timeline.revision += 1
        timeline.items.push(item)
        sessionListeners.forEach((listener) => listener({
          type: 'core',
          hostId: session.hostId,
          event: {
            type: 'agent-timeline',
            agentSessionId: session.id,
            revision: timeline.revision,
            mutation: {
              type: 'append',
              agentSessionId: session.id,
              item
            },
            evidence: {
              source: 'user',
              observedAt,
              run: { ...session.control.run }
            }
          }
        }))
      }
    },
    submitPrompt: async (control, prompt) => {
      await mockApi.sessions.write(control, `${prompt.trim()}\r`)
    },
    respondInteraction: async (control, response) => {
      const session = mockSnapshot.sessions.find((item) => item.id === control.agentSessionId)
      if (!session || session.kind !== 'agent') throw new Error(`Session not found: ${control.agentSessionId}`)
      if (!session.pendingInteraction || session.pendingInteraction.id !== response.requestId) {
        throw new Error('Agent interaction is not pending')
      }
      delete session.pendingInteraction
      session.updatedAt = Date.now()
    },
    // The browser preview carries no posture-capable Provider session (only codex + claude, which declare
    // no addressable in-band control), so no preview session ever renders the control to drive. Honor the
    // contract as a faithful no-op after asserting the session exists; the real keystroke is written by
    // core over the PTY in the Electron build.
    setPosture: async (control) => {
      const session = mockSnapshot.sessions.find((item) => item.id === control.agentSessionId)
      if (!session || session.kind !== 'agent') throw new Error(`Session not found: ${control.agentSessionId}`)
    },
    resume: async (control, prompt) => {
      const session = mockSnapshot.sessions.find((item) => item.id === control.agentSessionId)
      if (!session || session.kind !== 'agent') throw new Error(`Session not found: ${control.agentSessionId}`)
      const runId = crypto.randomUUID()
      session.processState = 'running'
      session.status = { state: 'running', source: 'run-process', observedAt: Date.now() }
      session.updatedAt = Date.now()
      session.control = { ...session.control, run: { runId } }
      await mockApi.sessions.write(session.control, `${prompt.trim()}\r`)
      return structuredClone(session)
    },
    acknowledge: async () => {},
    interrupt: async () => {},
    resize: async () => {},
    refresh: async (control) => {
      const sessionId = control.kind === 'agent' ? control.agentSessionId : control.runId
      const session = mockSnapshot.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      if (session.processState === 'interrupted') {
        session.processState = 'running'
        session.status = {
          state: 'running',
          source: 'run-process',
          observedAt: Date.now()
        }
      }
      return structuredClone(session)
    },
    recover: async (control, workspacePath) => {
      const sessionId = control.kind === 'agent' ? control.agentSessionId : control.runId
      const previous = mockSnapshot.sessions.find((item) => item.id === sessionId)
      if (control.kind === 'agent') {
        // Agents resume under the same agentSessionId with a fresh runId.
        if (!previous) throw new Error(`Session not found: ${sessionId}`)
        const runId = crypto.randomUUID()
        previous.processState = 'running'
        previous.status = { state: 'running', source: 'run-process', observedAt: Date.now() }
        previous.updatedAt = Date.now()
        previous.control = { ...previous.control, run: { runId } } as typeof previous.control
        mockOutput.set(previous.id, 'Resuming agent…\r\n')
        return { kind: 'resumed' as const, session: structuredClone(previous) }
      }
      // Terminals relaunch as a brand-new Run in the same cwd.
      const runId = crypto.randomUUID()
      const session: SessionSnapshot = {
        id: runId,
        kind: 'terminal',
        providerId: null,
        hostId: control.hostId || 'local',
        workspacePath: workspacePath ?? previous?.workspacePath ?? '~',
        label: 'Terminal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        processState: 'running',
        status: { state: 'running', source: 'run-process', observedAt: Date.now() },
        latestOutputBytes: 0,
        control: { kind: 'terminal', hostId: control.hostId, runId, run: { runId } }
      }
      if (previous) mockSnapshot.sessions = mockSnapshot.sessions.filter((item) => item.id !== sessionId)
      mockSnapshot.sessions.push(session)
      mockOutput.set(session.id, '$ ')
      return { kind: 'terminal-restarted' as const, session }
    },
    stop: async (control) => {
      const sessionId = control.kind === 'agent' ? control.agentSessionId : control.runId
      mockSnapshot.sessions = mockSnapshot.sessions.filter((item) => item.id !== sessionId)
      delete mockSnapshot.timelines[sessionId]
      mockOutput.delete(sessionId)
      sessionListeners.forEach((listener) => listener({
        type: 'core',
        hostId: control.hostId,
        event: {
          type: 'run-removed',
          ...(control.kind === 'agent' ? { agentSessionId: control.agentSessionId } : {}),
          run: { ...control.run },
          evidence: {
            source: 'user',
            observedAt: Date.now(),
            run: { ...control.run }
          }
        }
      }))
    },
    onEvent(listener) {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    }
  },
  resourceUsage: {
    // Web 预览没有真实进程可采。返回一个不做任何事的退订函数，面板因此渲染"不可用"
    // 而不是编造数字——预览里显示一个假的 CPU 读数，比不显示更糟。
    subscribe: () => () => {}
  },
  browser: {
    create: async (id, url) => {
      const browser: BrowserSnapshot = {
        id,
        navigationId: crypto.randomUUID(),
        profileId: mockDefaultBrowserProfile.id,
        url: url.trim() || 'about:blank',
        title: 'New Tab',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        viewport: 'responsive',
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
      browser.navigationId = crypto.randomUUID()
      mockBrowsers.set(id, browser)
      browserListeners.forEach((listener) => listener({ type: 'updated', browser: structuredClone(browser) }))
      return structuredClone(browser)
    },
    back: async (id) => structuredClone(requireMockBrowser(id)),
    forward: async (id) => structuredClone(requireMockBrowser(id)),
    reload: async (id) => {
      const browser = { ...requireMockBrowser(id), navigationId: crypto.randomUUID() }
      mockBrowsers.set(id, browser)
      return structuredClone(browser)
    },
    switchProfile: async (id, profileId) => {
      if (!mockBrowserProfiles.some((profile) => profile.id === profileId)) {
        throw new Error(`Unknown Browser Profile: ${profileId}`)
      }
      const browser = {
        ...requireMockBrowser(id),
        profileId,
        navigationId: crypto.randomUUID()
      }
      mockBrowsers.set(id, browser)
      browserListeners.forEach((listener) => listener({ type: 'updated', browser: structuredClone(browser) }))
      return structuredClone(browser)
    },
    listProfiles: async () => structuredClone(mockBrowserProfiles),
    createProfile: async (label) => {
      const profile: BrowserProfileSummary = {
        id: crypto.randomUUID(),
        label,
        createdAt: Date.now(),
        isDefault: false,
        source: null
      }
      mockBrowserProfiles = [...mockBrowserProfiles, profile]
      return structuredClone(profile)
    },
    deleteProfile: async (profileId) => {
      if ([...mockBrowsers.values()].some((browser) => browser.profileId === profileId)) {
        throw new Error('Browser Profile is still used by an open Browser')
      }
      mockBrowserProfiles = mockBrowserProfiles.filter((profile) => profile.id !== profileId)
    },
    detectProfileImportSources: async () => structuredClone(mockBrowserImportSources),
    importProfile: async (sourceToken, label) => {
      const source = mockBrowserImportSources.find((candidate) => candidate.token === sourceToken)
      mockBrowserImportSources = mockBrowserImportSources.filter((candidate) => candidate.token !== sourceToken)
      if (!source) throw new Error('Unknown or already consumed Browser Profile import source')
      const profile: BrowserProfileSummary = {
        id: crypto.randomUUID(),
        label,
        createdAt: Date.now(),
        isDefault: false,
        source: {
          browserLabel: source.browserLabel,
          profileLabel: source.profileLabel,
          importedAt: Date.now(),
          importedCookies: 0,
          skippedCookies: 0
        }
      }
      mockBrowserProfiles = [...mockBrowserProfiles, profile]
      return structuredClone(profile)
    },
    openDevTools: async () => {},
    setViewport: async (id, viewport: BrowserViewport) => {
      const current = requireMockBrowser(id)
      const browser = { ...current, viewport }
      mockBrowsers.set(id, browser)
      browserListeners.forEach((listener) => listener({ type: 'updated', browser: structuredClone(browser) }))
      return structuredClone(browser)
    },
    captureScreenshot: async (id) => ({
      browserId: id,
      navigationId: requireMockBrowser(id).navigationId,
      image: {
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${MOCK_SCREENSHOT_BASE64}`,
        width: 1,
        height: 1,
        byteLength: 70
      }
    }),
    selectElement: async () => null,
    cancelElementSelection: async () => {},
    setAnnotationMarkers: async () => {},
    setBounds: async () => {},
    release: async (id) => {
      // The preview has no native WebContentsView, but keeping the id in the mock map models the
      // same ownership boundary: release does not emit `closed` or remove the Renderer Region.
      if (!mockBrowsers.has(id)) return
    },
    restore: async (id, input) => {
      const current = mockBrowsers.get(id)
      if (!current) {
        const browser: BrowserSnapshot = {
          id,
          navigationId: crypto.randomUUID(),
          profileId: input.profileId,
          url: 'about:blank',
          title: 'New Tab',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          viewport: input.viewport,
          error: null
        }
        mockBrowsers.set(id, browser)
        browserListeners.forEach((listener) => listener({ type: 'updated', browser: structuredClone(browser) }))
        return structuredClone(browser)
      }
      const browser = {
        ...current,
        navigationId: crypto.randomUUID(),
        profileId: input.profileId,
        url: current.url,
        viewport: input.viewport
      }
      mockBrowsers.set(id, browser)
      browserListeners.forEach((listener) => listener({ type: 'updated', browser: structuredClone(browser) }))
      return structuredClone(browser)
    },
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
  const preload: AgentMuxPreloadApi = window.agentmux
  return {
    ...preload,
    control: createRendererControlApi(preload.control)
  }
}

export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()
