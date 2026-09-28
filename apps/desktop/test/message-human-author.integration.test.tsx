// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgentMuxClient,
  AgentMuxError,
  AgentMuxFileAgentSessionStore,
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  agentPromptCondition,
  projectSessionUserMessages,
  type AgentMuxStoredAgentSession,
  type AgentTimelineItem,
  type AgentSessionUserMessage
} from '@agentmux/core'
import type { AgentMuxPreloadApi, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { assertManualPromptSenderTrusted } from '../src/main/ipc-sender-trust'
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

const { fakeTrustedSender, fakeUntrustedSender, bridge } = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  const createSender = (id: number) => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const removeListener = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      const list = listeners.get(event)
      if (list) listeners.set(event, list.filter(l => l !== fn))
    })
    return {
      id,
      isDestroyed: () => false,
      send: vi.fn(),
      session: { flushStorageData: vi.fn(), getStoragePath: vi.fn(() => '/tmp/desktop-human-author-bootstrap') },
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
      }),
      once: vi.fn(),
      off: removeListener,
      removeListener,
      emit: (event: string, ...args: unknown[]) => {
        const list = listeners.get(event)
        if (list) for (const fn of list) fn(...args)
      }
    }
  }
  const trusted = createSender(772)
  const untrusted = createSender(999)
  return {
    fakeTrustedSender: trusted,
    fakeUntrustedSender: untrusted,
    bridge: {
      api: null as AgentMuxPreloadApi | null,
      handlers: new Map<string, (...args: unknown[]) => unknown>(),
      lastSender: trusted as unknown
    }
  }
})

const fakeWindow = {
  webContents: fakeTrustedSender,
  isDestroyed: () => false
}

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, exposedApi: AgentMuxPreloadApi) => {
      bridge.api = exposedApi
      Object.assign(window, { [name]: exposedApi, api: exposedApi })
    }
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error(`No IPC handler registered for: ${channel}`)
      const event = { sender: bridge.lastSender }
      return handler(event, ...args)
    },
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn()
  },
  webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => fakeTrustedSender.session.getStoragePath() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      bridge.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      bridge.handlers.delete(channel)
    },
    on: vi.fn(),
    removeListener: vi.fn()
  },
  clipboard: {},
  dialog: {},
  nativeImage: {},
  shell: {}
}))

vi.mock('@agentmux/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentmux/core')>()),
  AgentMuxControlServer: class {
    async start() {}
    async stop() {}
  }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({
  BrowserProfileManager: class {
    async initialize() {}
    async dispose() {}
  }
}))
vi.mock('../src/main/browser-operation-journal', () => ({
  BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json',
  BrowserOperationFileStore: class {},
  BrowserOperationJournal: class {
    async ready() {}
  }
}))
vi.mock('../src/main/browser-ref-ledger-store', () => ({
  BrowserRefLedgerStore: class {}
}))
vi.mock('../src/main/browser-view-manager', () => ({
  BrowserViewManager: class {
    dispose() {}
  }
}))
vi.mock('../src/main/agent-notifier', () => ({
  createAgentNotifier: () => ({ dispose() {} })
}))

import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { speakerOf, speakerOfUserMessage, createSpeakerResolver } from '../src/renderer/src/lib/conversation-speaker'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage'

const SESSION_ID = 'test-author-session'
const RUN_ID = `run-${SESSION_ID}`

function createStoredSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: SESSION_ID,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo/test',
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-human-author',
    hookToken: 'token-human-author',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now() }
  }
}

