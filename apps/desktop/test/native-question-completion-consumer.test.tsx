// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { request as httpRequest } from 'node:http'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
const transport = vi.hoisted(() => ({
  terminals: [] as BrowserTerminal[], attach: vi.fn(), write: vi.fn(), detach: vi.fn(),
  resize: vi.fn(), acknowledge: vi.fn(), receive: null as ((event: RuntimeEvent) => void) | null
}))

// Real xterm parser, input emitter and production TerminalView; only its native canvas/DOM shell
// is scaffolded. No input/Agent/Run is sent to a real Runtime or user session by this fixture.
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    constructor(options: ConstructorParameters<typeof Terminal>[0]) {
      super(options)
      this.dispose = vi.fn(() => super.dispose())
      transport.terminals.push(this)
    }
    open(root: HTMLElement) { this.element = document.createElement('div'); this.element.className = 'xterm'; root.append(this.element) }
    refresh() {}
    focus() {}
    onRender = () => ({ dispose() {} })
    onSelectionChange = () => ({ dispose() {} })
    getSelection() { return '' }
    hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } }
} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } }
} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {
  activate() {} dispose() {} onContextLoss() { return { dispose() {} } }
} }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({
  TerminalViewportSynchronizer: class {
    beginReplay() {} endReplay() {} acceptOwnerSize() {} setInteractiveResize() {}
    setVisible() {} observeViewport() {} async startLiveSynchronization() {} dispose() {}
  }
}))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({
  TerminalContextMenu: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Original composer" /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/renderer/src/lib/api')>()
  return { api: { ...original.api, sessions: { ...original.api.sessions,
    attach: transport.attach, write: transport.write, detach: transport.detach,
    resize: transport.resize, acknowledge: transport.acknowledge,
    onEvent: (receive: (event: RuntimeEvent) => void) => {
      transport.receive = receive
      return () => { transport.receive = null }
    }
  } } }
})

import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'

const AGENT_ID = 'native-question-consumer'
const RUN_ID = 'native-question-consumer-run'
const questionInput = { questions: [{ question: 'Choose the next action', options: [{ label: 'First' }, { label: 'Second' }] }] }
const initialSession: SessionSnapshot = {
  id: AGENT_ID, hostId: 'local', workspacePath: '/synthetic', label: 'Synthetic question',
  createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  kind: 'agent', providerId: 'claude', executorId: 'claude',
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: AGENT_ID, run: { runId: RUN_ID } }
}

type NativeBinding = { endpoint: { url: string; token: string }; bindRun(runId: string): Promise<void> }
type ClientFixtureInternals = {
  connected: boolean
  registry: { load(hostId: string): Promise<void> }
  hookServer: { port: number; start(): Promise<unknown>; createBinding(agentId: string, providerId: string, bindingId: string, token: string): NativeBinding }
  kernel: { isConnected(): boolean; identity(): unknown; status(runId: string): Promise<unknown>; input(runId: string, operation: { expectedByte: number; data: string }): Promise<unknown> }
}
const baseline = useAppStore.getState()
let client: AgentMuxClient
let binding: NativeBinding
let root: Root
let unsubscribe: (() => void) | undefined
let releaseAck: (() => void) | undefined
let answer: Promise<void> | undefined
let acceptedInputBytes: number
let nativeWrites: string[]
let internals: ClientFixtureInternals

