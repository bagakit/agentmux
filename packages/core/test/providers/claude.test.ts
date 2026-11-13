import { AgentProviderRegistry as LifecycleRegistry } from '../../src/agent-provider.js'
const lifecycleProvider = new LifecycleRegistry().get('claude')
const canonicalHookLifecycleEvent = (name: string) => {
  const rule = lifecycleProvider.hook.rules.find(rule => rule.events.includes(name) && !rule.matches && !rule.toolNames)
  return declaredHookLifecycleEvent(name, rule?.lifecycleEvent, lifecycleProvider.hook.lifecycle)
}
const USAGE_FINALIZATION_EVENTS = new Set(lifecycleProvider.hook.usageFinalizationEvents ?? [])
import { fixturePath } from '../helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OutputChunk, RunEvent } from '@ctxmux/sdk'
import { AgentProviderRegistry, defineAgentProvider } from '../../src/agent-provider.js'
import { CLAUDE_HOOK_EVENTS, CLAUDE_HOOKS, createClaudeManagedHookPlan, createClaudeProvider } from '../../src/providers/claude.js'
import { canonicalHookLifecycleEvent as declaredHookLifecycleEvent } from '../../src/agent-hook-event.js'
import { agentHasActiveSubagents, releaseSubagentRoster } from '../../src/hook-normalizer.js'
import { AgentMuxClient } from '../../src/client.js'
import { agentPromptCondition } from '../../src/agent-prompt-condition.js'
import { AgentMuxFileAgentSessionStore, normalizeStoredAgentSession } from '../../src/agent-session-store.js'
import { agentTurnCompletionIdentity, agentTurnEndBoundary } from '../../src/agent-session-identity.js'
import { defaultAgentMuxHookPort } from '../../src/runtime-paths.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import type { AgentSemanticState } from '../../src/types.js'
import {
  CLAUDE_ASKED_TOOL_END_EVENT,
  claudeNativeActivityDirectory,
  claudeNativeActivitySource
} from '../../src/providers/claude-native-activity.js'