function runProjection(acceptedInputBytes: number) {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
    args: [] as string[],
    workspacePath: '/repo/test',
    pid: 8888,
    state: { type: 'running' as const },
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

describe('T041 Desktop Human Message Author vertical slice', () => {
  let tempDir: string
  let storeFile: string
  let client: AgentMuxClient
  let runtime: RuntimeController
  let disposeIpc: (() => Promise<void>) | undefined
  let disposeStore: (() => void) | undefined
  let container: HTMLDivElement
  let root: Root
  let writes: string[]
  let pauseTarget: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    bridge.lastSender = fakeTrustedSender
    writes = []

    tempDir = await mkdtemp(join(tmpdir(), 'desktop-author-test-'))
    storeFile = join(tempDir, 'sessions.json')
    fakeTrustedSender.session.getStoragePath.mockReturnValue(tempDir)
    await mkdir(join(tempDir, 'Local Storage', 'leveldb'), { recursive: true })

    const fileStore = new AgentMuxFileAgentSessionStore(storeFile)
    await fileStore.compareAndSwap(null, createStoredSession())

    client = new AgentMuxClient({ store: fileStore })
    const state = client as unknown as {
      registry: { load(host: string): Promise<void> }
      connected: boolean
      kernel: Record<string, unknown>
    }
    await state.registry.load('local')
    state.connected = true

    let cursor = 0
    state.kernel.isConnected = () => true
    state.kernel.identity = () => ({
      daemonInstanceId: 'daemon-test',
      protocolVersion: 1,
      buildIdentity: 'test'
    })
    state.kernel.status = async () => runProjection(cursor)
    state.kernel.input = async (_runId: string, operation: { expectedByte: number; data: string }) => {
      writes.push(operation.data)
      cursor = operation.expectedByte + Buffer.byteLength(operation.data)
      return {
        run: runProjection(cursor),
        appliedByteRange: { startByte: operation.expectedByte, endByte: cursor }
      }
    }
    vi.spyOn((client as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(120)

    runtime = new RuntimeController(fileStore as never)
    runtime.commit({
      hosts: [{ id: 'local', client, executionHost: { kind: 'local', dispose: vi.fn() } as never }],
      removedHostIds: [],
      reservedHostIds: [],
      hostSignatures: new Map()
    })
    vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })

    pauseTarget = vi.fn().mockResolvedValue(undefined)
    const progressLoops = {
      pauseTarget,
      subscribe: vi.fn(() => () => {})
    } as unknown as Parameters<typeof registerIpc>[0]['progressLoops']

    const configStore = {
      get: async () => DEFAULT_CONFIG,
      validate: (c: AppConfig) => c,
      save: async () => {}
    } as unknown as Parameters<typeof registerIpc>[0]['configStore']

    disposeIpc = await registerIpc({
      window: fakeWindow as unknown as Parameters<typeof registerIpc>[0]['window'],
      configStore,
      runtime,
      progressLoops,
      scratchTopics: { ready: async () => {} } as unknown as Parameters<typeof registerIpc>[0]['scratchTopics'],
      workspaceFiles: { dispose: async () => {} } as unknown as NonNullable<Parameters<typeof registerIpc>[0]['workspaceFiles']>
    })

    const sessionSnapshot: Extract<SessionSnapshot, { kind: 'agent' }> = {
      id: SESSION_ID,
      kind: 'agent',
      providerId: 'codex',
      executorId: 'codex',
      hostId: 'local',
      workspacePath: '/repo/test',
      promptSubmissionPredecessor: null,
      agentSessionUpdatedAt: Date.now(),
      label: 'Codex Agent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      latestOutputBytes: 0,
      processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: Date.now() },
      capabilities: {
        terminal: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        replyCorrelation: 'none'
      },
      control: {
        kind: 'agent',
        hostId: 'local',
        agentSessionId: SESSION_ID,
        run: { runId: RUN_ID }
      }
    }

    vi.spyOn(api.config, 'get').mockResolvedValue(DEFAULT_CONFIG)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [sessionSnapshot], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.demands, 'list').mockResolvedValue([])
    disposeStore = await useAppStore.getState().initialize()

    vi.spyOn(api.sessions, 'refresh').mockImplementation(async (control) => {
      if (control.kind !== 'agent') throw new Error('Expected an Agent control')
      const found = useAppStore.getState().sessions.find((item) => item.id === control.agentSessionId)
      if (!found) throw new Error('Session not found')
      return { ...found, promptSubmissionPredecessor: agentPromptCondition(client.agentSession(control.agentSessionId)).afterSubmissionId }
    })

    useAppStore.setState({
      config: DEFAULT_CONFIG,
      sessions: [sessionSnapshot],
      agentNames: {},
      agentComposerDrafts: {},
      agentSteerQueues: {},
      agentSteerInFlight: {},
      error: null
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (process.env.T041_RECEIPT_DIR) {
      const timeline = await new AgentMuxFileAgentSessionStore(storeFile).loadTimeline(SESSION_ID)
      const directory = process.env.T041_RECEIPT_DIR
      await mkdir(directory, { recursive: true })
      const testName = expect.getState().currentTestName!.replace(/[^a-zA-Z0-9]+/g, '-').slice(0,180)
      await writeFile(join(directory, `${testName}.json`), JSON.stringify({ timeline,
        messages: projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline }), writes }, null, 2))
    }
    if (root) {
      await act(async () => {
        root.unmount()
      })
    }
    container?.remove()
    disposeStore?.()
    disposeStore = undefined
    if (disposeIpc) await disposeIpc()
    await client.dispose()
    await rm(tempDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('Composer submit() sets origin: manual, verifies sender trust, persists authorHuman to FileStore, and renders human + You', async () => {
    // 1. Mount Composer with draft
    await act(async () => {
      useAppStore.getState().setAgentComposerDraft(SESSION_ID, 'Human prompt from composer')
    })
    await act(async () => {
      root.render(<AgentSessionComposer sessionId={SESSION_ID} />)
    })

    // 2. Submit from Composer UI (Click Send button)
    const sendBtn = container.querySelector<HTMLButtonElement>('button.composer-send')
    expect(sendBtn).not.toBeNull()
    await act(async () => {
      sendBtn!.click()
    })

    // 3. Drain the steer queue through Main IPC to Core
    await act(async () => {
      await useAppStore.getState().flushAgentSteerQueue(SESSION_ID)
    })

    // 4. Verify input written
    expect(writes.length).toBeGreaterThan(0)
    expect(writes[0]).toContain('Human prompt from composer')

    // 5. Verify Core FileStore receipt: re-read from fresh FileStore instance
    const freshStore = new AgentMuxFileAgentSessionStore(storeFile)
    const timeline = await freshStore.loadTimeline(SESSION_ID)
    expect(timeline).toBeDefined()
    const promptItem = timeline.items.find((i) => i.kind === 'user_message')
    expect(promptItem).toBeDefined()
    expect(promptItem!.authorHuman).toBe(true)
    expect(promptItem!.authorAgentSessionId).toBeUndefined()

    // 6. Verify public projector maps author to human
    const userMessages = projectSessionUserMessages({
      agentSessionId: SESSION_ID,
      timeline
    })
    expect(userMessages.length).toBeGreaterThan(0)
    const manualMsg = userMessages[0]!
    expect(manualMsg.author).toEqual({ kind: 'human' })

    // 7. Verify speaker resolver yields 'You'
    const speaker = speakerOfUserMessage(manualMsg)
    expect(speaker).toEqual({ role: 'human', id: 'human' })
    const describe = createSpeakerResolver()
    expect(describe(speaker)).toEqual({ name: 'You' })

    // 8. Verify DOM render: ConversationMessage renders role='human' and 'You'
    const domContainer = document.createElement('div')
    const domRoot = createRoot(domContainer)
    await act(async () => {
      domRoot.render(
        <ConversationMessage
          messageId={manualMsg.id}
          speaker={speaker}
          content={manualMsg.content}
          status="complete"
        />
      )
    })
    const logTurn = domContainer.querySelector('.log-turn')
    expect(logTurn?.getAttribute('data-speaker-role')).toBe('human')
    const who = domContainer.querySelector('.log-turn__who')
    expect(who?.textContent).toBe('You')
    await act(async () => {
      domRoot.unmount()
    })
    domContainer.remove()
  })

  it('actual Composer queue preserves its first origin through durable write, hydration and explicit retry', async () => {
    const held = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new AgentMuxError('Private admission held before input', 'AGENT_PROMPT_SUBMISSION_BUSY'))
    await act(async () => {
      useAppStore.getState().setAgentComposerDraft(SESSION_ID, 'Queued manual message')
      root.render(<AgentSessionComposer sessionId={SESSION_ID} />)
    })
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]')
    expect(editor).not.toBeNull()
    await act(async () => {
      editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await useAppStore.getState().flushAgentSteerQueue(SESSION_ID)
    })
    const manual = useAppStore.getState().agentSteerQueues[SESSION_ID]![0]!
    expect(manual).toMatchObject({ text: 'Queued manual message', origin: 'manual', runId: RUN_ID })
    expect(held).toHaveBeenCalledOnce()
    expect(writes).toEqual([])
    await act(async () => {
      expect(useAppStore.getState().enqueueAgentSteer(SESSION_ID, 'Old unknown message', undefined, 'old-unknown')).toBe(true)
      expect(useAppStore.getState().enqueueAgentSteer(SESSION_ID, 'Old unknown message', undefined, 'old-unknown', 'manual')).toBe(true)
      useAppStore.getState().moveAgentSteer(SESSION_ID, 'old-unknown', 'up')
      await prepareRendererUpdate()
    })
    const original = useAppStore.getState().agentSteerQueues[SESSION_ID]!
    expect(original.map(entry => [entry.operationId, entry.origin])).toEqual([
      ['old-unknown', undefined], [manual.operationId, 'manual']
    ])
    const serialized = window.localStorage.getItem('agentmux-workbench-v1')
    expect(serialized).toBeTypeOf('string')
    expect(JSON.parse(serialized!).state.agentSteerQueues[SESSION_ID]).toEqual(original)
    await act(async () => {
      useAppStore.setState({ agentSteerQueues: {} })
      await useAppStore.persist.rehydrate()
    })
    expect(useAppStore.getState().agentSteerQueues[SESSION_ID]).toEqual(original)
    disposeStore?.()
    await act(async () => {
      useAppStore.setState({ loading: true })
      disposeStore = await useAppStore.getState().initialize()
    })
    const restored = useAppStore.getState().agentSteerQueues[SESSION_ID]!
    expect(restored.map(entry => [entry.operationId, entry.origin, entry.status])).toEqual([
      ['old-unknown', undefined, 'deferred'], [manual.operationId, 'manual', 'deferred']
    ])
    expect(writes).toEqual([])
    held.mockRestore()
    await act(async () => {
      await useAppStore.getState().sendQueuedAgentSteer(SESSION_ID, 'old-unknown')
      await useAppStore.getState().sendQueuedAgentSteer(SESSION_ID, manual.operationId)
    })
    expect(writes).toEqual(['Old unknown message', '\r', 'Queued manual message', '\r'])
    const timeline = await new AgentMuxFileAgentSessionStore(storeFile).loadTimeline(SESSION_ID)
    expect(projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline }).map(message => [message.rawId, message.author])).toEqual([
      ['prompt:old-unknown', { kind: 'unknown' }], ['prompt:' + manual.operationId, { kind: 'human' }]
    ])
  })

  it('ordinary submit without an explicit source remains unknown', async () => {
    // 1. Programmatic submit without manual origin
    const operationId = 'programmatic-op-1'
    const condition = {
      expectedRun: { runId: RUN_ID },
      afterSubmissionId: null
    }

    await bridge.api!.sessions.submitPrompt(
      { kind: 'agent', hostId: 'local', agentSessionId: SESSION_ID, run: { runId: RUN_ID } },
      'Programmatic PMO prompt',
      operationId,
      condition,
      undefined, // authorAgentSessionId
      { allowUncertainTurn: true },
      false // authorHuman
    )

    const freshStore = new AgentMuxFileAgentSessionStore(storeFile)
    const timeline = await freshStore.loadTimeline(SESSION_ID)
    const item = timeline.items.find((i) => i.id === `prompt:${operationId}`)
    expect(item).toBeDefined()
    expect(item!.authorHuman).toBeUndefined()
    expect(item!.authorAgentSessionId).toBeUndefined()

    const msgs = projectSessionUserMessages({
      agentSessionId: SESSION_ID,
      timeline
    })
    const programmaticMsg = msgs.find((m) => m.rawId === `prompt:${operationId}`)!
    expect(programmaticMsg.author).toEqual({ kind: 'unknown' })

    const speaker = speakerOfUserMessage(programmaticMsg)
    expect(speaker).toEqual({ role: 'unknown', id: 'unknown' })
    const describe = createSpeakerResolver()
    expect(describe(speaker)).toEqual({ name: 'Input' })

    // DOM render: role='unknown', name='Input'
    const domContainer = document.createElement('div')
    const domRoot = createRoot(domContainer)
    await act(async () => {
      domRoot.render(
        <ConversationMessage
          messageId={programmaticMsg.id}
          speaker={speaker}
          content={programmaticMsg.content}
          status="complete"
        />
      )
    })
    expect(domContainer.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('unknown')
    expect(domContainer.querySelector('.log-turn__who')?.textContent).toContain('Input')
    await act(async () => {
      domRoot.unmount()
    })
    domContainer.remove()
  })

  it('Main IPC sender trust rejects untrusted sender claiming authorHuman, but allows plain unknown submit', async () => {
    const condition = {
      expectedRun: { runId: RUN_ID },
      afterSubmissionId: null
    }

    // Untrusted sender claiming authorHuman: MUST THROW
    pauseTarget.mockClear()
    bridge.lastSender = fakeUntrustedSender
    await expect(
      bridge.api!.sessions.submitPrompt(
        { kind: 'agent', hostId: 'local', agentSessionId: SESSION_ID, run: { runId: RUN_ID } },
        'Spoofed human prompt',
        'spoof-op-1',
        condition,
        undefined,
        { allowUncertainTurn: true },
        true // authorHuman: true from untrusted sender
      )
    ).rejects.toThrow('Untrusted manual prompt sender')
    expect(pauseTarget).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect((await new AgentMuxFileAgentSessionStore(storeFile).loadTimeline(SESSION_ID)).items).toEqual([])

    // Untrusted sender for ordinary unknown submit: MUST NOT BE BLOCKED
    await expect(
      bridge.api!.sessions.submitPrompt(
        { kind: 'agent', hostId: 'local', agentSessionId: SESSION_ID, run: { runId: RUN_ID } },
        'Normal submit from untrusted sender',
        'untrusted-ordinary-op-1',
        condition,
        undefined,
        { allowUncertainTurn: true },
        false // no authorHuman claim
      )
    ).resolves.not.toThrow()
  })

  it('Agent conflict preserves Agent author and does not upgrade to human', async () => {
    const condition = {
      expectedRun: { runId: RUN_ID },
      afterSubmissionId: null
    }

    // Trusted sender sends BOTH authorAgentSessionId and authorHuman: true
    bridge.lastSender = fakeTrustedSender
    await bridge.api!.sessions.submitPrompt(
      { kind: 'agent', hostId: 'local', agentSessionId: SESSION_ID, run: { runId: RUN_ID } },
      'Agent conflict prompt',
      'conflict-op-1',
      condition,
      'peer-agent-session-42',
      { allowUncertainTurn: true },
      true
    )

    const freshStore = new AgentMuxFileAgentSessionStore(storeFile)
    const timeline = await freshStore.loadTimeline(SESSION_ID)
    const item = timeline.items.find((i) => i.id === 'prompt:conflict-op-1')
    expect(item).toBeDefined()
    expect(item!.authorAgentSessionId).toBe('peer-agent-session-42')
    expect(item!.authorHuman).toBeUndefined()

    const msgs = projectSessionUserMessages({
      agentSessionId: SESSION_ID,
      timeline
    })
    const conflictMsg = msgs.find((m) => m.rawId === 'prompt:conflict-op-1')!
    expect(conflictMsg.author).toEqual({ kind: 'agent', agentSessionId: 'peer-agent-session-42' })

    const speaker = speakerOfUserMessage(conflictMsg)
    expect(speaker).toEqual({ role: 'agent', id: 'peer-agent-session-42' })
    const describe = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer-agent-session-42' ? { label: 'PeerAgent' } : undefined)
    })
    expect(describe(speaker)).toEqual({ name: 'PeerAgent' })

    // DOM render: role='agent', name='PeerAgent'
    const domContainer = document.createElement('div')
    const domRoot = createRoot(domContainer)
    await act(async () => {
      domRoot.render(
        <ConversationMessage
          messageId={conflictMsg.id}
          speaker={speaker}
          name="PeerAgent"
          content={conflictMsg.content}
          status="complete"
        />
      )
    })
    expect(domContainer.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('agent')
    expect(domContainer.querySelector('.log-turn__who')?.textContent).toBe('PeerAgent')
    await act(async () => {
      domRoot.unmount()
    })
    domContainer.remove()
  })

  it('renders all three distinct non-empty records in shared DOM: human+You, agent+name, unknown+Input', async () => {
    const records: Array<{
      author: AgentSessionUserMessage['author']
      expectedRole: string
      expectedName: string
      content: string
    }> = [
      { author: { kind: 'human' }, expectedRole: 'human', expectedName: 'You', content: 'Manual query' },
      { author: { kind: 'agent', agentSessionId: 'peer-agent' }, expectedRole: 'agent', expectedName: 'SubAgent Alpha', content: 'Agent prompt' },
      { author: { kind: 'unknown' }, expectedRole: 'unknown', expectedName: 'Input', content: 'Unknown input' }
    ]

    expect(records.length).toBe(3)

    const domContainer = document.createElement('div')
    const domRoot = createRoot(domContainer)

    const describe = createSpeakerResolver({
      lookupAgent: (id) => (id === 'peer-agent' ? { label: 'SubAgent Alpha' } : undefined)
    })

    for (const rec of records) {
      const msg: AgentSessionUserMessage = {
        id: `test-msg-${rec.expectedRole}`,
        rawId: `raw-${rec.expectedRole}`,
        agentSessionId: SESSION_ID,
        source: { kind: 'captured', submissionId: `sub-${rec.expectedRole}` },
        author: rec.author,
        content: rec.content,
        contentParts: [{ kind: 'text', text: rec.content }]
      }

      const speaker = speakerOfUserMessage(msg)
      expect(speaker.role).toBe(rec.expectedRole)
      const desc = describe(speaker)
      expect(desc.name).toBe(rec.expectedName)

      await act(async () => {
        domRoot.render(
          <ConversationMessage
            messageId={msg.id}
            speaker={speaker}
            name={desc.name}
            content={msg.content}
            status="complete"
          />
        )
      })

      const turn = domContainer.querySelector('.log-turn')
      expect(turn?.getAttribute('data-speaker-role')).toBe(rec.expectedRole)
      const who = domContainer.querySelector('.log-turn__who')
      expect(who?.textContent).toBe(rec.expectedName)
      const authorNote = domContainer.querySelector('[role="note"]')
      if (rec.expectedRole === 'unknown') expect(authorNote?.textContent).toBe('作者未记录')
      else expect(authorNote).toBeNull()
    }

    await act(async () => {
      domRoot.unmount()
    })
    domContainer.remove()
  })

  it('actual openGoalPmo caller sends an unattributed task through the original queue and Main', async () => {
    const goal = { id: 'private-goal', title: 'Private goal', description: 'Keep task origin unknown',
      status: 'backlog' as const, priority: 'normal' as const, projectId: null, projectName: null,
      sessionIds: [], createdAt: 1, updatedAt: 1, source: 'default-topic' as const }
    const tab = { ...createWorkbenchTab('private-pmo-tab', { regionId: 'private-pmo-region', kind: 'agent',
      phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: SESSION_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    const navigation = vi.spyOn(useAppStore.getState(), 'openScratchTopic').mockResolvedValue(undefined)
    useAppStore.setState({ config: { ...DEFAULT_CONFIG, workspaces: [{ id: SCRATCH_WORKSPACE_ID,
      name: 'Private Scratch', hostId: 'local', path: '/scratch', kind: 'folder' }] },
      demands: { [goal.id]: goal }, demandPmoTabIds: { [goal.id]: tab.id }, tabs: { [tab.id]: tab },
      layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('private-pmo-group', [tab.id]) } })
    await useAppStore.getState().requestDemandPmoTask(goal.id, 'grill')
    await useAppStore.getState().flushAgentSteerQueue(SESSION_ID)
    expect(navigation).toHaveBeenCalledOnce()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe('\r')
    expect(writes[0]).toContain('Grill:')
    const timeline = await new AgentMuxFileAgentSessionStore(storeFile).loadTimeline(SESSION_ID)
    expect(projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline }).map(message => message.author))
      .toEqual([{ kind: 'unknown' }])
  })

  it('actual demand.start control admits an unknown prompt through the original queue and Main', async () => {
    const goal = { id: 'private-control-goal', title: 'Private control goal', description: 'Start this explicit non-human task',
      status: 'backlog' as const, priority: 'normal' as const, projectId: null, projectName: null,
      sessionIds: [], createdAt: 1, updatedAt: 1, source: 'default-topic' as const }
    useAppStore.setState({ demands: { [goal.id]: goal } })
    // Only unrelated Goal metadata persistence is isolated. executeControl/startDemand,
    // admission, queue drain, Main, Runtime, public Core and FileStore remain actual.
    vi.spyOn(useAppStore.getState(), 'updateDemand').mockImplementation(async (id, patch) => {
      expect(Object.keys(patch).every(key => key === 'status' || key === 'activityLog')).toBe(true)
      expect(Object.keys(patch).length).toBeGreaterThan(0)
      useAppStore.setState(state => ({ demands: { ...state.demands, [id]: {
        ...state.demands[id]!,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.activityLog === undefined ? {} : { activityLog: patch.activityLog })
      } } }))
    })
    const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'control-demand-start', operation: 'demand.start', demandId: goal.id, sessionId: SESSION_ID })
    expect(result.operation).toBe('demand.start')
    expect(writes).toEqual([goal.description, '\r'])
    const timeline = await new AgentMuxFileAgentSessionStore(storeFile).loadTimeline(SESSION_ID)
    expect(projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline }).map(message => [message.content, message.author]))
      .toEqual([[goal.description, { kind: 'unknown' }]])
  })

  it('actual control send without caller stays unknown and a known Agent caller remains Agent', async () => {
    for (const [operationId, caller] of [['control-unknown', undefined], ['control-agent', 'peer-control-agent']] as const) {
      await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: operationId, operation: 'send', target: { kind: 'agent-session', agentSessionId: SESSION_ID },
        text: operationId, promptCondition: agentPromptCondition(client.agentSession(SESSION_ID)),
        ...(caller ? { caller: { agentSessionId: caller } } : {}) })
    }
    expect(writes).toEqual(['control-unknown', '\r', 'control-agent', '\r'])
    const timeline = await new AgentMuxFileAgentSessionStore(storeFile).loadTimeline(SESSION_ID)
    expect(projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline }).map(message => message.author))
      .toEqual([{ kind: 'unknown' }, { kind: 'agent', agentSessionId: 'peer-control-agent' }])
  })

  it('actual continuous-progress delivery produces an accepted unknown receipt', async () => {
    const fileStore = new AgentMuxFileAgentSessionStore(storeFile)
    const loaded = await fileStore.load()
    expect(loaded).toHaveLength(1)
    const previous = loaded[0] as AgentMuxStoredAgentSession
    const observedAt = Date.now()
    await fileStore.compareAndSwap(previous!, { ...previous!, updatedAt: observedAt, semanticStatus: {
      state: 'done', source: 'native-hook', observedAt } })
    await (client as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')
    const completionId = JSON.stringify([RUN_ID, observedAt])
    const disposeObserver = runtime.setContinuousProgressInputObserver(async () => false)
    const submit = vi.spyOn(runtime, 'submitPrompt')
    const operationId = 'private-continuous-op'
    try {
      expect(await deliverContinuousProgress(runtime, {
        loopId: 'private-loop', hostId: 'local', agentSessionId: SESSION_ID, providerId: 'codex',
        workspacePath: '/repo/test', intervalMs: 10, prompt: 'Private automatic prompt', nextCheckAt: 0, status: 'active',
        pendingCompletion: { id: completionId, operationId, inputByte: 0,
          condition: agentPromptCondition(client.agentSession(SESSION_ID)) }
      }, operationId, () => true, new AbortController().signal)).toBe('sent')
    } finally { disposeObserver() }
    expect(submit).toHaveBeenCalledOnce()
    expect(submit.mock.calls[0]!.slice(5)).toEqual([])
    expect(writes).toEqual(['Private automatic prompt', '\r'])
    const timeline = await fileStore.loadTimeline(SESSION_ID)
    expect(projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline }).map(message => message.author))
      .toEqual([{ kind: 'unknown' }])
  })

  it('an empty Agent field plus Human claim is accepted as unknown through actual Main', async () => {
    await bridge.api!.sessions.submitPrompt({ kind: 'agent', hostId: 'local', agentSessionId: SESSION_ID,
      run: { runId: RUN_ID } }, 'Empty author conflict', 'empty-conflict', agentPromptCondition(client.agentSession(SESSION_ID)),
      '', { allowUncertainTurn: true }, true)
    expect(writes).toEqual(['Empty author conflict', '\r'])
    const timeline = await new AgentMuxFileAgentSessionStore(storeFile).loadTimeline(SESSION_ID)
    expect(projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline }).map(message => message.author))
      .toEqual([{ kind: 'unknown' }])
  })

  it('assertManualPromptSenderTrusted throws on untrusted sender and succeeds on trusted sender', () => {
    const trusted = { id: 'win' }
    const untrusted = { id: 'bad' }
    expect(() => assertManualPromptSenderTrusted(trusted, trusted)).not.toThrow()
    expect(() => assertManualPromptSenderTrusted(untrusted, trusted)).toThrow('Untrusted manual prompt sender')
  })
})
