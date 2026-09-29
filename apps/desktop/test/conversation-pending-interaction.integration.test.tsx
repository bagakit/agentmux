// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { request as httpRequest } from 'node:http'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-isolated-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Original composer" /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { useAppStore } from '../src/renderer/src/store'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { openAgentHistory } from './helpers/agent-history-menu'

const AGENT_ID = 'interaction-intake'
const RUN_ID = 'interaction-intake-run'
const initialSession: Extract<SessionSnapshot, {kind: 'agent'}> = {
  id: AGENT_ID, kind: 'agent', hostId: 'local', workspacePath: '/isolated', label: 'Private observation',
  createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
  processState: 'running', latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  providerId: 'claude', executorId: 'claude',
  capabilities: {terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none'},
  control: {kind: 'agent', hostId: 'local', agentSessionId: AGENT_ID, run: {runId: RUN_ID}}
}
type NativeBinding = {endpoint: {url: string; token: string}; bindRun(runId: string): Promise<void>}
type ControlledCore = {
  connected: boolean
  registry: {load(hostId: string): Promise<void>}
  hookServer: {port: number; start(): Promise<unknown>; createBinding(agentId: string, providerId: string, id: string, token: string): NativeBinding}
  kernel: {isConnected(): boolean; identity(): unknown; status(runId: string): Promise<unknown>; input(runId: string, input: {expectedByte: number; data: string}): Promise<unknown>}
}
const originalState = useAppStore.getState()
let client: AgentMuxClient
let binding: NativeBinding
let root: Root
let container: HTMLDivElement
let unsubscribe: (() => void) | undefined
let acceptedInputBytes = 0
let nativeWrites: string[] = []
function controlledRun() {return {runId: RUN_ID, lifecycleOperationId: null, program: 'isolated', args: [], workspacePath: '/isolated', pid: 991, state: {type: 'running'}, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes}}
async function observeProvider(providerId: 'claude' | 'codex') {
  acceptedInputBytes = 0; nativeWrites = []
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = {kind: 'agent', agentSessionId: AGENT_ID, providerId, executorId: providerId, hostId: 'local', workspacePath: '/isolated', run: {runId: RUN_ID}, retiredRuns: [], hookBindingId: 'intake-binding'.padEnd(43, 'A'), hookToken: 'intake-token'.padEnd(43, 'B'), createdAt: 1, updatedAt: 1}
  await store.compareAndSwap(null, stored)
  client = new AgentMuxClient({store})
  const controlled = client as unknown as ControlledCore
  await controlled.registry.load('local')
  controlled.connected = true
  controlled.kernel.isConnected = () => true
  controlled.kernel.identity = () => ({daemonInstanceId: 'isolated-owner', protocolVersion: 18, buildIdentity: 'isolated'})
  controlled.kernel.status = async () => controlledRun()
  controlled.kernel.input = async (_runId, input) => {
    nativeWrites.push(input.data)
    acceptedInputBytes = input.expectedByte + Buffer.byteLength(input.data)
    return {run: controlledRun(), appliedByteRange: {startByte: input.expectedByte, endByte: acceptedInputBytes}}
  }
  controlled.hookServer.port = 0
  await controlled.hookServer.start()
  binding = controlled.hookServer.createBinding(AGENT_ID, providerId, stored.hookBindingId, stored.hookToken)
  await binding.bindRun(RUN_ID)
  useAppStore.setState({sessions: [{...initialSession,providerId,executorId:providerId}], providerCatalog: client.catalog(), config: {version: 9, hosts: [{id: 'local', kind: 'local', label: 'Private'}], executors: {}, workspaces: [{id: 'ws', name: 'Private', hostId: 'local', path: '/isolated', kind: 'folder'}], appearance: {terminalTheme: 'graphite'}, browser: {toolbar: {selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true}}}, viewModes: {[AGENT_ID]: 'activity'}, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], agentComposerDrafts: {[AGENT_ID]: 'Unsent original draft'}, agentSteerQueues: {}, timelines: {}, loading: false})
  unsubscribe = client.onEvent(event => useAppStore.getState().applyEvent({type: 'core', hostId: 'local', event}))
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await observeProvider('claude')
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({agentSessionId: AGENT_ID, source: {providerId: 'claude', nativeSessionId: 'controlled-transcript'}, items: [{id: 'user-1', kind: 'user-message', contentParts: [{kind: 'text', text: 'Original native message'}]}], nextCursor: null})
  vi.spyOn(api.sessions, 'respondInteraction').mockImplementation(async (control, response) => await client.respondAgentInteraction({agentSessionId: control.agentSessionId, expectedRun: control.run, response}))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  unsubscribe?.(); await client?.dispose()
  container?.remove(); useAppStore.setState(originalState, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function ingress(receiptId = 'question-1', questions: unknown[] = [{question: 'Choose the next action', options: [{label: 'First'}, {label: 'Second'}]}], toolName = 'AskUserQuestion', eventName = 'PreToolUse') {
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(binding.endpoint.url, {method: 'POST', headers: {authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json'}}, response => {response.resume(); response.on('end', () => resolve(response.statusCode!))})
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('Private Hook timeout')))
    request.end(JSON.stringify({receiptId, eventName, payload: {tool_name: toolName, tool_use_id: 'call-1', tool_input: {questions}}}))
  })
  expect(status).toBe(204)
  expect(client.agentSession(AGENT_ID).pendingInteraction?.request.id).toBe(receiptId)
  expect(useAppStore.getState().sessions[0]?.kind).toBe('agent')
}
async function mount(readOnly = false, visible = true) {await act(async () => root.render(<SessionPane sessionId={AGENT_ID} surfaceKind="agent" interactiveResize={false} visible={visible} readOnly={readOnly} linkOrigin={{workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region'}} />))}
function recordScene(name:string){
  const directory=process.env.AGENTMUX_PENDING_INTERACTION_SCENE_ROOT
  if(!directory)return
  const state=useAppStore.getState(),session=state.sessions[0]
  expect(session?.kind).toBe('agent')
  if(session?.kind!=='agent'||!session.pendingInteraction)throw new Error('Actual producer snapshot required')
  mkdirSync(directory,{recursive:true})
  writeFileSync(resolve(directory,`${name}.json`),`${JSON.stringify({schema:'agentmux.current-request-scene-input.v1',boundary:'Authenticated private Hook/public Core/MemoryStore/publication; controlled byte owner, not vendor Writer',session,config:state.config,providerCatalog:state.providerCatalog,originalDraft:state.agentComposerDrafts[AGENT_ID]},null,2)}\n`)
}
it('current card is genuinely connected to real producer and typed Core answer', async () => {
  await act(async () => ingress()); await mount()
  expect(container.querySelectorAll('.agent-interaction')).toHaveLength(1)
  expect(container.querySelector('.agent-body > .agent-interaction')?.textContent).toContain('Choose the next action')
  const options = [...container.querySelectorAll<HTMLButtonElement>('.agent-interaction__options button')]
  expect(options.map(one => one.textContent)).toEqual(['First', 'Second'])
  await act(async () => options[1]!.click())
  expect(nativeWrites).toEqual(['2'])
  expect(client.agentSession(AGENT_ID).pendingInteraction).toBeUndefined()
  expect(container.querySelectorAll('.agent-interaction')).toHaveLength(0)
  expect(useAppStore.getState().agentComposerDrafts[AGENT_ID]).toBe('Unsent original draft')
})
it('pending choices appear within the conversation reading surface', async () => {
  await act(async () => ingress('question-1',[{header:'Implementation review',question:'Before changing the retained Session, choose how you want the Agent to proceed. Your original conversation, terminal and unsent draft stay available while this question is waiting for an answer.',options:[{label:'Apply the focused change and verify it',description:'Keep the current scope, preserve existing work, and report the exact result before considering any broader change.'},{label:'Review the current proposal first',description:'Explain the alternatives and affected behavior before making a decision.'}]}])); await mount()
  recordScene('question')
  const body = container.querySelector('.activity-feed')
  expect(body).not.toBeNull()
  expect(body!.textContent).toContain('Original native message')
  expect(container.querySelector('.agent-body > [data-request-id="question-1"]')).not.toBeNull()
  expect(container.querySelector('.agent-input-stack .agent-interaction')).toBeNull()
  expect(container.querySelector('.agent-interaction__status')?.textContent).toBe('Needs your answer')
})
it('Codex uses its real request_user_input producer and the same typed conversation consumer', async () => {
  unsubscribe?.(); await client.dispose(); await observeProvider('codex')
  await act(async () => ingress('codex-question', undefined, 'request_user_input')); await mount()
  const options = [...container.querySelectorAll<HTMLButtonElement>('.agent-interaction__options button')]
  expect(options.map(one => one.textContent)).toEqual(['First','Second'])
  await act(async () => options[1]!.click())
  expect(nativeWrites).toEqual(['2'])
  expect(container.querySelector('.agent-interaction')).toBeNull()
})
it('a readonly conversation can observe the current request without sending an answer', async () => {
  await act(async () => ingress()); await mount(true)
  expect(container.querySelector('.activity-feed')?.textContent).toContain('Original native message')
  const request = container.querySelector('[data-request-id="question-1"]')
  expect(request).not.toBeNull()
  expect(request!.textContent).toContain('Read-only')
  const buttons = [...request!.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons).toHaveLength(3)
  expect(buttons.map(one => one.disabled)).toEqual([true,true,true])
  await act(async () => buttons[0]!.click())
  expect(api.sessions.respondInteraction).not.toHaveBeenCalled()
  expect(nativeWrites).toEqual([])
})
it('unsupported multi-question shape reaches the original terminal instruction rather than fake choices', async () => {
  await act(async () => ingress('unsupported-1', [{question: 'First question', options: ['One', 'Two']}, {question: 'Second question', options: ['Three', 'Four']}]))
  await mount()
  recordScene('unsupported')
  expect(container.querySelector('[data-request-id="unsupported-1"]')?.textContent).toContain('Answer in terminal')
  expect(container.querySelector('[data-request-id="unsupported-1"]')?.textContent).toContain('up to nine single-choice options')
  expect(container.querySelectorAll('.agent-interaction__options button')).toHaveLength(0)
  expect(nativeWrites).toEqual([])
})

it('one current card and in-flight response survive Activity/Terminal/History-mode changes', async () => {
  await act(async () => ingress()); await mount()
  let release: (() => void) | undefined
  vi.mocked(api.sessions.respondInteraction).mockImplementationOnce(async () => await new Promise<void>(resolve => { release = resolve }))
  const card = container.querySelector('.agent-interaction')!
  const body = container.querySelector('.log-turn__body')!
  const originalDraft = useAppStore.getState().agentComposerDrafts[AGENT_ID]
  const text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  expect(selection.toString()).toBe('Original')
  const options = [...card.querySelectorAll<HTMLButtonElement>('.agent-interaction__options button')]
  await act(async () => { options[0]!.click(); options[0]!.click() })
  expect(api.sessions.respondInteraction).toHaveBeenCalledTimes(1)
  expect(card.textContent).toContain('Sending answer')
  await act(async () => useAppStore.getState().setViewMode(AGENT_ID, 'terminal'))
  expect(container.querySelector('.agent-interaction')).toBe(card)
  expect(options[0]!.disabled).toBe(true)
  await act(async () => useAppStore.getState().setViewMode(AGENT_ID, 'activity'))
  expect(container.querySelector('.agent-interaction')).toBe(card)
  await act(async () => release?.())
  expect(card.textContent).toContain('Waiting for confirmation')
  await act(async () => options[0]!.click())
  expect(api.sessions.respondInteraction).toHaveBeenCalledTimes(1)
  expect(nativeWrites).toEqual([])
  expect(useAppStore.getState().agentComposerDrafts[AGENT_ID]).toBe(originalDraft)
  expect(body.isConnected).toBe(true)
  expect(container.querySelector('.activity-feed .log-turn__body')).toBe(body)
  expect(selection.toString()).toBe('Original')
  expect(body.textContent).toBe('Original native message')
})
it('an explicit retry keeps the same request, selected option and local cause', async () => {
  await act(async () => ingress()); await mount()
  vi.mocked(api.sessions.respondInteraction).mockRejectedValueOnce(new Error('Private response was not applied'))
  const card = container.querySelector('.agent-interaction')!
  const option = card.querySelector<HTMLButtonElement>('.agent-interaction__options button')!
  await act(async () => option.click())
  expect(card.querySelector('.agent-interaction__error')?.textContent).toContain('not applied')
  expect(option.getAttribute('aria-pressed')).toBe('true')
  expect(option.disabled).toBe(false)
  expect(nativeWrites).toEqual([])
  await act(async () => option.click())
  expect(api.sessions.respondInteraction).toHaveBeenCalledTimes(2)
  expect(nativeWrites).toEqual(['1'])
  expect(container.querySelector('.agent-interaction')).toBeNull()
})
it('current permission reuses the declared allow-always semantic response, not a prompt', async () => {
  await act(async () => ingress('permission-1', [], 'Edit', 'PermissionRequest')); await mount()
  recordScene('permission')
  const card = container.querySelector('[data-request-id="permission-1"]')!
  expect(card).not.toBeNull()
  expect(card.textContent).toContain('Allow Edit?')
  const always = [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes("don't ask again"))!
  expect(always).toBeDefined()
  await act(async () => always.click())
  expect(api.sessions.respondInteraction).toHaveBeenCalledExactlyOnceWith(initialSession.control, {kind:'permission',requestId:'permission-1',decision:{outcome:'selected',optionId:'allow-always'}})
  expect(nativeWrites).toEqual(['2'])
})
it('native accepted permission keeps its actual title and tool input while requiring terminal confirmation', async () => {
  await act(async()=>ingress('native-accepted-permission',[],'Edit','PermissionRequest'));await mount()
  const request=client.agentSession(AGENT_ID).pendingInteraction!.request
  expect(request.kind).toBe('permission')
  if(request.kind!=='permission')throw new Error('Nonempty production permission required')
  expect(request.toolInput).toBeTruthy()
  await act(async()=>client.writeAgent({agentSessionId:AGENT_ID,expectedRun:initialSession.control.run,data:'native answer',source:'user'}))
  const card=container.querySelector('.agent-interaction')!
  expect(card.textContent).toContain(request.title)
  expect(card.textContent).toContain(request.toolName)
  expect(card.querySelector('pre')?.textContent).toBe(request.toolInput)
  expect(card.textContent).toContain('Native input was accepted')
  expect(card.textContent).toContain('Answer in terminal')
  expect([...card.querySelectorAll('button')].map(button=>button.textContent)).toEqual(['Open terminal'])
  expect(api.sessions.respondInteraction).not.toHaveBeenCalled()
  expect(nativeWrites).toEqual(['native answer'])
})
it.each([
  ['Allow once', {outcome:'selected',optionId:'allow-once'}, '1'],
  ['Deny', {outcome:'selected',optionId:'reject-once'}, '\x1b'],
  ['Cancel', {outcome:'cancelled'}, '\x1b']
] as const)('permission %s sends the declared semantic decision once', async (label,decision,bytes) => {
  await act(async () => ingress('permission-decisions', [], 'Edit', 'PermissionRequest')); await mount()
  const buttons=[...container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')]
  expect(buttons.map(button=>button.textContent?.trim())).toEqual(["Allow once","Allow & don't ask againThis tool, this directory.",'Cancel','Deny'])
  const target=buttons.find(button=>button.textContent?.trim()===label)!
  expect(target).toBeDefined()
  await act(async()=>target.click())
  expect(api.sessions.respondInteraction).toHaveBeenCalledExactlyOnceWith(initialSession.control,{kind:'permission',requestId:'permission-decisions',decision})
  expect(nativeWrites).toEqual([bytes])
  expect(container.querySelector('.agent-interaction')).toBeNull()
})
it('disconnected current request cannot send an answer', async () => {
  await act(async () => ingress()); await mount()
  await act(async () => useAppStore.setState({sessions: [{...useAppStore.getState().sessions[0]!,status:{state:'disconnected',source:'run-process',observedAt:3}}]}))
  const options = [...container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')]
  expect(options).toHaveLength(3)
  expect(options.map(one => one.disabled)).toEqual([true,true,true])
  await act(async () => options[0]!.click())
  expect(api.sessions.respondInteraction).not.toHaveBeenCalled()
  expect(nativeWrites).toEqual([])
})
it('a hidden current request cannot respond or read another message page', async () => {
  await act(async () => ingress()); await mount()
  const card = container.querySelector('.agent-interaction')!
  const body = container.querySelector('.log-turn__body')!
  const reads = vi.mocked(api.sessions.historyPage).mock.calls.length
  expect(reads).toBeGreaterThan(0)
  await mount(false, false)
  const buttons = [...card.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons.map(one => one.disabled)).toEqual([true,true,true])
  await act(async () => buttons[0]!.click())
  expect(api.sessions.respondInteraction).not.toHaveBeenCalled()
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  expect(container.querySelector('.activity-feed .log-turn__body')).toBe(body)
  expect(body.isConnected).toBe(true)
  expect(nativeWrites).toEqual([])
})
it('History covers original content without dropping the current in-flight card or original Range', async () => {
  await act(async () => ingress()); await mount()
  const card = container.querySelector('.agent-interaction')!
  const body = container.querySelector('.log-turn__body')!
  const text = body.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text,0); range.setEnd(text,8)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  let release: (() => void) | undefined
  vi.mocked(api.sessions.respondInteraction).mockImplementationOnce(async () => await new Promise<void>(resolve => {release=resolve}))
  await act(async () => card.querySelector<HTMLButtonElement>('.agent-interaction__options button')!.click())
  await openAgentHistory(container)
  expect(container.querySelector('[aria-label="Conversation history"]')?.textContent).toContain('Original native message')
  expect(container.querySelector('.agent-interaction')).toBe(card)
  expect(body.isConnected).toBe(true)
  expect(range.toString()).toBe('Original')
  const close = container.querySelector<HTMLButtonElement>('.session-history__toolbar button')!
  expect(close).not.toBeNull()
  await act(async () => close.click())
  expect(container.querySelector('.activity-feed .log-turn__body')).toBe(body)
  expect(card.textContent).toContain('Sending answer')
  await act(async () => release?.())
  expect(card.textContent).toContain('Waiting for confirmation')
  expect(api.sessions.respondInteraction).toHaveBeenCalledTimes(1)
  expect(nativeWrites).toEqual([])
})
it('late failure from a replaced request cannot paint or unlock the new request', async () => {
  await act(async () => ingress()); await mount()
  let rejectOld: ((error: Error) => void) | undefined
  vi.mocked(api.sessions.respondInteraction).mockImplementationOnce(async () => await new Promise<void>((_,reject) => {rejectOld=reject}))
  const old = container.querySelector('.agent-interaction')!
  await act(async () => old.querySelector<HTMLButtonElement>('.agent-interaction__options button')!.click())
  // Replacement is a legal projection derived from the actual producer request, not a guessed shape.
  const projection = useAppStore.getState().sessions[0]!
  expect(projection.kind).toBe('agent')
  if(projection.kind!=='agent'||!projection.pendingInteraction) throw new Error('Nonempty producer projection required')
  await act(async () => useAppStore.setState({sessions:[{...projection,pendingInteraction:{...projection.pendingInteraction!,id:'replacement-request'}}]}))
  const replacement = container.querySelector('[data-request-id="replacement-request"]')!
  expect(replacement).not.toBeNull()
  expect(replacement).not.toBe(old)
  await act(async () => rejectOld?.(new Error('Old response failed')))
  expect(replacement.textContent).not.toContain('Old response failed')
  expect(replacement.querySelectorAll<HTMLButtonElement>('button').length).toBe(3)
  expect([...replacement.querySelectorAll<HTMLButtonElement>('button')].map(one=>one.disabled)).toEqual([false,false,false])
  expect(api.sessions.respondInteraction).toHaveBeenCalledTimes(1)
  expect(nativeWrites).toEqual([])
})
it('an old request Run remains visible but cannot receive a response', async () => {
  await act(async () => ingress()); await mount()
  const projection=useAppStore.getState().sessions[0]!
  expect(projection.kind).toBe('agent')
  if(projection.kind!=='agent'||!projection.pendingInteraction)throw new Error('Nonempty producer projection required')
  await act(async()=>useAppStore.setState({sessions:[{...projection,control:{...projection.control,run:{runId:'new-run'}}}]}))
  const buttons=[...container.querySelectorAll<HTMLButtonElement>('.agent-interaction button')]
  expect(buttons.map(one=>one.disabled)).toEqual([true,true,true])
  await act(async()=>buttons[0]!.click())
  expect(api.sessions.respondInteraction).not.toHaveBeenCalled()
  expect(nativeWrites).toEqual([])
})