describe('Claude native mod activity', () => {
  it('installs an actual mod and launches it for new, resumed and forked Runs', () => {
    const provider = new AgentProviderRegistry().get('claude')
    const workspacePath = fixturePath('tmp/native-mod-work')
    const plan = provider.planManagedHooks!({ workspacePath })!
    const directory = claudeNativeActivityDirectory(workspacePath)
    const modules = plan.mutations.find(item => item.path === join(directory, 'hooks', 'hooks.json'))!
    expect(JSON.parse(modules.content)).toEqual({ modules: ['./register.js'] })
    expect(plan.mutations.find(item => item.path === join(directory, 'hooks', 'register.js'))?.content)
      .toBe(claudeNativeActivitySource())
    const base = { workspacePath, args: ['--model', 'test-model'], env: {} }
    const nativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-original' }
    for (const launch of [
      provider.buildLaunch({ ...base, prompt: 'original user prompt' }),
      provider.buildResumeLaunch({ ...base, nativeHandle, prompt: 'original user prompt' }),
      provider.buildForkLaunch!({ ...base, nativeHandle, prompt: 'original user prompt' })
    ]) {
      expect(launch.args.slice(-2)).toEqual(['--plugin-dir', directory])
      expect(launch.args).toContain('original user prompt')
    }
    expect(provider.buildLaunch({ ...base, prompt: 'prompt', args: ['--', 'literal'] }).args)
      .toEqual(['--plugin-dir', directory, '--', 'literal', 'prompt'])
  })

  it('projects native active and idle without declaring success, input readiness or main child completion', () => {
    const provider = new AgentProviderRegistry().get('claude')
    const payload = { session_id: 'native-A', sourceId: 'observer-A', sequence: 1, turnId: 'native-turn-A' }
    const event = (eventName: string, extra: Record<string, unknown> = {}) => provider.normalizeHook({
      receiptId: `native-${eventName}`, agentSessionId: 'core-A', runId: 'run-A', providerId: 'claude',
      eventName, payload: { ...payload, ...extra }
    }, {})
    expect(event('turn.start').currentActivity).toEqual({ state: 'active', nativeSessionId: 'native-A',
      sourceId: 'observer-A', sequence: 1, nativeTurnId: 'native-turn-A' })
    for (const reason of ['answer', 'error', 'refusal', 'aborted']) {
      const end = event('turn.complete', { reason, isAborted: reason === 'aborted' })
      expect(end.currentActivity?.state).toBe('idle')
      expect(end.semanticState).toBe(reason === 'error' ? 'error' : 'unknown')
      expect(end.lifecycleEvent).toBe(reason === 'error' ? 'turn-end' : null)
      expect(end.status.detail).toBe(reason === 'error'
        ? 'The native Claude turn ended in error; the original error code is unavailable.'
        : 'turn.complete')
      expect(end.interaction).toBeUndefined()
    }
    expect(event('turn.complete', { agent_id: 'child-A', reason: 'answer', isAborted: false }).currentActivity)
      .toBeUndefined()
    expect(event('AgentMuxActivityUnavailable', { reason: 'source-changed' }).currentActivity)
      .toEqual({ state: 'unknown', nativeSessionId: 'native-A', sourceId: 'observer-A', sequence: 1 })
    for (const extra of [{ session_id: '' }, { turnId: '' }, { sourceId: '' }, { sequence: -1 }, { sequence: 1.1 }, { sequence: Infinity }]) {
      const start = event('turn.start', extra)
      expect(start.currentActivity).toBeUndefined()
      expect(start.semanticState).toBe('unknown')
      expect(start.lifecycleEvent).toBeNull()
    }
    expect(event('turn.complete', { reason: 'answer', isAborted: true }).currentActivity).toBeUndefined()
    for (const extra of [{ sourceId: '' }, { sequence: -1 }, { turnId: '' }, { isAborted: true }]) {
      const end = event('turn.complete', { reason: 'error', isAborted: false, ...extra })
      expect(end.currentActivity).toBeUndefined()
      expect(end.semanticState).toBe('unknown')
      expect(end.lifecycleEvent).toBeNull()
      expect(end.status.detail).toBe('turn.complete')
    }
  })

  it('a resumed child keeps its current native turn when the prior turn end arrives late', () => {
    const provider = new AgentProviderRegistry().get('claude')
    const runId = 'run-native-child-resume'
    const child = (eventName: string, turnId: string, sequence: number) => provider.normalizeHook({
      receiptId: `child-${sequence}`, agentSessionId: 'core-child', runId, providerId: 'claude', eventName,
      payload: { session_id: 'native-main', agent_id: 'same-child', sourceId: 'same-observer', sequence,
        turnId, ...(eventName === 'turn.complete' ? { reason: 'answer', isAborted: false } : {}) }
    }, {})
    try {
      child('SubagentStart', 'not-a-native-turn', 1)
      expect(agentHasActiveSubagents(runId)).toBe(false)
      child('turn.start', 'old-turn', 2)
      child('turn.start', 'resumed-turn', 3)
      expect(agentHasActiveSubagents(runId)).toBe(true)
      child('turn.complete', 'old-turn', 4)
      expect(agentHasActiveSubagents(runId)).toBe(true)
      child('turn.complete', 'resumed-turn', 5)
      expect(agentHasActiveSubagents(runId)).toBe(false)
    } finally { releaseSubagentRoster(runId) }
  })

  it.each(['throws', 'empty'])('a %s original actor capture reports a diagnostic without claiming or rebinding an actor', async failure => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-claude-native-source-'))
    const modulePath = join(directory, 'register.mjs')
    const calls: Array<{ stdin: string }> = []
    const sessionId = vi.fn(async () => {
      if (failure === 'throws') throw new Error('Original actor getter unavailable')
      return ' '
    })
    const api = { env: { get: async () => '1' }, session: { id: sessionId },
      process: { run: async (_argv: string[], init: { stdin: string }) => {
        calls.push(init); return { exitCode: 0, stdout: '{}\n', stderr: '' }
      } }, ui: { log: vi.fn() } }
    type Handler = (client: typeof api, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
    const handlers = new Map<string, Handler>()
    try {
      await writeFile(modulePath, claudeNativeActivitySource())
      const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
        register(on: (name: string, handler: Handler) => void): void
      }
      module.register((name, handler) => { handlers.set(name, handler); return { catch() {} } })
      const next = (event: Record<string, unknown>) => ({ original: event })
      const sessionStart = { original: 'native session start' }
      expect(await handlers.get('session.start')!(api, sessionStart, next)).toEqual({ original: sessionStart })
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      const payload = JSON.parse(calls[0]!.stdin)
      expect(payload).toMatchObject({ hook_event_name: 'AgentMuxActivityUnavailable', reason: 'source-identity-unavailable', sequence: 1 })
      expect(payload).not.toHaveProperty('session_id')
      expect(payload).not.toHaveProperty('turnId')
      expect(payload).not.toHaveProperty('agent_id')
      const provider = new AgentProviderRegistry().get('claude')
      const normalize = (extra = {}) => provider.normalizeHook({ receiptId: 'source-unavailable',
        agentSessionId: 'core-source', runId: 'run-source', providerId: 'claude', payload: { ...payload, ...extra } }, {})
      const diagnostic = normalize()
      expect(diagnostic.observationFailure).toEqual({ code: 'AGENT_NATIVE_ACTIVITY_UNAVAILABLE', source: { sourceId: payload.sourceId, sequence: payload.sequence },
        message: 'The native activity observer could not capture its original actor identity. Current activity is unconfirmed. The original Session, Run and input remain available; a subsequent original-identity Run can establish a fresh observer.' })
      expect(diagnostic.semanticState).toBe('unknown')
      expect(diagnostic.lifecycleEvent).toBeNull()
      expect(diagnostic.currentActivity).toBeUndefined()
      expect(diagnostic.nativeHandle).toBeUndefined()
      expect(diagnostic.interaction).toBeUndefined()
      for (const extra of [{ session_id: 'unconfirmed-actor' }, { agent_id: 'child' }, { sourceId: '' }, { sequence: 0 }]) {
        expect(normalize(extra).observationFailure).toBeUndefined()
      }
      sessionId.mockResolvedValue('later-native-actor')
      expect(await handlers.get('session.start')!(api, {}, next)).toEqual({ original: {} })
      const turn = { turnId: 'later-turn', reason: 'answer', isAborted: false }
      expect(handlers.get('turn.start')!(api, turn, next)).toEqual({ original: turn })
      expect(handlers.get('turn.complete')!(api, turn, next)).toEqual({ original: turn })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(sessionId).toHaveBeenCalledTimes(1)
      expect(calls).toHaveLength(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('generated callbacks preserve native results, serialize delivery and freeze their original actor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-claude-native-mod-'))
    const modulePath = join(directory, 'register.mjs')
    const calls: Array<{ argv: string[]; init: { stdin: string; env: Record<string, string> } }> = []
    let currentSessionId = 'original-native'
    let release: (() => void) | undefined
    const firstDelivery = new Promise<void>(resolve => { release = resolve })
    let processCalls = 0
    let failNext = false
    const api = {
      env: { get: async () => '1' }, session: { id: async () => currentSessionId },
      process: { run: async (argv: string[], init: { stdin: string; env: Record<string, string> }) => {
        calls.push({ argv, init })
        if (++processCalls === 1) await firstDelivery
        const stderr = failNext ? 'receipt delivery unconfirmed' : ''
        failNext = false
        return { exitCode: 0, stdout: '{}\n', stderr }
      } },
      ui: { log: vi.fn(async () => {}) }
    }
    type Handler = (client: typeof api, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
    const handlers = new Map<string, Handler>()
    try {
      await writeFile(modulePath, claudeNativeActivitySource())
      const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
        register(on: (name: string, handler: Handler) => void): void
      }
      module.register((name, handler) => { handlers.set(name, handler); return { catch() {} } })
      const next = (event: Record<string, unknown>) => ({ original: event })
      await handlers.get('session.start')!(api, {}, next)
      const start = { turnId: 'actual-turn-A', text: 'user content' }
      expect(handlers.get('turn.start')!(api, start, next)).toEqual({ original: start })
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      const complete = { turnId: 'actual-turn-A', reason: 'answer', isAborted: false }
      expect(handlers.get('turn.complete')!(api, complete, next)).toEqual({ original: complete })
      expect(calls).toHaveLength(1)
      release!()
      await vi.waitFor(() => expect(calls).toHaveLength(2))
      expect(calls.map(call => JSON.parse(call.init.stdin).sequence)).toEqual([1, 2])
      expect(calls.map(call => JSON.parse(call.init.stdin).turnId)).toEqual(['actual-turn-A', 'actual-turn-A'])
      expect(calls[0]!.argv.at(-1)).toContain('agentmux-hook.js')
      expect(calls[0]!.init.env.AGENTMUX_HOOK_PROVIDER).toBe('claude')
      handlers.get('turn.complete')!(api, { ...complete, agentId: 'child-A' }, next)
      await vi.waitFor(() => expect(calls).toHaveLength(3))
      expect(JSON.parse(calls[2]!.init.stdin)).toMatchObject({ hook_event_name: 'turn.complete',
        agent_id: 'child-A', turnId: 'actual-turn-A', sequence: 3 })
      failNext = true
      handlers.get('turn.start')!(api, { turnId: 'actual-turn-B' }, next)
      await vi.waitFor(() => expect(calls).toHaveLength(4))
      handlers.get('turn.complete')!(api, { ...complete, turnId: 'actual-turn-B' }, next)
      await vi.waitFor(() => expect(calls).toHaveLength(5))
      expect(JSON.parse(calls[4]!.init.stdin)).toMatchObject({ hook_event_name: 'AgentMuxActivityUnavailable',
        reason: 'delivery-gap', sequence: 5 })
      handlers.get('turn.start')!(api, { turnId: 'actual-turn-C' }, next)
      await vi.waitFor(() => expect(calls).toHaveLength(6))
      expect(JSON.parse(calls[5]!.init.stdin)).toMatchObject({ hook_event_name: 'turn.start',
        turnId: 'actual-turn-C', sequence: 6 })
      currentSessionId = 'new-native'
      const reset = { hook_event_name: 'SessionStart', source: 'clear', session_id: 'new-native' }
      expect(handlers.get('classic.SessionStart')!(api, reset, next)).toEqual({ original: reset })
      await vi.waitFor(() => expect(calls).toHaveLength(7))
      expect(JSON.parse(calls[6]!.init.stdin)).toMatchObject({ hook_event_name: 'AgentMuxActivityUnavailable',
        session_id: 'original-native', reason: 'source-changed', sequence: 7 })
      handlers.get('turn.start')!(api, { turnId: 'queued-old-turn' }, next)
      await vi.waitFor(() => expect(calls).toHaveLength(8))
      expect(JSON.parse(calls[7]!.init.stdin)).toMatchObject({ hook_event_name: 'AgentMuxActivityUnavailable',
        session_id: 'original-native', reason: 'source-changed', sequence: 8 })
      currentSessionId = 'original-native'
      handlers.get('turn.complete')!(api, { ...complete, agentId: 'child-A' }, next)
      await vi.waitFor(() => expect(calls).toHaveLength(9))
      expect(JSON.parse(calls[8]!.init.stdin).hook_event_name).toBe('AgentMuxActivityUnavailable')
    } finally {
      release?.()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports the exact end of a main call Claude asked about, without touching native results or other tools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-claude-asked-end-'))
    const modulePath = join(directory, 'register.mjs')
    const calls: Array<{ argv: string[]; init: { stdin: string; env: Record<string, string> } }> = []
    const api = { env: { get: async () => '1' }, session: { id: async () => 'original-native' },
      process: { run: async (argv: string[], init: { stdin: string; env: Record<string, string> }) => {
        calls.push({ argv, init }); return { exitCode: 0, stdout: '{}\n', stderr: '' } } },
      ui: { log: vi.fn(async () => {}) } }
    type Handler = (client: typeof api, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
    const handlers = new Map<string, Handler>()
    try {
      await writeFile(modulePath, claudeNativeActivitySource())
      const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as { register(on: (name: string, handler: Handler) => void): void }
      module.register((name, handler) => { handlers.set(name, handler); return { catch() {} } })
      await handlers.get('session.start')!(api, {}, event => event)
      const check = (event: Record<string, unknown>, decision: string) => handlers.get('tool.check')!(api, event, async () => ({ decision }))
      const call = (event: Record<string, unknown>, settle: () => Promise<unknown>) => handlers.get('tool.call')!(api, event, settle)
      // Ordinary allowed tools add no observation.
      expect(await check({ tool: 'Read', tool_use_id: 'toolu_read' }, 'allow')).toEqual({ decision: 'allow' })
      expect(await call({ tool: 'Read', tool_use_id: 'toolu_read' }, async () => ({ ref: 1, result: 'contents' }))).toEqual({ ref: 1, result: 'contents' })
      // A child Agent's ask belongs to its own subject.
      await check({ tool: 'Bash', tool_use_id: 'toolu_child', agentId: 'child-A' }, 'ask')
      await call({ tool: 'Bash', tool_use_id: 'toolu_child', agentId: 'child-A' }, async () => ({ ref: 1, result: 'Error: rejected' }))
      // A declined main ask: the native rejection is returned unchanged, then its exact end is reported once.
      const rejected = { ref: 1, result: "Error: The user doesn't want to proceed with this tool use." }
      expect(await check({ tool: 'AskUserQuestion', tool_use_id: 'toolu_question' }, 'ask')).toEqual({ decision: 'ask' })
      expect(await call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_question' }, async () => rejected)).toBe(rejected)
      // A throwing native call still ends its request and keeps the original failure. The reported
      // tool is the asked one, even when the call's own arguments carry a \`tool\` field.
      await check({ tool: 'Bash', tool_use_id: 'toolu_bash' }, 'ask')
      await expect(call({ tool: 'shadow', tool_use_id: 'toolu_bash' }, async () => { throw new Error('native failure') })).rejects.toThrow('native failure')
      await vi.waitFor(() => expect(calls).toHaveLength(2))
      expect(calls.map(entry => JSON.parse(entry.init.stdin))).toEqual([
        { hook_event_name: CLAUDE_ASKED_TOOL_END_EVENT, session_id: 'original-native', tool_use_id: 'toolu_question', tool_name: 'AskUserQuestion' },
        { hook_event_name: CLAUDE_ASKED_TOOL_END_EVENT, session_id: 'original-native', tool_use_id: 'toolu_bash', tool_name: 'Bash' }
      ])
      expect(calls[0]!.argv.at(-1)).toContain('agentmux-hook.js')
      expect(calls[0]!.init.env.AGENTMUX_HOOK_PROVIDER).toBe('claude')
      // Each asked call ends once; a repeated call settle for the same id reports nothing new.
      await call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_question' }, async () => rejected)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(calls).toHaveLength(2)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('gives Claude’s classic ask the identity of the one exact asked main call, and none when ambiguous', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-claude-ask-identity-'))
    const modulePath = join(directory, 'register.mjs')
    const api = { env: { get: async () => '1' }, session: { id: async () => 'original-native' },
      process: { run: async () => ({ exitCode: 0, stdout: '{}\n', stderr: '' }) }, ui: { log: vi.fn(async () => {}) } }
    type Handler = (client: typeof api, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
    const handlers = new Map<string, Handler>()
    try {
      await writeFile(modulePath, claudeNativeActivitySource())
      const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as { register(on: (name: string, handler: Handler) => void): void }
      module.register((name, handler) => { handlers.set(name, handler); return { catch() {} } })
      await handlers.get('session.start')!(api, {}, event => event)
      const check = (event: Record<string, unknown>, decision: string) => handlers.get('tool.check')!(api, event, async () => ({ decision }))
      const ask = (event: Record<string, unknown>) => handlers.get('classic.PermissionRequest')!(api, event, value => value) as Record<string, unknown>
      const call = (event: Record<string, unknown>) => handlers.get('tool.call')!(api, event, async () => ({ ref: 1, result: 'ok' }))
      const input = { command: 'mkdir -p build/probe', description: 'Create probe directory' }
      const classic = { hook_event_name: 'PermissionRequest', session_id: 'original-native', tool_name: 'Bash', tool_input: input, permission_suggestions: [] }
      // An ask Claude did not route through a main tool.check stays as Claude sent it.
      expect(await ask(classic)).toBe(classic)
      await check({ tool: 'Bash', tool_use_id: 'toolu_one', input }, 'ask')
      // A child Agent's identical ask never borrows a main call.
      expect(await ask({ ...classic, agent_id: 'child-A' })).toEqual({ ...classic, agent_id: 'child-A' })
      // Another input or tool is not this call.
      expect(await ask({ ...classic, tool_input: { ...input, command: 'rm -rf build' } })).not.toHaveProperty('tool_use_id')
      expect(await ask({ ...classic, tool_name: 'Edit' })).not.toHaveProperty('tool_use_id')
      // The one exact asked call: the original fields are kept and its identity is added.
      expect(await ask(classic)).toEqual({ ...classic, tool_use_id: 'toolu_one' })
      // Its identity is given once: an identical later ask (still running call A) borrows nothing.
      expect(await ask(classic)).toBe(classic)
      // Two identical unidentified asks in flight are ambiguous; no identity is guessed.
      await check({ tool: 'Bash', tool_use_id: 'toolu_two', input }, 'ask')
      await check({ tool: 'Bash', tool_use_id: 'toolu_three', input }, 'ask')
      expect(await ask(classic)).toBe(classic)
      // Once one ends, the remaining call is exact again.
      await call({ tool: 'Bash', tool_use_id: 'toolu_two' })
      expect(await ask(classic)).toEqual({ ...classic, tool_use_id: 'toolu_three' })
      // Equal arguments in another property order are the same call.
      await check({ tool: 'Bash', tool_use_id: 'toolu_four', input: { description: input.description, command: 'ls' } }, 'ask')
      expect(await ask({ ...classic, tool_input: { command: 'ls', description: input.description } })).toMatchObject({ tool_use_id: 'toolu_four' })
      // A native identity Claude already sent is never replaced.
      expect(await ask({ ...classic, tool_use_id: 'toolu_native' })).toEqual({ ...classic, tool_use_id: 'toolu_native' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('outside an AgentMux-launched session the observer never touches Claude’s ask or reports ends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-claude-ask-outside-'))
    const modulePath = join(directory, 'register.mjs')
    const runs: unknown[] = []
    const api = { env: { get: async () => undefined }, session: { id: async () => 'someone-else' },
      process: { run: async (...args: unknown[]) => { runs.push(args); return { exitCode: 0, stdout: '{}\n', stderr: '' } } }, ui: { log: vi.fn(async () => {}) } }
    type Handler = (client: typeof api, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
    const handlers = new Map<string, Handler>()
    try {
      await writeFile(modulePath, claudeNativeActivitySource())
      const module = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as { register(on: (name: string, handler: Handler) => void): void }
      module.register((name, handler) => { handlers.set(name, handler); return { catch() {} } })
      await handlers.get('session.start')!(api, {}, event => event)
      const input = { command: 'ls' }
      await handlers.get('tool.check')!(api, { tool: 'Bash', tool_use_id: 'toolu_out', input }, async () => ({ decision: 'ask' }))
      const classic = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input }
      expect(await handlers.get('classic.PermissionRequest')!(api, classic, value => value)).toBe(classic)
      await handlers.get('tool.call')!(api, { tool: 'Bash', tool_use_id: 'toolu_out' }, async () => ({ ref: 1 }))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(runs).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

/**
 * T-006 的 Provider 测试。
 *
 * 证据来自**读本机安装的 claude CLI**（`~/.local/share/claude/versions/2.1.252`，单文件 bun 打包）：
 * 事件全集取自它的 `_y` 数组（33 个），每个事件的负载形状取自同文件里的 zod schema，
 * matcher 归属取自它内嵌文档的 Hook Events 表。
 *
 * 这些断言证明「声明与本机 CLI 读出的合同相符」，**不**证明「跑过一次真实会话并收到了这些事件」。
 */
describe('Claude provider', () => {
  const providers = new AgentProviderRegistry()
  const claude = providers.get('claude')

  function hook(eventName: string, payload: Record<string, unknown> = {}) {
    return claude.normalizeHook({
      receiptId: `r-${eventName}`,
      agentSessionId: 's-claude',
      runId: 'run-claude',
      providerId: 'claude',
      eventName,
      payload: { hook_event_name: eventName, session_id: 'sess-1', ...payload }
    }, {})
  }

  function toolMutation(event: ReturnType<typeof hook>) {
    const mutation = event.timeline.find(
      (candidate) => candidate.type !== 'update' && candidate.item.kind === 'tool_call'
    )
    if (!mutation || mutation.type === 'update') {
      throw new Error('expected a tool_call timeline item carrying a full item')
    }
    return mutation
  }

  /**
   * 本 task 的核心守卫：**rules 里引用的每个事件都必须真的被安装**。
   *
   * 这是一族真实存在过的缺陷，不是假想的：`CLAUDE_HOOKS.rules` 引用 `PostToolUseFailure`、
   * `StopFailure`、`PreCompact`，而 `CLAUDE_HOOK_EVENTS`（决定往 settings.json 写什么）三个都不含。
   * 于是 Claude 从不发它们，rules 里那三个名字永远命中不到——声明看着完整，运行时是死的。
   * 同族的 grok Provider 反倒把 `PostToolUseFailure`/`StopFailure` 装上了，说明这是 Claude 独有的遗漏。
   *
   * 守的是「两份清单的一致性」而不是「清单等于某个字面量列表」：后者只会在有人改清单时提醒改测试，
   * 前者才会在有人**只改一半**时报红。
   */
  describe('声明与安装必须一致：rules 引用的事件都得真装上', () => {
    it('rules 与 subagentTracking 引用的每个事件都在安装清单里', () => {
      const referenced = new Set<string>()
      for (const rule of CLAUDE_HOOKS.rules) for (const eventName of rule.events) referenced.add(eventName)
      const tracking = CLAUDE_HOOKS.subagentTracking
      for (const eventName of [
        ...(tracking?.startEvents ?? []), ...(tracking?.stopEvents ?? []), ...(tracking?.mainStopEvents ?? [])
      ]) referenced.add(eventName)

      const installed = new Set<string>([...CLAUDE_HOOK_EVENTS, 'turn.start', 'turn.complete', 'AgentMuxActivityUnavailable', CLAUDE_ASKED_TOOL_END_EVENT])
      const declaredButNotInstalled = [...referenced].filter((eventName) => !installed.has(eventName))
      expect(declaredButNotInstalled).toEqual([])
    })

    it('三个补装的事件确实写进了 settings.json，而不只是进了常量清单', () => {
      // 常量清单绿了但计划没渲染出来，等于装了个假。这条读真实渲染结果。
      const plan = (new AgentProviderRegistry().get('claude').planManagedHooks?.({ workspacePath: fixturePath("tmp/work") }) ?? null)
      const written = JSON.parse(plan!.mutations[0]!.content) as {
        hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
      }
      for (const eventName of ['PostToolUseFailure', 'StopFailure', 'PreCompact']) {
        expect(written.hooks[eventName]?.[0]?.hooks?.[0]?.command).toContain('agentmux-hook.js')
      }
      // 安装的事件集恰好等于声明的清单——没有多写没有少写。
      expect(Object.keys(written.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort())
    })

    it('三个 tool 事件都带 matcher，其余生命周期事件都不带', () => {
      // 本机 bundle 内嵌文档的 Hook Events 表里，PreToolUse/PostToolUse/PostToolUseFailure 的
      // Matcher 列都是 "Tool name"。缺了 matcher，Claude 对 tool 事件不会分派到我们这条。
      const written = JSON.parse(createClaudeManagedHookPlan(fixturePath("tmp/work")).mutations[0]!.content) as {
        hooks: Record<string, Array<{ matcher?: string }>>
      }
      const withMatcher = Object.entries(written.hooks)
        .filter(([, entries]) => entries[0]?.matcher !== undefined)
        .map(([eventName]) => eventName).sort()
      expect(withMatcher).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse'])
      expect(new Set(Object.values(written.hooks).map((entries) => entries[0]?.matcher)))
        .toEqual(new Set(['*', undefined]))
    })

    it('不装那些每次文件变动/每条通知都触发的高频与 UI 事件', () => {
      // 本机 CLI 的事件全集有 33 个。装这些等于把子进程挂到最热的路径上，而 Core 没有判断需要它们。
      for (const hot of [
        'FileChanged', 'CwdChanged', 'DirectoryAdded', 'MessageDisplay', 'StatusLine',
        'FileSuggestion', 'Notification', 'PostToolBatch'
      ]) {
        expect(CLAUDE_HOOK_EVENTS).not.toContain(hot)
      }
    })
  })

  describe('一次失败的工具调用：判红之外还要看得见原因', () => {
    it('PostToolUseFailure 判 failed 并把 error 当正文——它没有 tool_response', () => {
      // 本机 schema 逐字：{tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?}。
      // **没有** tool_response——`PostToolUse` 只在成功时触发（内嵌文档："Run after successful tool"）。
      // 少了对 `error` 的正文回退，用户只看得见一个红标记，看不见 "exit status 1" 这句话。
      const failure = toolMutation(hook('PostToolUseFailure', {
        tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-9',
        error: 'exit status 1: 3 tests failed', is_interrupt: false, duration_ms: 900
      }))
      expect(failure.type).toBe('upsert')
      expect(failure.item.id).not.toContain('r-PostToolUseFailure')
      expect(failure.item.status).toBe('failed')
      expect(failure.item.toolOutput).toBe('exit status 1: 3 tests failed')
    })

    it('PostToolUse 成功路径仍读 tool_response，不被失败回退抢走', () => {
      const success = toolMutation(hook('PostToolUse', {
        tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-9',
        tool_response: { stdout: '12 passed' }
      }))
      expect(success.item.status).toBe('complete')
      expect(success.item.toolOutput).toBe('12 passed')
    })

    it('PostToolUseFailure 与 PreToolUse 收敛到同一条，而不是并排两行', () => {
      const pre = toolMutation(hook('PreToolUse', {
        tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-9'
      }))
      expect(pre.item.status).toBe('streaming')
      const failure = toolMutation(hook('PostToolUseFailure', {
        tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu-9', error: 'boom'
      }))
      expect(failure.item.id).toBe(pre.item.id)
    })

    it('只有 is_interrupt 没有 error 时不判失败——它证明不了这一步的成败', () => {
      const blank = toolMutation(hook('PostToolUseFailure', {
        tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu-x', is_interrupt: true
      }))
      expect(blank.item.status).toBe('complete')
    })
  })

  describe('两条互斥的收尾：Stop 与 StopFailure', () => {
    it('Stop 与 SubagentStop 回调在决策前到达，不证明最终主轮/子轮成功，显式声明 lifecycleEvent: null 与 semanticState: unknown', () => {
      for (const stop_hook_active of [false, true]) {
        const stopEvent = hook('Stop', {
          stop_hook_active,
          last_assistant_message: 'Done with task'
        })
        expect<AgentSemanticState>(stopEvent.semanticState).toBe('unknown')
        expect(stopEvent.lifecycleEvent).toBeNull()
      }
      const subStopEvent = hook('SubagentStop', {
        agent_id: 'sub-1',
        stop_hook_active: false
      })
      expect<AgentSemanticState>(subStopEvent.semanticState).toBe('unknown')
      expect(subStopEvent.lifecycleEvent).toBeNull()
    })

    it('StopFailure 判 error 并归入 turn-end——它取代 Stop，报错收尾不会有 Stop，且不伪造 done/成功完成', () => {
      // 少了它，Agent 报错后会永远停在 working，且没有任何后续事件能把它救回来。
      const event = hook('StopFailure', { error: 'model overloaded', error_details: 'HTTP 529' })
      expect<AgentSemanticState>(event.semanticState).toBe('error')
      expect(event.lifecycleEvent).toBe('turn-end')
    })

    it('Stop 与 StopFailure 都是用量落定点，用量收口两侧共用同一份口径', () => {
      // Transcript sampling is declared separately: pre-decision Stop does not establish turn-end.
      for (const eventName of ['Stop', 'StopFailure']) {
        expect(canonicalHookLifecycleEvent(eventName)).toBe(eventName === 'StopFailure' ? 'turn-end' : undefined)
        expect(USAGE_FINALIZATION_EVENTS.has(eventName)).toBe(true)
      }
    })

    it('PreCompact 判 working：压缩期间没有工具事件，少了它长压缩看起来像卡死', () => {
      const event = hook('PreCompact', { trigger: 'auto', custom_instructions: null })
      expect(event.semanticState).toBe('working')
      // Core 今天没有判断需要「压缩」这一步，故刻意不给 canonical 生命周期。
      expect(event.lifecycleEvent).toBeUndefined()
    })

    it('未安装的事件到达时保持可诊断，绝不伪造状态', () => {
      // PostCompact/SessionEnd/TeammateIdle 都是本机 CLI 真实存在的事件，只是我们没装。万一从别处
      // 到达（用户自己在 settings.json 里加了同一条命令），必须如实说不认识而不是补一个 working。
      for (const eventName of ['PostCompact', 'SessionEnd', 'TeammateIdle', 'TaskCompleted']) {
        const event = hook(eventName)
        expect(event.semanticState).toBe('unknown')
        expect(event.status.detail).toBe(eventName)
      }
    })
  })

  describe('nativeHandle 与 usage 的声明都有本机佐证', () => {
    it('从负载读出 session_id 与 transcript_path，两者都是 resume 与用量的前提', () => {
      const event = hook('Stop', {
        stop_hook_active: false, transcript_path: fixturePath("tmp/t.jsonl"), last_assistant_message: 'done'
      })
      expect(event.nativeHandle).toEqual({
        kind: 'provider', providerId: 'claude', sessionId: 'sess-1', transcriptPath: fixturePath("tmp/t.jsonl")
      })
    })

    it('catalog 的 usage 声明与真实 transcript 格式一致', () => {
      expect(claude.catalog.capabilities.usage)
        .toEqual({ kind: 'native-transcript', transcriptFormat: 'claude-jsonl' })
      expect(claude.catalog.capabilities.permission).toBe('respond')
    })
  })
})

describe('Claude Stop pre-decision observation through built public Core and FileStore', () => {
  afterEach(() => vi.unstubAllEnvs())

  const sessionId = 'claude-test-session'
  const runId = 'claude-test-run'
  const token = 'c'.repeat(43)

  async function claudeHarness(planMode: 'render-then-submit' | 'single-phase') {
    const root = await mkdtemp(join(tmpdir(), 'amux-claude-stop-'))
    const path = join(root, 'sessions.json')
    const workspacePath = join(root, 'workspace')
    await mkdir(workspacePath)
    await mkdir(join(root, 'runtime'))

    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
    vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', path)

    let claudeDef!: Parameters<typeof defineAgentProvider>[0]
    const baseClaude = createClaudeProvider((def: Parameters<typeof defineAgentProvider>[0]) => {
      claudeDef = def
      return defineAgentProvider(def)
    })
    const { terminalPromptRender: _omittedRender, ...singlePhaseBase } = claudeDef
    const provider = planMode === 'render-then-submit'
      ? baseClaude
      : defineAgentProvider({
          ...singlePhaseBase,
          planPromptInput: (prompt: string) => ({ kind: 'single-phase', data: prompt + '\r' })
        })

    const store = new AgentMuxFileAgentSessionStore(path)
    await store.compareAndSwap(null, {
      kind: 'agent',
      agentSessionId: sessionId,
      providerId: 'claude',
      executorId: 'claude',
      hostId: 'local',
      workspacePath,
      run: { runId },
      retiredRuns: [],
      hookBindingId: 'b'.repeat(43),
      hookToken: token,
      createdAt: 1,
      updatedAt: 1,
      semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 }
    })

    let cursor = 10
    let outputCursor = 0
    const writes: string[] = []
    const chunks: OutputChunk[] = []
    const streams = new Set<{ push(event: RunEvent): void; close(): void }>()
    const run = () => ({
      native_service: null,
      id: runId,
      spec: { program: 'claude', args: [], cwd: workspacePath, env: {} },
      lineage: null,
      pid: 321,
      state: { type: 'running' as const },
      latest_output_bytes: outputCursor,
      durable_output_bytes: outputCursor,
      first_available_byte: 0,
      attachments: streams.size,
      applied_input_bytes: cursor,
      current_size: { cols: 80, rows: 24 }
    })

    function output(text: string) {
      const data = new TextEncoder().encode(text)
      const chunk = { start_byte: outputCursor, end_byte: outputCursor + data.byteLength, data }
      outputCursor = chunk.end_byte
      chunks.push(chunk)
      for (const stream of streams) stream.push({ type: 'output', chunk })
    }

    if (planMode === 'render-then-submit') {
      output('\u001b[?2026h\u001b[22;1H❯ \u001b[22;3H\u001b[?2026l')
    }

    const receipts = new Map<string, { start_byte: number; end_byte: number; data: string }>()
    const recoverableInput = vi.fn(async (op: {
      daemonInstance: string; operationKey: string; runId: string; expectedByte: number; data: string
    }) => {
      expect(op.daemonInstance).toBe('claude-daemon')
      expect(op.runId).toBe(runId)
      const existing = receipts.get(op.operationKey)
      if (existing) return { run: run(), receipt: existing }
      expect(op.expectedByte).toBe(cursor)
      const receipt = { start_byte: cursor, end_byte: cursor + Buffer.byteLength(op.data), data: op.data }
      cursor = receipt.end_byte
      receipts.set(op.operationKey, receipt)
      writes.push(op.data)
      if (planMode === 'render-then-submit' && op.data !== '\r') {
        output(`\u001b[?2026h\u001b[2J\u001b[22;1H❯ ${op.data}\u001b[22;${3 + op.data.length}H\u001b[?2026l`)
      }
      return { run: run(), receipt }
    })

    const attachTerminal = vi.fn(async (id: string) => {
      expect(id).toBe(runId)
      let closed = false, wake: (() => void) | undefined
      const queue: RunEvent[] = []
      const stream = {
        push(event: RunEvent) { queue.push(event); wake?.() },
        close() { closed = true; wake?.(); streams.delete(stream) }
      }
      streams.add(stream)
      return {
        snapshot: {
          run: run(),
          resize_revision: 0,
          terminal: {
            type: 'basic_vt',
            checkpoint: { restore_size: { cols: 80, rows: 24 }, restore_scrollback_rows: null, resize_after_restore_bytes: 0, run_id: runId, through_byte: 0, resize_revision: 0, size: { cols: 80, rows: 24 } },
            resizes: []
          },
          terminal_restore: new TextEncoder().encode('\u001bc'),
          replay: { chunks: [...chunks], first_available_byte: 0, latest_output_bytes: outputCursor, truncated: false }
        },
        async *events() {
          while (!closed) {
            if (queue.length) yield queue.shift()!
            else await new Promise<void>(resolve => { wake = resolve })
          }
        },
        detach: async () => stream.close(),
        close: () => stream.close()
      }
    })

    const start = vi.fn(async () => { throw new Error('Unexpected native Run creation') })
    const stop = vi.fn(async () => { throw new Error('Unexpected native Run stop') })

    const clients: AgentMuxClient[] = []
    async function connect() {
      const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(path), providers: [provider] })
      const adapter = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
      Object.assign(adapter, {
        client: {
          list: async () => [{ id: runId }],
          status: async () => run(),
          recoverableInput,
          attach: attachTerminal,
          attachTerminal,
          start,
          stop
        },
        runtime: { daemonInstanceId: 'claude-daemon' }
      })
      clients.push(client)
      await client.connect()
      return client
    }

    const client = await connect()
    // Establish the previous prompt through current admission and real fixture SDK receipts.
    await client.submitAgentPrompt({
      ...agentPromptCondition(client.agentSession(sessionId)),
      agentSessionId: sessionId,
      operationId: 'prior-sub',
      prompt: 'prior prompt',
      allowUncertainTurn: true
    })
    const prior = client.agentSession(sessionId).promptCompletionAdmission!
    expect(prior.submissionId).toBe('prior-sub')
    expect(prior.acknowledged).toBe(true)
    const priorReceipts = [...receipts.values()]
    expect(priorReceipts.length).toBeGreaterThan(0)
    expect(priorReceipts[0]!.start_byte).toBe(prior.startByte)
    expect(priorReceipts.at(-1)!.end_byte).toBe(prior.endByte)
    expect((await client.listRuns()).find(run => run.runId === runId)!.acceptedInputBytes).toBe(prior.endByte)
    // The callback counts only its own submissions; retain the prior receipt in the SDK ledger.
    writes.length = 0
    let receiptCounter = 0

    async function feed(eventName: string, payload: Record<string, unknown> = {}) {
      const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          receiptId: `claude-rcpt-${++receiptCounter}`,
          eventName,
          payload: { hook_event_name: eventName, ...payload }
        })
      })
      return response.status
    }

    async function stored() {
      const rows = (await new AgentMuxFileAgentSessionStore(path).load()).map(normalizeStoredAgentSession)
      expect(rows).toHaveLength(1)
      return rows[0]!
    }

    return {
      client,
      root,
      feed,
      stored,
      writes,
      start,
      stop,
      async reopen() {
        await client.dispose()
        const env = { ...process.env }
        for (const k of Object.keys(env)) if (k.startsWith('AGENTMUX_')) delete env[k]
        return await connect()
      },
      async close() {
        for (const c of clients) await c.dispose()
        for (const s of streams) s.close()
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
      }
    }
  }

  it.each(['render-then-submit', 'single-phase'] as const)(
    'Claude %s: Stop over HTTP leaves turn unconfirmed without synthesizing turn-end or prompt readiness',
    async (planMode) => {
      const h = await claudeHarness(planMode)
      try {
        const initial = await h.stored()
        expect(initial.semanticStatus?.state).toBe('working')

        // Send real Claude Stop payload over HTTP
        const status = await h.feed('Stop', {
          session_id: 'sess-claude',
          transcript_path: fixturePath("tmp/claude.jsonl"),
          stop_hook_active: false,
          last_assistant_message: 'Finished inspecting files.'
        })
        expect(status).toBe(204)

        const observed = await h.stored()
        // Must declare explicit lifecycle null, not turn-end
        expect(observed.hookReceipt).toMatchObject({
          eventName: 'Stop',
          lifecycleEvent: null
        })
        // Semantic status must NOT flip to done
        expect(observed.semanticStatus?.state).toBe('working')
        // No false prompt readiness
        expect(observed.terminalPromptReadiness).toBeUndefined()
        // No false completion identity or turn end boundary
        expect(agentTurnCompletionIdentity(observed)).toBeUndefined()
        expect(agentTurnEndBoundary(observed)).toBeUndefined()

        // Fresh client recovery sees identical state
        const reopenedClient = await h.reopen()
        const reopenedSession = reopenedClient.agentSession(sessionId)
        expect(reopenedSession.hookReceipt).toEqual(observed.hookReceipt)
        expect(reopenedSession.semanticStatus).toEqual(observed.semanticStatus)

        // Automatic prompt submission with expected completion ID fails
        const automaticSession = reopenedClient.agentSession(sessionId)
        const automaticRun = (await reopenedClient.listRuns()).find(run => run.runId === automaticSession.run.runId)
        expect(automaticRun).toBeDefined()
        expect(Number.isSafeInteger(automaticRun!.acceptedInputBytes)).toBe(true)
        if (!automaticRun || automaticRun.acceptedInputBytes === null) throw new Error('Expected the fixture owner-confirmed input fence')
        await expect(
          reopenedClient.submitAgentPrompt({
            ...agentPromptCondition(automaticSession),
            agentSessionId: sessionId,
            operationId: 'auto-submit',
            prompt: 'next prompt',
            expectedCompletionId: JSON.stringify([runId, 1]),
            expectedInputByte: automaticRun.acceptedInputBytes
          })
        ).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })

        // Manual prompt submission without allowUncertainTurn fails with AGENT_TURN_END_UNCONFIRMED
        await expect(
          reopenedClient.submitAgentPrompt({
            ...agentPromptCondition(reopenedClient.agentSession(sessionId)),
            agentSessionId: sessionId,
            operationId: 'manual-submit-unconfirmed',
            prompt: 'manual prompt'
          })
        ).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })

        // Manual prompt with allowUncertainTurn succeeds in degraded mode
        await reopenedClient.submitAgentPrompt({
          ...agentPromptCondition(reopenedClient.agentSession(sessionId)),
          agentSessionId: sessionId,
          operationId: 'manual-submit-confirmed',
          prompt: 'force continue',
          allowUncertainTurn: true
        })
        const delivered = await h.stored()
        expect(delivered.terminalPromptDelivery).toMatchObject({
          state: 'unverified',
          mode: 'degraded',
          reason: 'turn-end-unconfirmed'
        })

        // Prompt bytes reached kernel without blocking
        expect(h.writes.length).toBeGreaterThan(0)

        // Genuine failure termination (StopFailure) ends the turn cleanly with error semantics, not done
        expect(await h.feed('StopFailure', { error: 'rate limited' })).toBe(204)
        const failedStored = await h.stored()
        expect(failedStored.hookReceipt).toMatchObject({
          eventName: 'StopFailure',
          lifecycleEvent: 'turn-end'
        })
        expect(failedStored.semanticStatus?.state).toBe('error')
        expect(agentTurnCompletionIdentity(failedStored)).toBeUndefined()
        expect(agentTurnEndBoundary(failedStored)).toBeDefined()

        // Automatic prompt submission with expectedCompletionId must be rejected
        const failureSession = reopenedClient.agentSession(sessionId)
        const failureRun = (await reopenedClient.listRuns()).find(run => run.runId === failureSession.run.runId)
        expect(failureRun).toBeDefined()
        expect(Number.isSafeInteger(failureRun!.acceptedInputBytes)).toBe(true)
        if (!failureRun || failureRun.acceptedInputBytes === null) throw new Error('Expected the fixture owner-confirmed input fence')
        await expect(
          reopenedClient.submitAgentPrompt({
            ...agentPromptCondition(failureSession),
            agentSessionId: sessionId,
            operationId: 'auto-submit-after-failure',
            prompt: 'next auto prompt',
            expectedCompletionId: JSON.stringify([runId, failedStored.hookReceipt!.observedAt]),
            expectedInputByte: failureRun.acceptedInputBytes
          })
        ).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })

        // Manual prompt after failure succeeds without allowUncertainTurn because turn ended natively
        await reopenedClient.submitAgentPrompt({
          ...agentPromptCondition(reopenedClient.agentSession(sessionId)),
          agentSessionId: sessionId,
          operationId: 'manual-after-failure',
          prompt: 'retry prompt after failure'
        })

        // Second manual prompt without completion/end fails with AGENT_TURN_END_UNCONFIRMED
        await expect(
          reopenedClient.submitAgentPrompt({
            ...agentPromptCondition(reopenedClient.agentSession(sessionId)),
            agentSessionId: sessionId,
            operationId: 'manual-again',
            prompt: 'too fast'
          })
        ).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })

        // Controls check: start and stop remain strictly uncalled
        expect(h.start).not.toHaveBeenCalled()
        expect(h.stop).not.toHaveBeenCalled()
      } finally {
        await h.close()
      }
    }
  )
})
