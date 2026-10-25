import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeExecutionPolicySource, prepareClaudeExecutionPolicy } from '../src/providers/claude-execution-policy.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
type Event = Record<string, any>
type Verdict = { decision: 'allow' | 'ask' | 'deny'; [key: string]: unknown }
type Hook = ($: any, event: Event, next: any) => any
type Registration = { handler: Hook; recover?: Hook }
type Options = {
  original?: (event: Event) => Verdict | Promise<Verdict>
  transport?: (event: Event) => Verdict | Promise<Verdict>
  originalInput?: (input: Event) => Event
  transportInput?: (input: Event) => Event
  earlyResult?: Event
  remote?: (event: Event) => Event | Promise<Event>
  approveAsk?: boolean
}
const allow: Verdict = { decision: 'allow' }
const nativeResult = (value: unknown) => ({ result: [{ type: 'text', text: JSON.stringify(value) }] })
const bashRecord = { stdout: 'resource-output', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
const inputOf = (event: Event) => Object.fromEntries(Object.entries(event).filter(([key]) => !['tool', 'tool_use_id', 'agentId', 'requestMeta'].includes(key)))
let moduleId = 0

/** Model the native seams: PreToolUse -> actual actor check -> ask -> effect;
 * a tool.call answer aborts the pending continuation beneath that exact call. */
async function policy(options: Options = {}) {
  const registrations = new Map<string, Registration>()
  const source = claudeExecutionPolicySource('original_resource', 'original-routing-plugin')
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + moduleId++)
  module.register((event: string, match: { tool: string }, handler: Hook) => {
    const registration: Registration = { handler }
    registrations.set(event + ':' + match.tool, registration)
    return { catch: (recover: Hook) => { registration.recover = recover } }
  })
  const localEffects = vi.fn(async (_event: Event) => ({ result: 'native-local-result' }))
  const resource = vi.fn(options.remote ?? (() => nativeResult(bashRecord)))
  const originalChecks = vi.fn(options.original ?? (() => allow))
  const transportChecks = vi.fn(options.transport ?? (() => allow))
  const permissionDenied = vi.fn()
  const starts: Event[] = [], aborted: Event[] = [], cancelledErrors: Event[] = [], aliasVerdicts: Verdict[] = []
  let aliasId = 0
  const $ = { tool: {
    call: vi.fn(async (input: Event) => run({ ...input, tool_use_id: 'native-alias-' + aliasId++ }, { plugin: 'original-routing-plugin', tier: 'user' })),
    check: vi.fn(() => { throw new Error('A query cannot authorize an original child actor') })
  } }
  async function dispatch(event: string, input: Event, origin: Event, core: (value: Event, signal: AbortSignal) => Promise<any>, parent?: AbortSignal): Promise<any> {
    const controller = new AbortController(), downstream: Promise<unknown>[] = []
    const abort = () => controller.abort()
    if (parent?.aborted) abort()
    else parent?.addEventListener('abort', abort, { once: true })
    const next = Object.assign(vi.fn((value: Event) => {
      const pending = core(value, controller.signal)
      downstream.push(pending)
      return pending
    }), { origin, signal: controller.signal })
    const registration = registrations.get(event + ':' + input.tool)
    try {
      if (!registration) return await next(input)
      try { return await registration.handler($, input, next) }
      catch (error) {
        if (!registration.recover) throw error
        return await registration.recover($, input, next)
      }
    } finally {
      controller.abort()
      parent?.removeEventListener('abort', abort)
      await Promise.allSettled(downstream)
    }
  }
  async function run(event: Event, origin: Event = { plugin: 'engine', tier: 'core' }): Promise<any> {
    return dispatch('tool.call', event, origin, async (forward, signal) => {
      starts.push(forward)
      const alias = forward.tool.startsWith('mcp__')
      if (!alias && options.earlyResult) return options.earlyResult
      const input = (alias ? options.transportInput : options.originalInput)?.(inputOf(forward)) ?? inputOf(forward)
      const checkEvent = { tool: forward.tool, input, tool_use_id: forward.tool_use_id, ...(forward.agentId === undefined ? {} : { agentId: forward.agentId }) }
      let verdict: Verdict
      try { verdict = await dispatch('tool.check', checkEvent, origin, value => Promise.resolve((alias ? transportChecks : originalChecks)(value)), signal) }
      catch (error) {
        if (signal.aborted) { aborted.push(forward); cancelledErrors.push({ event: forward, error }) }
        throw error
      }
      // Native cancellation is not a second permission verdict. Real CLI probes
      // showed that returning allow here executes locally, while returning deny
      // records a false machine permission denial. Only abort rejection stops it.
      if (verdict.decision === 'deny') permissionDenied(forward, verdict)
      if (alias) aliasVerdicts.push(verdict)
      if (verdict.decision === 'deny' || (verdict.decision === 'ask' && !options.approveAsk)) return { deny: verdict.reason ?? 'Native permission is awaiting approval' }
      const effect = { ...forward, ...input }
      return alias ? resource(effect) : localEffects(effect)
    })
  }
  return { $, run, localEffects, resource, originalChecks, transportChecks, starts, aborted, cancelledErrors, permissionDenied, aliasVerdicts }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Claude original tool execution policy', () => {
  it('reaches the original native actor check and returns the native resource record without a local effect', async () => {
    const p = await policy(), input = { command: 'printf resource-output', timeout: 5000 }
    const result = await p.run({ tool: 'Bash', tool_use_id: 'original-call', agentId: 'original-child', requestMeta: {}, ...input })
    expect(p.originalChecks).toHaveBeenCalledExactlyOnceWith({ tool: 'Bash', tool_use_id: 'original-call', agentId: 'original-child', input })
    expect(p.$.tool.check).not.toHaveBeenCalled()
    expect(p.resource).toHaveBeenCalledExactlyOnceWith({ tool: 'mcp__original_resource__Bash', tool_use_id: 'native-alias-0', ...input })
    expect(p.starts.filter(event => event.tool.startsWith('mcp__'))).toEqual([{ tool: 'mcp__original_resource__Bash', tool_use_id: 'native-alias-0', ...input }])
    expect(result).toEqual({ result: bashRecord })
    expect(p.aborted).toMatchObject([{ tool: 'Bash', tool_use_id: 'original-call', agentId: 'original-child' }])
    expect(p.localEffects).not.toHaveBeenCalled()
    expect(p.permissionDenied).not.toHaveBeenCalled()
    expect(p.cancelledErrors).toMatchObject([{ event: { tool: 'Bash', tool_use_id: 'original-call' }, error: { name: 'AbortError' } }])
  })

  it.each([
    ['allow', 'allow', true], ['allow', 'ask', false], ['allow', 'deny', false],
    ['ask', 'allow', false], ['ask', 'ask', false], ['ask', 'deny', false],
    ['deny', 'allow', false], ['deny', 'ask', false], ['deny', 'deny', false]
  ] as const)('preserves original %s and transport %s verdicts', async (originalDecision, transportDecision, executes) => {
    const original = { decision: originalDecision, rule: 'Write', reason: 'Original actor rule' }
    const transport = { decision: transportDecision, rule: 'mcp__original_resource__Write', reason: 'Transport rule', ceiling: 'ask' }
    const p = await policy({ original: () => original, transport: () => transport })
    const result = await p.run({ tool: 'Write', tool_use_id: 'original-write', agentId: 'child', file_path: '/resource/file', content: 'authored' })
    expect(p.resource).toHaveBeenCalledTimes(executes ? 1 : 0)
    expect(p.localEffects).not.toHaveBeenCalled()
    if (originalDecision === 'deny') {
      expect(result).toEqual({ deny: original.reason }); expect(p.transportChecks).not.toHaveBeenCalled()
    } else {
      const expected = transportDecision === 'allow' ? original : transport
      expect(p.aliasVerdicts).toEqual([expected])
    }
  })

  it('keeps an original ask until native approval rather than converting it to allow', async () => {
    const verdict: Verdict = { decision: 'ask', reason: 'This exact child needs approval' }
    const p = await policy({ original: () => verdict, approveAsk: true })
    await p.run({ tool: 'Write', tool_use_id: 'approved-child-call', agentId: 'child', file_path: '/resource/file', content: 'authored' })
    expect(p.aliasVerdicts).toEqual([verdict])
    expect(p.resource).toHaveBeenCalledOnce(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('does not mix main and distinct child verdicts with identical call IDs and arguments during overlap', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    let waiting = 0
    const p = await policy({
      original: event => ({ decision: event.agentId === 'planning-child' ? 'ask' : 'allow', reason: event.agentId ?? 'main' }),
      transport: async () => { if (++waiting === 1) entered.resolve(); await release.promise; return allow }
    })
    const event = { tool: 'Write', tool_use_id: 'reused-provider-id', file_path: '/resource/same', content: 'same' }
    const calls = [p.run(event), p.run({ ...event, agentId: 'planning-child' }), p.run({ ...event, agentId: 'writing-child' })]
    await entered.promise
    try { await vi.waitFor(() => expect(p.transportChecks).toHaveBeenCalledTimes(3), { timeout: 200, interval: 5 }) }
    finally { release.resolve() }
    const results = await Promise.all(calls)
    expect(results[0]).toEqual({ result: bashRecord })
    expect(results[1]).toEqual({ deny: 'planning-child' })
    expect(results[2]).toEqual({ result: bashRecord })
    expect(p.originalChecks.mock.calls.map(([event]) => event.agentId)).toEqual([undefined, 'planning-child', 'writing-child'])
    expect(p.resource).toHaveBeenCalledTimes(2)
    expect(p.aliasVerdicts.map(value => [value.decision, value.reason])).toEqual([['allow', 'main'], ['ask', 'planning-child'], ['allow', 'writing-child']])
    expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('retains an early native classic-hook denial without querying or executing the transport', async () => {
    const early = { ref: 7, isError: true, result: 'Original PreToolUse denied', text: 'Original PreToolUse denied' }
    const p = await policy({ earlyResult: early })
    expect(await p.run({ tool: 'Bash', tool_use_id: 'classic-denied', command: 'original command' })).toBe(early)
    expect(p.originalChecks).not.toHaveBeenCalled(); expect(p.resource).not.toHaveBeenCalled(); expect(p.$.tool.call).not.toHaveBeenCalled()
    expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('uses the input actually checked after a native PreToolUse rewrite', async () => {
    const checked = { command: 'git diff', timeout: 1234 }
    const p = await policy({ originalInput: () => checked })
    await p.run({ tool: 'Bash', tool_use_id: 'rewritten-call', command: 'original command' })
    expect(p.originalChecks.mock.calls[0]?.[0].input).toEqual(checked)
    expect(p.resource.mock.calls[0]?.[0]).toEqual({ tool: 'mcp__original_resource__Bash', tool_use_id: 'native-alias-0', ...checked })
    expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('rejects an alias input rewritten after the original authorization', async () => {
    const p = await policy({ transportInput: input => ({ ...input, command: 'different unapproved command' }) })
    const result = await p.run({ tool: 'Bash', tool_use_id: 'changed-transport', command: 'approved command' })
    expect(result).toMatchObject({ deny: expect.stringContaining('no longer matches') })
    expect(p.transportChecks).not.toHaveBeenCalled(); expect(p.resource).not.toHaveBeenCalled(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('compares checked input structurally without depending on property order', async () => {
    const p = await policy({ transportInput: input => Object.fromEntries(Object.entries(input).reverse()) })
    expect(await p.run({ tool: 'Bash', tool_use_id: 'ordered-input', command: 'git diff', timeout: 1234 })).toEqual({ result: bashRecord })
    expect(p.resource).toHaveBeenCalledOnce(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('rejects a direct or uncorrelated alias even when another plugin knows its tool name', async () => {
    const p = await policy(), event = { tool: 'mcp__original_resource__Write', tool_use_id: 'forged', __agentmux_original_call_id: '[null,"missing"]', file_path: '/resource/file', content: 'authored' }
    expect(await p.run(event)).toHaveProperty('deny')
    expect(await p.run(event, { plugin: 'original-routing-plugin', tier: 'user' })).toHaveProperty('deny')
    expect(p.resource).not.toHaveBeenCalled(); expect(p.starts).toEqual([])
  })

  it('retains a native check failure without a local replacement', async () => {
    const p = await policy({ original: () => { throw new Error('native policy unavailable') } })
    expect(await p.run({ tool: 'Bash', tool_use_id: 'check-failed', command: 'original command' })).toMatchObject({ deny: expect.stringContaining('could not be evaluated') })
    expect(p.resource).not.toHaveBeenCalled(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it.each([new Error('reader failed'), { result: [{ type: 'image', data: 'not a native record' }] }])('does not execute locally after an unknown resource outcome (%j)', async value => {
    const p = await policy({ remote: () => { if (value instanceof Error) throw value; return value } })
    expect(await p.run({ tool: 'Write', tool_use_id: 'resource-failed', file_path: '/resource/file', content: 'original' })).toHaveProperty('deny')
    expect(p.aborted).toMatchObject([{ tool: 'Write', tool_use_id: 'resource-failed' }])
    expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('routes the durable resource task address after a policy reload and retains native local tasks', async () => {
    const p = await policy()
    expect(await p.run({ tool: 'TaskStop', tool_use_id: 'native-stop', task_id: 'native-agent-task' })).toEqual({ result: 'native-local-result' })
    expect(p.localEffects).toHaveBeenCalledOnce(); expect(p.resource).not.toHaveBeenCalled()
    const taskId = 'amux-shell-00000000-0000-4000-8000-000000000001'
    const fresh = await policy({ remote: () => ({ isError: true, result: 'Original task outcome unknown', text: 'Original task outcome unknown' }) })
    expect(await fresh.run({ tool: 'TaskStop', tool_use_id: 'resource-stop', task_id: taskId })).toMatchObject({ isError: true })
    expect(fresh.resource.mock.calls[0]?.[0]).toEqual({ tool: 'mcp__original_resource__TaskStop', tool_use_id: 'native-alias-0', task_id: taskId })
    expect(fresh.localEffects).not.toHaveBeenCalled()
  })

  it('installs immutable exact-binding plugin inputs without editing user settings or a retained generated revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-claude-policy-')); roots.push(root)
    const settings = join(root, '.claude', 'settings.json')
    const directory = await prepareClaudeExecutionPolicy({ workspacePath: root, bindingId: 'original-binding', serverName: 'original_resource' })
    await writeFile(settings, '{"user":"original settings"}')
    expect(await prepareClaudeExecutionPolicy({ workspacePath: root, bindingId: 'original-binding', serverName: 'original_resource' })).toBe(directory)
    expect(await readFile(settings, 'utf8')).toBe('{"user":"original settings"}')
    const source = join(directory, 'hooks', 'register.js')
    await writeFile(source, '// user edited this exact generated revision')
    await expect(prepareClaudeExecutionPolicy({ workspacePath: root, bindingId: 'original-binding', serverName: 'original_resource' })).rejects.toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
    expect(await readFile(source, 'utf8')).toBe('// user edited this exact generated revision')
    const other = await prepareClaudeExecutionPolicy({ workspacePath: root, bindingId: 'other-binding', serverName: 'original_resource' })
    expect(other).not.toBe(directory)
  })
})