function run() {
  return { runId: RUN_ID, lifecycleOperationId: null, program: 'synthetic', args: [],
    workspacePath: '/synthetic', pid: 999, state: { type: 'running' as const }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks(); transport.terminals.length = 0; transport.receive = null
  acceptedInputBytes = 0; nativeWrites = []; releaseAck = undefined; answer = undefined
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: AGENT_ID, providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: '/synthetic', run: { runId: RUN_ID }, retiredRuns: [],
    hookBindingId: 'consumer-binding'.padEnd(43, 'A'), hookToken: 'consumer-token'.padEnd(43, 'B'),
     createdAt: 1, updatedAt: 1
  }
  await store.compareAndSwap(null, stored)
  client = new AgentMuxClient({ store })
  internals = client as unknown as ClientFixtureInternals
  await internals.registry.load('local')
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.identity = () => ({ daemonInstanceId: 'synthetic-owner', protocolVersion: 17, buildIdentity: 'synthetic' })
  internals.kernel.status = async () => run()
  internals.kernel.input = async (_runId, operation) => {
    nativeWrites.push(operation.data)
    acceptedInputBytes = operation.expectedByte + Buffer.byteLength(operation.data)
    return { run: run(), appliedByteRange: { startByte: operation.expectedByte, endByte: acceptedInputBytes } }
  }
  // The real production Hook server uses an isolated ephemeral TCP listener. It never connects
  // ctxmux or asks a Provider to launch/resume; authenticated ingress still reaches actual Client CAS.
  internals.hookServer.port = 0
  await internals.hookServer.start()
  binding = internals.hookServer.createBinding(AGENT_ID, 'claude', stored.hookBindingId, stored.hookToken)
  await binding.bindRun(RUN_ID)
  useAppStore.setState({ sessions: [initialSession], providerCatalog: client.catalog(),
    config: { appearance: { terminalTheme: 'graphite' }, executors: {}, workspaces: [] } as never,
    agentSteerQueues: {}, agentSteerInFlight: {}, agentComposerDrafts: {}, timelines: {}, loading: false
  })
  unsubscribe = client.onEvent((event) => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event }))
  const bytes = new TextEncoder().encode('same parser\x1b[31mR\x1b[0m')
  transport.attach.mockResolvedValue({ attachmentId: 'synthetic-view', currentSize: { cols: 80, rows: 24 }, gap: null,
    replay: [{ startByte: 0, endByte: bytes.byteLength, data: new TextDecoder().decode(bytes), dataBytes: bytes }] })
  transport.write.mockResolvedValue(undefined); transport.acknowledge.mockResolvedValue(undefined)
  transport.detach.mockResolvedValue(undefined); transport.resize.mockResolvedValue(undefined)
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<SessionPane sessionId={AGENT_ID} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />))
  await act(async () => await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalled()))
  expect(transport.terminals).toHaveLength(1)
  transport.write.mockClear(); transport.resize.mockClear(); transport.detach.mockClear()
})

afterEach(async () => {
  releaseAck?.(); await answer?.catch(() => {})
  unsubscribe?.(); unsubscribe = undefined
  await act(async () => root.unmount())
  await client.dispose()
  useAppStore.setState(baseline, true)
  document.body.replaceChildren(); vi.unstubAllGlobals()
})

async function hook(eventName: string, receiptId: string, callId: string, toolName = 'AskUserQuestion') {
  // Native Hook ingress is a Node-side HTTP sender, not a browser CORS request.
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(binding.endpoint.url, { method: 'POST',
      headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' }
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)) })
    request.on('error', reject)
    request.setTimeout(5_000, () => request.destroy(new Error('Isolated native Hook request timed out.')))
    request.end(JSON.stringify({ receiptId, eventName, payload: { tool_name: toolName, tool_use_id: callId,
      tool_input: questionInput, ...(eventName === 'PostToolUse' ? { tool_response: 'native question ended' } : {}) } }))
  })
}
function terminal() { expect(transport.terminals).toHaveLength(1); return transport.terminals[0]! }
async function input(value: string) { await act(async () => terminal().input(value, true)) }
function expectSameTerminal(instance: BrowserTerminal) {
  expect(transport.terminals).toEqual([instance]); expect(instance.dispose).not.toHaveBeenCalled()
  expect(instance.buffer.active.getLine(0)?.translateToString(true)).toBe('same parserR')
  expect(instance.buffer.active.getLine(0)?.getCell(11)?.getFgColor()).toBe(1)
  expect(transport.attach).toHaveBeenCalledOnce(); expect(transport.detach).not.toHaveBeenCalled()
  expect(transport.resize).not.toHaveBeenCalled()
}

