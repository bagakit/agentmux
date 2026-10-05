import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { projectRuntimeEvent } from '../src/renderer/src/lib/session-state.js'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices.js'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { AgentMuxClient } from '@agentmux/core'
import { AgentMuxMemoryAgentSessionStore, loadAgentSessions } from '@agentmux/core'
import { AgentHookServer } from '../../../packages/core/src/hook-server.js'
import type { AgentMuxStoredAgentSession, AgentMuxInteractionResponse, AgentMuxClientEvent, NativeHookEnvelope } from '@agentmux/core'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const SID = 'private-receipt-owner', RUN = 'original-receipt-run', NATIVE = 'original-claude-source'
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private original owner' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }

function agentSnapshot(session: SessionSnapshot | undefined) {
  if (!session || session.kind !== 'agent') throw Error('Expected the original Agent snapshot')
  return session
}

async function fixture(raw?: 'unknown' | 'accepted') {
  const response: AgentMuxInteractionResponse = { kind: 'permission', requestId: 'original-request', decision: { outcome: 'selected', optionId: 'allow-once' } }
  const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: _hygiene_fixturePath("tmp/private-receipt"),
    run: { runId: RUN }, retiredRuns: [], hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43), createdAt: 1, updatedAt: 2,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: NATIVE },
    pendingInteraction: { request: { kind: 'permission', id: 'original-request', agentSessionId: SID, title: 'Allow Bash?', nativeToolCallId: 'original-call', toolName: 'Bash',
      options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }], evidence: { source: 'native-hook', observedAt: 1, run: { runId: RUN }, hookReceiptId: 'original-request' } },
      response: { value: response, responseDigest: createHash('sha256').update(JSON.stringify(response)).digest('base64url'), operationId: 'original-response-operation',
        inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false },
      ...(raw ? { nativeInput: { delivery: raw, operationId: 'original-native-input', observedAt: 2 } } : {}) } }
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, record)
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  await Reflect.get(client, 'registry').load('local'); Reflect.set(client, 'connected', true)
  const run = () => ({ nativeService: null, runId: RUN, lifecycleOperationId: null, program: 'private-fixture', args: [], workspacePath: record.workspacePath, pid: 999,
    state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
  kernel.isConnected = () => true; kernel.identity = () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 1, buildIdentity: 'fixture' })
  kernel.status = async () => run(); kernel.list = async () => [run()]
  kernel.input = vi.fn(async () => { throw Error('Read-only projection must not write input') })
  for (const name of ['start', 'stop', 'resize', 'attach']) kernel[name] = vi.fn(async () => { throw Error('Read-only projection must not control Run: ' + name) })
  vi.spyOn(client, 'sessionTimeline').mockResolvedValue({ agentSessionId: SID, entries: [] } as never)
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  const hook = new AgentHookServer((event, signal) => (Reflect.get(client, 'acceptHookEvent') as (e: NativeHookEnvelope, s: AbortSignal) => Promise<void>).call(client, event, signal), 0)
  Reflect.set(client, 'hookServer', hook); await hook.start()
  const binding = hook.createBinding(SID, 'claude', record.hookBindingId, record.hookToken); await binding.bindRun(RUN)
  const controller = new RuntimeController(store, async () => client); controller.commit(await controller.prepare(config))
  cleanup.push(async () => { await controller.dispose(); await client.dispose() })
  let ordinal = 0
  const feed = async (eventName: string, callId: string) => {
    const response = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: 'Bearer ' + binding.endpoint.token, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: 'private-completion-' + (++ordinal), eventName, payload: { session_id: NATIVE, tool_name: 'Bash', tool_use_id: callId } }) })
    expect(response.status, await response.text()).toBe(204)
  }
  const original = agentSnapshot((await controller.snapshot(config)).sessions[0])
  const state = { sessions: [original], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  const projected = async () => {
    const status = await client.statusAgent(SID)
    const publication = events.filter(e => e.type === 'agent-session').at(-1)
    expect(publication).toBeDefined()
    const live = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: publication! }).state
    const cold = agentSnapshot((await controller.snapshot(config)).sessions[0])
    return { status, live: agentSnapshot(live.sessions[0]), cold, state: live }
  }
  return { client, kernel, store, feed, projected, original: record, state }
}

it.each(['incomplete', 'completed', 'completed-with-new', 'completed-after-raw-unknown'] as const)(
  'actual Hook publication, Main cold and Renderer live preserve current request and original receipt: %s', async mode => {
    const f = await fixture(mode === 'completed-after-raw-unknown' ? 'unknown' : undefined)
    await f.feed('PostToolUseFailure', 'foreign-call')
    let projected = await f.projected()
    expect(projected.cold.pendingInteraction?.id).toBe('original-request')
    expect(projected.live.pendingInteraction?.id).toBe('original-request')
    expect(projected.cold.completedInteractionResponse).toBeUndefined()
    expect(projected.status.observation.readiness).toBe('pending')
    if (mode !== 'incomplete') await f.feed('PostToolUseFailure', 'original-call')
    if (mode === 'completed-with-new') await f.feed('PermissionRequest', 'new-call')
    projected = await f.projected()
    const expectedActive = mode === 'incomplete' ? 'original-request' : mode === 'completed-with-new' ? 'private-completion-3' : undefined
    expect(projected.cold.pendingInteraction?.id).toBe(expectedActive)
    expect(projected.live.pendingInteraction?.id).toBe(expectedActive)
    expect(projected.status.observation.readiness).toBe(expectedActive ? 'pending' : 'ready')
    for (const snapshot of [projected.cold, projected.live]) {
      const notice = sessionServiceNotices(snapshot).find(item => item.id === 'interaction-receipt')
      if (mode === 'incomplete') { expect(snapshot.completedInteractionResponse).toBeUndefined(); expect(notice).toBeUndefined() }
      else {
        expect(snapshot.completedInteractionResponse).toEqual({ requestId: 'original-request', operationId: 'original-response-operation', acknowledged: false })
        expect(snapshot.interactionResponseUnavailableReason).toContain('has ended')
        expect(snapshot.interactionResponseUnavailableReason).toContain('original native request')
        expect(notice?.notice.notice.step).toBe('Typed answer receipt unsettled')
        expect(notice?.notice.notice.mode).not.toContain('Whether this request is still pending')
        expect(notice?.occurrence).toContain('original-response-operation')
      }
      expect(snapshot.control.run.runId).toBe(RUN)
    }
    const retained = (await loadAgentSessions(f.store))[0]!.pendingInteraction!
    expect(retained.request).toEqual(f.original.pendingInteraction!.request)
    expect(retained.response).toEqual(f.original.pendingInteraction!.response)
    expect(f.client.agentSession(SID).nativeHandle).toEqual(f.original.nativeHandle)
    expect(projected.state.tabs).toBe(f.state.tabs); expect(projected.state.layouts).toBe(f.state.layouts)
    expect(f.kernel.input).not.toHaveBeenCalled(); expect(f.kernel.start).not.toHaveBeenCalled(); expect(f.kernel.stop).not.toHaveBeenCalled()
  }
)
