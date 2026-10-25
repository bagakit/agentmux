import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry, defineAgentProvider, type AgentProvider, type AgentProviderDefinition } from '../src/agent-provider.js'
import { createClaudeProvider } from '../src/providers/claude.js'
import { canonicalHookLifecycleEvent } from '../src/agent-hook-event.js'
import { usageFinalizationEvents } from '../src/agent-hook-command.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'

function definition(): AgentProviderDefinition {
  return {
    catalog: { id: 'contract-fixture', label: 'Contract fixture', executable: 'node', expectedProcess: 'node',
      readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      composer: { skillRoots: ['.agent/skills'], commands: [{ text: '/help', description: 'Help' }] },
      capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false,
        replyCorrelation: 'none', promptExecution: { immediate: 'terminal-submit' } } },
    hook: { rules: [] }, buildArgs: (prompt, args) => [...args, prompt]
  }
}

const hookEnvelope = (providerId: string, eventName: string, payload: Record<string, unknown> = {}) => ({
  providerId, eventName, payload, receiptId: 'original-hook', agentSessionId: 'original-session', runId: 'original-run'
})

describe('Provider hook and coverage contract', () => {
  it('preserves declared outcome categories through the public native catalog codec', () => {
    const registry = new AgentProviderRegistry(), params = { hostId: 'local', executorId: 'claude' }
    const catalog = { hostId: 'local', executorId: 'claude', providerId: 'claude', availability: 'available',
      capabilities: registry.catalog().find(entry => entry.id === 'claude')!.capabilities, sessions: [], issues: [] }
    expect(parseRpcNativeResult('agent.native.ls', catalog, params)).toMatchObject({ capabilities: { turnOutcomes: { observation: ['failed'] } } })
    expect(catalog.capabilities.turnOutcomes?.history).toBeUndefined()
    for (const turnOutcomes of [{ observation: ['guessed-success'] }, { observation: ['failed', 'failed'] }, { all: true }]) {
      expect(() => parseRpcNativeResult('agent.native.ls', { ...catalog, capabilities: { ...catalog.capabilities, turnOutcomes } }, params)).toThrow()
    }
    catalog.capabilities.turnOutcomes!.observation!.push('completed')
    expect(registry.catalog().find(entry => entry.id === 'claude')!.capabilities.turnOutcomes).toEqual({ observation: ['failed'] })
  })

  it('keeps conflicting raw names scoped to their actual Provider', () => {
    const base = definition()
    const working = defineAgentProvider({ ...base, hook: { lifecycle: { Stop: 'turn-start' }, rules: [{ events: ['Stop'], state: 'working' }] } })
    const unknown = defineAgentProvider({ ...base, hook: { rules: [{ events: ['Stop'], state: 'working' }] } })
    expect(working.normalizeHook(hookEnvelope(working.id, 'Stop'), {}).lifecycleEvent).toBe('turn-start')
    expect(unknown.normalizeHook(hookEnvelope(unknown.id, 'Stop'), {}).lifecycleEvent).toBeUndefined()
    expect(canonicalHookLifecycleEvent('Stop')).toBeUndefined()
    expect(canonicalHookLifecycleEvent('Stop', 'turn-end')).toBe('turn-end')
  })

  it('uses Provider permission lifecycle rather than a globally familiar raw name', () => {
    let source!: AgentProviderDefinition
    createClaudeProvider(value => { source = value; return defineAgentProvider(value) })
    const withoutPermission = defineAgentProvider({ ...source, hook: { ...source.hook, lifecycle: {}, rules: [] } })
    expect(withoutPermission.normalizeHook(hookEnvelope('claude', 'PermissionRequest', { tool_name: 'Bash' }), {}).interaction).toBeUndefined()
    const claude = createClaudeProvider(defineAgentProvider)
    expect(claude.normalizeHook(hookEnvelope('claude', 'PermissionRequest', { tool_name: 'Bash' }), {}).interaction?.kind).toBe('permission')
  })

  it('keeps transcript sampling distinct from turn completion and other Provider names', () => {
    const claude = createClaudeProvider(defineAgentProvider)
    expect(claude.normalizeHook(hookEnvelope('claude', 'Stop'), {}).lifecycleEvent).toBeNull()
    const events = usageFinalizationEvents({ AGENTMUX_HOOK_USAGE_EVENTS: JSON.stringify(claude.hook.usageFinalizationEvents) })
    expect([...events]).toEqual(['Stop', 'StopFailure'])
    expect(events.has('on_session_end')).toBe(false)
    expect(usageFinalizationEvents({}).size).toBe(0)
  })

  it('retains older receipt bytes without fabricating lifecycle from their event name', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'stored-session', hostId: 'local', providerId: 'contract-fixture',
      executorId: 'contract-fixture', workspacePath: '.', run: { runId: 'stored-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
      hookBindingId: 'binding', hookToken: 'token', hookReceipt: { id: 'original-receipt', agentSessionId: 'stored-session',
        providerId: 'contract-fixture', run: { runId: 'stored-run' }, eventName: 'Stop', observedAt: 1, outputCursorBytes: 42 } })
    const record = (await store.loadMetadata())[0]!
    expect(record.hookReceipt?.outputCursorBytes).toBe(42)
    expect(record.hookReceipt?.lifecycleEvent).toBeUndefined()
  })
})

describe('Claude native failures', () => {
  const claude: AgentProvider = createClaudeProvider(defineAgentProvider)
  const context = { nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-main' } }
  it('retains classic failure diagnostics without borrowing a native turn', () => {
    const event = claude.normalizeHook(hookEnvelope('claude', 'StopFailure', { session_id: 'native-main', error: 'unfamiliar native error', error_details: 'private detail' }), context)
    expect(event.status.detail).toContain('private detail')
    expect(event.status.failure).toBeUndefined()
    expect(event.timeline).toHaveLength(1)
    expect(event.timeline[0]!.type === 'update' ? undefined : event.timeline[0]!.item.turnOutcome).toBeUndefined()
  })
  it('carries the same exact native error result on status and the original captured record', () => {
    const event = claude.normalizeHook(hookEnvelope('claude', 'turn.complete', { session_id: 'native-main', sourceId: 'native-source',
      sequence: 3, turnId: 'native-turn', reason: 'error', isAborted: false }), context)
    expect(event.status.failure).toMatchObject({ code: 'AGENT_PROVIDER_ERROR', nativeTurnId: 'native-turn', publicMessage: 'Claude could not finish this request.' })
    expect(event.status.failure?.nativeCode).toBeUndefined()
    expect(event.status.failure?.httpStatusCode).toBeUndefined()
    expect(event.timeline).toHaveLength(1)
    const mutation = event.timeline[0]!
    expect(mutation.type === 'update' ? undefined : mutation.item.turnOutcome).toEqual({ status: 'failed', failure: event.status.failure })
  })
  it.each([{ sequence: 3 }, { sequence: 3, turnId: 'native-turn', agent_id: 'child' }, { sequence: 3, turnId: 'native-turn', session_id: 'foreign' }])('does not manufacture an attributed outcome from %j', extra => {
    const event = claude.normalizeHook(hookEnvelope('claude', 'turn.complete', { session_id: 'native-main', sourceId: 'native-source', reason: 'error', isAborted: false, ...extra }), context)
    expect(event.status.failure).toBeUndefined()
    expect(event.timeline).not.toHaveLength(0)
    for (const mutation of event.timeline) if (mutation.type !== 'update') expect(mutation.item.turnOutcome).toBeUndefined()
  })
})