it('public native Hook settlement removes the mounted card and reopens the same terminal only for the matched question', async () => {
  const instance = terminal()
  await act(async () => expect(await hook('PreToolUse', 'pre-1', 'call-1')).toBe(204))
  expect(document.querySelector('[aria-label="Agent question"]')).not.toBeNull()
  expect(useAppStore.getState().sessions[0]!.kind).toBe('agent')
  await input('blocked before completion'); expect(transport.write).not.toHaveBeenCalled()
  await act(async () => expect(await hook('PostToolUse', 'wrong-post', 'other-call')).toBe(204))
  expect(document.querySelector('[aria-label="Agent question"]')).not.toBeNull()
  await input('still blocked'); expect(transport.write).not.toHaveBeenCalled()
  await act(async () => expect(await hook('PostToolUse', 'post-1', 'call-1')).toBe(204))
  expect(document.querySelector('[aria-label="Agent question"]')).toBeNull()
  expect(client.agentSession(AGENT_ID).pendingInteraction).toBeUndefined()
  expect(nativeWrites).toEqual([])
  await input('healthy after native completion')
  expect(transport.write).toHaveBeenCalledExactlyOnceWith(initialSession.control, 'healthy after native completion')
  expectSameTerminal(instance)
  transport.write.mockClear()
  await act(async () => expect(await hook('PreToolUse', 'pre-2', 'call-2')).toBe(204))
  await act(async () => expect(await hook('PostToolUse', 'old-post-again', 'call-1')).toBe(204))
  expect(client.agentSession(AGENT_ID).pendingInteraction?.request.id).toBe('pre-2')
  expect(document.querySelector('[aria-label="Agent question"]')).not.toBeNull()
  await input('not the second question answer'); expect(transport.write).not.toHaveBeenCalled()
  expectSameTerminal(instance)
})

it('working and question completion never release the mounted raw pending permission gate', async () => {
  const instance = terminal()
  await act(async () => expect(await hook('PermissionRequest', 'permission-1', 'permission-call', 'Bash')).toBe(204))
  expect(document.querySelector('[aria-label="Agent permission request"]')).not.toBeNull()
  await act(async () => expect(await hook('PostToolUse', 'question-post', 'permission-call')).toBe(204))
  expect(client.agentSession(AGENT_ID).pendingInteraction?.request).toMatchObject({ kind: 'permission', id: 'permission-1' })
  expect(document.querySelector('[aria-label="Agent permission request"]')).not.toBeNull()
  await input('permission remains card-only')
  expect(transport.write).not.toHaveBeenCalled(); expect(nativeWrites).toEqual([])
  expectSameTerminal(instance)
})

it('a native Post preserves a claimed answer until its original full ACK settles through the existing owner', async () => {
  const instance = terminal()
  await act(async () => expect(await hook('PreToolUse', 'claimed-pre', 'claimed-call')).toBe(204))
  let entered!: () => void
  const inputEntered = new Promise<void>((resolve) => { entered = resolve })
  const ack = new Promise<void>((resolve) => { releaseAck = resolve })
  internals.kernel.input = async (_runId, operation) => {
    nativeWrites.push(operation.data)
    acceptedInputBytes = operation.expectedByte + Buffer.byteLength(operation.data)
    entered(); await ack
    return { run: run(), appliedByteRange: { startByte: operation.expectedByte, endByte: acceptedInputBytes } }
  }
  await act(async () => {
    answer = client.respondAgentInteraction({ agentSessionId: AGENT_ID, expectedRun: { runId: RUN_ID },
      response: { kind: 'question', requestId: 'claimed-pre', outcome: 'answered',
        answers: [{ questionId: 'question-1', optionId: 'option-1' }] } })
    await inputEntered
  })
  const claim = structuredClone(client.agentSession(AGENT_ID).pendingInteraction)
  expect(claim?.response).toMatchObject({ acknowledged: false, inputByteRange: { startByte: 0, endByte: 1 } })
  await act(async () => expect(await hook('PostToolUse', 'claimed-post', 'claimed-call')).toBe(204))
  expect(client.agentSession(AGENT_ID).pendingInteraction).toEqual(claim)
  expect(document.querySelector('[aria-label="Agent question"]')).not.toBeNull()
  await input('claimed gate remains'); expect(transport.write).not.toHaveBeenCalled()
  await act(async () => expect(await hook('PreToolUse', 'early-next', 'next-call')).toBe(503))
  expect(client.agentSession(AGENT_ID).pendingInteraction).toEqual(claim)
  await act(async () => { releaseAck!(); await answer })
  expect(client.agentSession(AGENT_ID).pendingInteraction).toBeUndefined()
  expect(document.querySelector('[aria-label="Agent question"]')).toBeNull()
  expect(nativeWrites).toEqual(['1'])
  await input('healthy after typed ACK')
  expect(transport.write).toHaveBeenCalledExactlyOnceWith(initialSession.control, 'healthy after typed ACK')
  transport.write.mockClear()
  await act(async () => expect(await hook('PreToolUse', 'next-after-ack', 'next-call')).toBe(204))
  expect(client.agentSession(AGENT_ID).pendingInteraction?.request.id).toBe('next-after-ack')
  expect(document.querySelector('[aria-label="Agent question"]')).not.toBeNull()
  expectSameTerminal(instance)
})
