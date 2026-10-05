import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../../../packages/core/src/client'
import { AgentProviderRegistry, defineAgentProvider } from '../../../packages/core/src/agent-provider'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { AgentTerminalScreen } from '../../../packages/core/src/agent-terminal-screen'
import { AgentMuxError } from '../../../packages/core/src/errors'
import type { AgentPromptExecutionEvidence } from '../../../packages/core/src/types'
import type { AgentScreenEvidenceStore } from '../../../packages/core/src/screen-evidence'
import type { AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { deliveryOutcome } from '../src/conversation/delivery'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const connected = { state: 'connected' as const, message: '已连接原 Host' }
const platform = () => createBrowserPlatform({ clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const dispose of disposers.splice(0)) await dispose()
  vi.unstubAllEnvs()
})

/** Only the private ctxmux transport is synthetic. SDK, service, provider wrapper,
 * Core admission, original Run byte receipts and persisted Session owner are real. */
async function hostedFixture(protocol: 'ordinary' | 'interrupt' | 'stale-advertisement', interrupt = '\x1b', working = true) {
  const root = await mkdtemp(join(tmpdir(), 'amx-mobile-send-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const providerId = `native-${protocol}`
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original', providerId, executorId: providerId,
    hookBindingId: 'private-binding', hookToken: 'private-hook', hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    semanticStatus: { state: working ? 'working' : 'done', source: 'native-hook', observedAt: 1 } })
  const screen = new AgentTerminalScreen(100, 30)
  const draw = async (text = '', busy = true) => {
    const bytes = Buffer.from(`\x1b[?2026h\x1b[2J\x1b[10;1H${busy ? 'working' : 'idle'}\x1b[15;1H> ${text}\x1b[15;${3 + text.length}H\x1b[?2026l`)
    await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.length, dataBytes: bytes })
  }
  await draw('', working)
  let native: AgentPromptExecutionEvidence = { sourceId: 'private-native', id: 'started', nativeTurnId: 'turn-1', state: working ? 'working' : 'ended', ...(!working ? { endReason: 'completed' as const } : {}) }
  const template = new AgentProviderRegistry().get('codex').catalog
  const { promptExecution: _unused, providerFork: _fork, ...ordinaryCapabilities } = template.capabilities
  const provider = defineAgentProvider({ catalog: { ...template, id: providerId, label: 'Private native protocol',
    capabilities: { ...ordinaryCapabilities, ...(protocol === 'ordinary' ? {} : { promptExecution: { immediate: 'interrupt-before-input' as const } }) },
    hookStrategy: { kind: 'native', installation: 'unmanaged' } }, buildArgs: (_, args) => [...args], hook: { rules: [] },
    ...(protocol !== 'ordinary' ? {
      terminalPromptRender: { frameStart: '\x1b[?2026h', frameEnd: '\x1b[?2026l', activeComposer: '>' },
      planPromptInput: (prompt: string, context?: { execution?: string }) => ({ kind: 'render-then-submit' as const,
        payload: prompt, renderedText: prompt, submit: '\r', ...(context?.execution === 'immediate' ? { prepare: { interrupt, endEvent: 'native-ended' } } : {}) }),
      verifyPromptExecutionTransport: async () => true,
      readPromptExecutionEvidence: async () => native,
      inspectPromptExecution: (snapshot: ReturnType<AgentTerminalScreen['snapshot']>) => snapshot.lines[snapshot.cursor.row]?.text.trimEnd() !== '>'
        ? 'unavailable' as const : snapshot.lines[9]?.text === 'working' ? 'interruptible' as const : 'idle' as const
    } : {}) })
  // A previously valid owner can become stale; definition itself must satisfy
  // the public capability/contribution contract before exercising that refusal.
  if (protocol === 'stale-advertisement') provider.planPromptInput = () => {
    throw new AgentMuxError('The original provider cannot currently apply immediate input.', 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED')
  }
  const core = new AgentMuxClient({ store, providers: [provider] })
  const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown>; screenEvidence: AgentScreenEvidenceStore }
  await inner.registry.load('local'); inner.connected = true
  let cursor = 0, lostAck = false
  const writes: string[] = []
  const run = () => ({ runId: 'original-run', lifecycleOperationId: null, program: fixturePath("private-worker"), args: [],
    workspacePath: root, pid: 421, state: { type: 'running' as const }, cols: 100, rows: 30,
    latestOutputBytes: screen.throughByte, firstAvailableByte: 0, acceptedInputBytes: cursor })
  const input = vi.fn(async (_id: string, operation: { expectedByte: number; data: string }) => {
    expect(operation.expectedByte).toBe(cursor)
    writes.push(operation.data)
    const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(operation.data) }; cursor = range.endByte
    if (operation.data === interrupt) {
      native = { sourceId: 'private-native', id: 'cancelled', nativeTurnId: 'turn-1', state: 'ended', endReason: 'interrupted' }
      await draw('', false)
    } else if (operation.data !== '\r') await draw(operation.data, false)
    if (lostAck) { lostAck = false; throw new AgentMuxError('private lost input ACK', 'CTXMUX_INPUT_UNCONFIRMED', 'unknown') }
    return { run: run(), appliedByteRange: range }
  })
  const stop = vi.fn()
  Object.assign(inner.kernel, { isConnected: () => true, identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 18, buildIdentity: 'private-worker' }),
    status: async () => run(), list: async () => [run()], input, stop })
  vi.spyOn(inner.screenEvidence, 'wait').mockImplementation(async (...args: Parameters<AgentScreenEvidenceStore['wait']>) => {
    if (!args[3](screen)) throw new AgentMuxError('Private screen unconfirmed', 'AGENT_PROMPT_RENDER_TIMEOUT')
    return screen.throughByte
  })
  vi.spyOn(core, 'connect').mockResolvedValue()
  const submit = vi.spyOn(core, 'submitAgentPrompt')
  const service = new AgentMuxHostedRuntimeService(core, store.path, () => hostedTestOwner(core))
  const calls: Array<{ method: string; params: unknown }> = []
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value))
  const port = {
    call: async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
      calls.push({ method, params: wire(params) })
      try { return wire(await service.call(method, wire(params), options)) }
      catch (error) {
        if (error instanceof AgentMuxError) throw Object.assign(new Error(error.message), wire({ code: error.code, detail: error.detail, controlFailure: error.controlFailure }))
        throw error
      }
    },
    subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: unknown): void; signal?: AbortSignal }) => {
      const stream = await service.subscribe(method, params, event => handlers.onEvent(wire(event)), handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(wire(stream.initial)); await stream.start?.()
      return { dispose: async () => await stream.dispose() }
    }
  } as unknown as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port })
  disposers.push(async () => { await client.dispose(); await service.dispose(); await core.dispose(); screen.dispose(); await rm(root, { recursive: true }) })
  return { core, client, input, writes, stop, submit, calls, loseAck: () => { lostAck = true } }
}
async function originalSurface(f: { client: Awaited<ReturnType<typeof hostedFixture>>['client'] }, id = 'original') {
  return await mount(<MobileConversationSurface client={f.client} agentSessionId={id} connection={connected} platform={platform()} />)
}
async function settle(view: Awaited<ReturnType<typeof mount>>, phase: string, f: Awaited<ReturnType<typeof hostedFixture>>) {
  await act(async () => { await f.submit.mock.results.at(-1)?.value?.catch(() => {}); await Promise.resolve() })
  await vi.waitFor(() => expect(view.element.textContent).toContain(phase))
}

describe('public Provider capability controls one fresh explicit mobile Send', () => {
  it('sends healthy ordinary input through the actual Hosted/Core owner while its turn is working', async () => {
    const f = await hostedFixture('ordinary'), view = await originalSurface(f)
    await paste(view.element, 'ORDINARY_AUTHORIZED_MESSAGE'); await click(button(view.element, 'Send'))
    await settle(view, 'Core 已确认普通输入', f)
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentSessionId: 'original', expectedRun: { runId: 'original-run' }, afterSubmissionId: null, allowUncertainTurn: true }))
    expect(f.submit.mock.calls[0]![0].execution).toBeUndefined()
    expect(f.writes).toEqual(['ORDINARY_AUTHORIZED_MESSAGE\r'])
    expect(f.core.agentSession('original').promptCompletionAdmission).toMatchObject({ acknowledged: true, intent: { execution: 'default', run: { runId: 'original-run' } } })
    expect(view.element.textContent).toContain('普通输入 · 不支持立即执行'); expect(f.stop).not.toHaveBeenCalled()
  })

  it.each(['\x1b', '\x04'])('uses original advertised interrupt-before-input through native protocol %s', async interrupt => {
    const f = await hostedFixture('interrupt', interrupt), view = await originalSurface(f)
    await paste(view.element, 'IMMEDIATE_AUTHORIZED_MESSAGE'); await click(button(view.element, 'Send'))
    await settle(view, 'Core 已确认立即执行输入', f)
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ execution: 'immediate', allowUncertainTurn: true })
    expect(f.writes).toEqual([interrupt, 'IMMEDIATE_AUTHORIZED_MESSAGE', '\r'])
    expect(f.core.agentSession('original').terminalPromptSubmission).toMatchObject({ prepare: { interrupt: { acknowledged: true } }, submit: { acknowledged: true } })
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('labels plain Enter as ordinary input for an immediate-capable original Provider without claiming unsupported capability', async () => {
    const f = await hostedFixture('interrupt', '\x1b', false), view = await originalSurface(f)
    await paste(view.element, 'ORDINARY_ENTER_MESSAGE')
    await act(async () => { editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })) })
    await settle(view, 'Core 已确认普通输入', f)
    expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('execution')
    expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('allowUncertainTurn')
    expect(f.writes).toEqual(['ORDINARY_ENTER_MESSAGE', '\r'])
    expect(view.element.textContent).not.toContain('不支持立即执行')
    expect(view.element.textContent).not.toContain('立即执行输入')
    expect(view.element.textContent).toContain('普通输入')
  })

  it('keeps a typed actual Provider pre-input unsupported rejection rejected without replaying or disabling fresh Send', async () => {
    const f = await hostedFixture('stale-advertisement'), view = await originalSurface(f)
    await paste(view.element, 'UNAPPLIED_MESSAGE'); await click(button(view.element, 'Send'))
    await settle(view, '尚未发送', f)
    expect(view.element.querySelector('[data-phase="rejected"]')).not.toBeNull()
    expect(editor(view.element).textContent).toContain('UNAPPLIED_MESSAGE')
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(f.input).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledOnce()
    await act(async () => { await Promise.resolve() }); expect(f.submit).toHaveBeenCalledOnce()
  })

  it.each(['throw', 'empty', 'other-only'])('keeps ordinary input and a recoverable service window when catalog is %s', async kind => {
    const f = await hostedFixture('ordinary'), original = f.client.catalog(), read = vi.spyOn(f.client, 'catalog')
    if (kind === 'throw') read.mockImplementation(() => { throw new Error('private catalog transport failed') })
    else read.mockReturnValue(kind === 'empty' ? [] : [{ ...original[0]!, id: 'unrelated-provider', capabilities: { ...original[0]!.capabilities, promptExecution: { immediate: 'interrupt-before-input' } } }])
    const view = await originalSurface(f)
    await paste(view.element, 'CATALOG_FAILURE_HEALTHY_MESSAGE'); await click(button(view.element, 'Send'))
    await settle(view, 'Core 已确认普通输入', f)
    expect(f.writes).toEqual(['CATALOG_FAILURE_HEALTHY_MESSAGE\r'])
    expect(view.element.textContent).toContain('普通输入 · 立即执行能力未确认')
    expect(view.element.textContent).toContain('本次选择普通输入，未尝试立即执行')
    await paste(view.element, 'NEXT_MANUAL_MESSAGE'); expect(button(view.element, 'Send').disabled).toBe(false)
    await view.render(<MobileConversationSurface client={f.client} agentSessionId="original" connection={{ state: 'disconnected', message: '原 Host 连接暂未确认' }} platform={platform()} />)
    expect(view.element.textContent).not.toContain('原会话仍连接，可继续发送')
    expect(view.element.textContent).toContain('原 Host 连接暂未确认')
    expect(view.element.textContent).toContain('本次选择普通输入，未尝试立即执行')
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(editor(view.element).textContent).toContain('NEXT_MANUAL_MESSAGE')
    await view.render(<MobileConversationSurface client={f.client} agentSessionId="original" connection={connected} platform={platform()} />)
    read.mockReturnValue(original); await click(button(view.element, '重新读取能力目录'))
    expect(view.element.textContent).not.toContain('立即执行能力未确认'); expect(f.writes).toHaveLength(1)
  })

  it('uses the exact original Session provider rather than an unrelated advertised catalog entry', async () => {
    const f = await hostedFixture('ordinary'), catalog = f.client.catalog()
    vi.spyOn(f.client, 'catalog').mockReturnValue([{ ...catalog[0]!, id: 'unrelated', capabilities: { ...catalog[0]!.capabilities, promptExecution: { immediate: 'interrupt-before-input' } } }, ...catalog])
    const view = await originalSurface(f)
    await paste(view.element, 'EXACT_ORIGINAL_PROVIDER'); await click(button(view.element, 'Send'))
    await settle(view, 'Core 已确认普通输入', f); expect(f.writes).toEqual(['EXACT_ORIGINAL_PROVIDER\r'])
  })

  it('retains a real partial ordinary input and its original operation after a lost Hosted/Core receipt without automatic replay', async () => {
    const f = await hostedFixture('ordinary'), view = await originalSurface(f)
    f.loseAck()
    await paste(view.element, 'PARTIAL_ORIGINAL_MESSAGE'); await click(button(view.element, 'Send'))
    await settle(view, '发送结果未确认', f)
    expect(f.writes).toEqual(['PARTIAL_ORIGINAL_MESSAGE\r'])
    expect(view.element.querySelector('[data-phase="unknown"]')).not.toBeNull()
    expect(editor(view.element).textContent).toContain('PARTIAL_ORIGINAL_MESSAGE')
    const operationId = f.submit.mock.calls[0]![0].operationId
    expect(JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')!).conversation.attempts[0][1]).toMatchObject({ operationId, phase: 'unknown' })
    vi.spyOn(f.client, 'catalog').mockImplementation(() => { throw new Error('later capability failure') })
    await view.render(<MobileConversationSurface client={f.client} agentSessionId="original" connection={connected} platform={platform()} />)
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.writes).toHaveLength(1)
    expect(button(view.element, 'Send').disabled).toBe(false)
  })

  it('retains the original capability service window after an unrelated Session sends successfully', async () => {
    const f = fixture(), read = vi.spyOn(f.client, 'catalog')
    read.mockImplementation(() => { throw new Error('original catalog unavailable') })
    const view = await originalSurface(f, 'session-original')
    await paste(view.element, 'ORIGINAL_ORDINARY_MESSAGE'); await click(button(view.element, 'Send'))
    expect(view.element.textContent).toContain('original catalog unavailable')
    read.mockReturnValue(new AgentProviderRegistry().catalog())
    await view.render(<MobileConversationSurface client={f.client} agentSessionId="other" connection={connected} platform={platform()} />)
    await paste(view.element, 'OTHER_EXPLICIT_MESSAGE'); await click(button(view.element, 'Send'))
    expect(view.element.textContent).not.toContain('original catalog unavailable')
    await view.render(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform()} />)
    expect(view.element.textContent).toContain('original catalog unavailable')
    expect(view.element.textContent).toContain('普通输入 · 立即执行能力未确认')
    expect(f.submit).toHaveBeenCalledTimes(2)
    await click(button(view.element, '重新读取能力目录'))
    expect(view.element.textContent).not.toContain('original catalog unavailable')
    expect(view.element.textContent).toContain('Core 已确认普通输入')
    expect(view.element.textContent).not.toContain('Core 已确认立即执行输入')
    expect(f.submit).toHaveBeenCalledTimes(2)
  })

  it('preserves an old unknown intent through changed capability facts without dispatching again', async () => {
    const f = fixture(), catalog = vi.spyOn(f.client, 'catalog')
    f.submit.mockRejectedValueOnce(Object.assign(new Error('partial original'), { code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED', detail: 'unknown' }))
    const view = await originalSurface(f, 'session-original')
    await paste(view.element, 'OLD_UNKNOWN_MESSAGE'); await click(button(view.element, 'Send'))
    expect(view.element.querySelector('[data-phase="unknown"]')).not.toBeNull()
    catalog.mockReturnValue([])
    await view.render(<MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform()} />)
    expect(f.submit).toHaveBeenCalledOnce()
    expect(editor(view.element).textContent).toContain('OLD_UNKNOWN_MESSAGE')
    expect(catalog).toHaveBeenCalledOnce()
  })
})

it.each([
  [{ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED' }, 'rejected'],
  [{ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }, 'rejected'],
  [{ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED', detail: 'unknown' }, 'unknown'],
  [{ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED', controlFailure: { disposition: 'unknown', confirmedInputBytes: 0 } }, 'unknown'],
  [{ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 3 } }, 'unknown']
])('classifies only exact unapplied immediate failures %j as %s', (error, expected) => {
  expect(deliveryOutcome(error, 'prompt')).toBe(expected)
})
