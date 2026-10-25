import { AsyncLocalStorage } from 'node:async_hooks'
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
type Registration = { pattern: string; match?: Event; handler: Hook; recover?: Hook }
type Options = {
  query?: (event: Event) => Verdict | Promise<Verdict>
  readOnly?: (event: Event) => true | undefined
  transport?: (event: Event) => Verdict | Promise<Verdict>
  transportInput?: (input: Event) => Event
  remote?: (event: Event) => Event | Promise<Event>
  approveAsk?: boolean
}
const allow: Verdict = { decision: 'allow' }
const nativeResult = (value: unknown) => ({ result: [{ type: 'text', text: JSON.stringify(value) }] })
const record = { stdout: 'resource-output', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
const inputOf = (event: Event) => Object.fromEntries(Object.entries(event).filter(([key]) => !['tool', 'tool_use_id', 'agentId', 'requestMeta'].includes(key)))
let moduleId = 0
function matches(expected: any, actual: any): boolean {
  if (Object.prototype.toString.call(expected) === '[object RegExp]') return typeof actual === 'string' && expected.test(actual)
  if (Array.isArray(expected)) return expected.some(value => matches(value, actual))
  if (expected && typeof expected === 'object') return actual && Object.entries(expected).every(([key, value]) => matches(value, actual[key]))
  return expected === actual
}

/** Native 2.1.314 rejects duplicate glob registrations. $ calls retain their
 * originating frames across nested $ calls; plain next() forwarding does not
 * add that forwarding registration to the later $ call's re-entry skip set. */
async function policy(options: Options = {}) {
  const registrations: Registration[] = [], frames = new AsyncLocalStorage<Set<Registration>>()
  const source = claudeExecutionPolicySource('original_resource', 'original-routing-plugin')
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + moduleId++)
  module.register((pattern: string, matchOrHandler: Event | Hook, handler?: Hook) => {
    if (pattern.includes('*') && registrations.some(value => value.pattern === pattern)) throw new Error('Native hook pattern registered twice: ' + pattern)
    const registration: Registration = typeof matchOrHandler === 'function' ? { pattern, handler: matchOrHandler as Hook } : { pattern, match: matchOrHandler, handler: handler! }
    registrations.push(registration)
    return { catch: (recover: Hook) => { registration.recover = recover } }
  })
  const nativeQuery = vi.fn(options.query ?? (() => allow))
  const nativeTransport = vi.fn(options.transport ?? (() => allow))
  const localEffects = vi.fn(async (_event: Event) => ({ result: 'native-local-result' }))
  const resource = vi.fn(options.remote ?? (() => nativeResult(record)))
  const starts: Event[] = [], aliasVerdicts: Verdict[] = [], queryTraces: Event[] = []
  let aliasId = 0
  const origin = { plugin: 'original-routing-plugin', tier: 'user' }
  const $ = { tool: {
    call: vi.fn(async (input: Event) => run({ ...input, tool_use_id: 'native-alias-' + aliasId++ }, origin)),
    check: vi.fn(async ({ tool, input }: Event) => {
      const query = { tool, input, ...(options.readOnly?.({ tool, input }) === true ? { isReadOnly: true } : {}) }
      const trace: Event = { event: query, skipped: [] }
      const result = await dispatch('tool.check', query, origin, value => Promise.resolve(nativeQuery(value)), trace)
      queryTraces.push({ ...trace, result })
      return result
    })
  } }
  async function dispatch(event: string, input: Event, caller: Event, core: (value: Event) => Promise<any>, trace?: Event): Promise<any> {
    const active = frames.getStore() ?? new Set()
    const selected = registrations.filter(value => (value.pattern === event || value.pattern.endsWith('.*') && event.startsWith(value.pattern.slice(0, -1))) && (!value.match || matches(value.match, input)))
    if (trace) trace.skipped = selected.filter(value => active.has(value)).map(value => value.pattern)
    const chain = selected.filter(value => !active.has(value))
    async function invoke(index: number, value: Event): Promise<any> {
      const registration = chain[index]
      if (!registration) return core(value)
      const inherited = new Set(frames.getStore() ?? active)
      const next = Object.assign(vi.fn((forward: Event) => frames.run(inherited, () => invoke(index + 1, forward))), { event, origin: caller })
      const ancestors = new Set(inherited); ancestors.add(registration)
      return frames.run(ancestors, async () => {
        try { return await registration.handler($, value, next) }
        catch (error) { if (!registration.recover) throw error; return registration.recover($, value, next) }
      })
    }
    return invoke(0, input)
  }
  async function run(event: Event, caller: Event = { plugin: 'engine', tier: 'core' }): Promise<any> {
    return dispatch('tool.call', event, caller, async forward => {
      starts.push(forward)
      if (!forward.tool.startsWith('mcp__')) return localEffects(forward)
      const input = options.transportInput?.(inputOf(forward)) ?? inputOf(forward)
      const check = { tool: forward.tool, input, tool_use_id: forward.tool_use_id }
      const verdict = await dispatch('tool.check', check, caller, value => Promise.resolve(nativeTransport(value)))
      aliasVerdicts.push(verdict)
      if (verdict.decision === 'deny' || verdict.decision === 'ask' && !options.approveAsk) return { deny: verdict.reason ?? 'Native permission is awaiting approval' }
      return resource({ ...forward, ...input })
    })
  }
  return { $, run, localEffects, resource, nativeQuery, nativeTransport, starts, aliasVerdicts, queryTraces }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Claude original tool execution policy', () => {
  it.each([
    ['Read', { file_path: '/resource-only/absent-locally' }],
    ['Edit', { file_path: '/resource-only/absent-locally', old_string: 'before', new_string: 'after' }],
    ['Write', { file_path: '/resource-only/absent-locally', content: 'authored' }],
    ['Bash', { command: 'opaque native shell input', timeout: 5000 }]
  ])('routes main %s without local tool state validation and strips private transport metadata', async (tool, input) => {
    const p = await policy()
    expect(await p.run({ tool, tool_use_id: 'original-call', requestMeta: {}, ...input })).toEqual({ result: record })
    expect(p.nativeQuery).toHaveBeenCalledExactlyOnceWith({ tool, input })
    expect(p.queryTraces).toMatchObject([{ skipped: ['tool.*'], result: allow }])
    expect(p.resource).toHaveBeenCalledExactlyOnceWith({ tool: 'mcp__original_resource__' + tool, tool_use_id: 'native-alias-0', ...input })
    expect(p.starts).toEqual([{ tool: 'mcp__original_resource__' + tool, tool_use_id: 'native-alias-0', ...input }])
    expect(p.localEffects).not.toHaveBeenCalled()
  })

  it.each([
    ['allow', 'allow', true], ['allow', 'ask', false], ['allow', 'deny', false],
    ['ask', 'allow', false], ['ask', 'ask', false], ['ask', 'deny', false],
    ['deny', 'allow', false], ['deny', 'ask', false], ['deny', 'deny', false]
  ] as const)('keeps main native %s and transport %s permissions', async (originalDecision, transportDecision, executes) => {
    const original = { decision: originalDecision, rule: 'Write', reason: 'Original main rule' }
    const transport = { decision: transportDecision, rule: 'mcp__original_resource__Write', reason: 'Transport rule', ceiling: 'ask' }
    const p = await policy({ query: () => original, transport: () => transport })
    const result = await p.run({ tool: 'Write', tool_use_id: 'main-write', file_path: '/resource/file', content: 'authored' })
    expect(p.resource).toHaveBeenCalledTimes(executes ? 1 : 0)
    expect(p.localEffects).not.toHaveBeenCalled()
    if (originalDecision === 'deny') {
      expect(result).toEqual({ deny: original.reason }); expect(p.nativeTransport).not.toHaveBeenCalled()
    } else expect(p.aliasVerdicts).toEqual([transportDecision === 'allow' ? original : transport])
  })

  it('retains a main native ask for its actual approval path', async () => {
    const verdict: Verdict = { decision: 'ask', reason: 'This main operation needs approval' }
    const p = await policy({ query: () => verdict, approveAsk: true })
    expect(await p.run({ tool: 'Write', tool_use_id: 'main-approved', file_path: '/resource/file', content: 'authored' })).toEqual({ result: record })
    expect(p.aliasVerdicts).toEqual([verdict]); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it.each([
    [true, 'allow', true], [undefined, 'allow', false],
    [true, 'ask', false], [true, 'deny', false], [undefined, 'deny', false]
  ] as const)('admits child native read-only=%s verdict=%s only when already allowed', async (readOnly, decision, executes) => {
    const verdict: Verdict = { decision, reason: 'Original query verdict' }
    const p = await policy({ query: () => verdict, readOnly: () => readOnly, approveAsk: true })
    const result = await p.run({ tool: 'Bash', tool_use_id: 'child-read', agentId: 'original-child', command: 'opaque shell source' })
    expect(p.nativeQuery).toHaveBeenCalledExactlyOnceWith({ tool: 'Bash', input: { command: 'opaque shell source' }, ...(readOnly ? { isReadOnly: true } : {}) })
    expect(p.queryTraces[0]?.skipped).not.toContain('tool.*')
    expect(p.resource).toHaveBeenCalledTimes(executes ? 1 : 0)
    if (!executes) expect(result).toHaveProperty('deny')
    if (decision === 'deny') expect(p.queryTraces[0]?.result).toBe(verdict)
    expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('uses the native read-only fact instead of shell words and keeps the main Agent usable after a child refusal', async () => {
    const p = await policy()
    expect(await p.run({ tool: 'Bash', tool_use_id: 'child-unconfirmed', agentId: 'child', command: 'pwd' })).toHaveProperty('deny')
    expect(await p.run({ tool: 'Bash', tool_use_id: 'main-next', command: 'pwd' })).toEqual({ result: record })
    expect(p.resource).toHaveBeenCalledOnce(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('keeps main and children with the same provider ID and input isolated across overlapping frames', async () => {
    const entered = deferred<void>(), release = deferred<void>(); let waiting = 0
    const p = await policy({ transport: async () => { if (++waiting === 1) entered.resolve(); await release.promise; return allow } })
    const input = { tool: 'Bash', tool_use_id: 'reused-provider-id', command: 'same opaque input' }
    const calls = [p.run(input), p.run({ ...input, agentId: 'child-one' }), p.run({ ...input, agentId: 'child-two' })]
    await entered.promise
    try { await vi.waitFor(() => expect(p.nativeTransport).toHaveBeenCalledTimes(3), { timeout: 200, interval: 5 }) }
    finally { release.resolve() }
    const results = await Promise.all(calls)
    expect(results[0]).toEqual({ result: record }); expect(results[1]).toHaveProperty('deny'); expect(results[2]).toHaveProperty('deny')
    expect(p.queryTraces.filter(value => value.skipped.includes('tool.*'))).toHaveLength(1)
    expect(p.queryTraces.map(value => value.result.decision).sort()).toEqual(['allow', 'deny', 'deny'])
    expect(p.resource).toHaveBeenCalledOnce(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('allows distinct read-only children sharing a provider ID without dropping either operation', async () => {
    const p = await policy({ readOnly: () => true })
    const input = { tool: 'Read', tool_use_id: 'shared-id', file_path: '/resource/file' }
    await Promise.all([p.run({ ...input, agentId: 'child-one' }), p.run({ ...input, agentId: 'child-two' })])
    expect(p.resource).toHaveBeenCalledTimes(2); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('rejects a transport input changed after the original permission query', async () => {
    const p = await policy({ transportInput: input => ({ ...input, command: 'different unapproved input' }) })
    expect(await p.run({ tool: 'Bash', tool_use_id: 'changed-transport', command: 'original input' })).toMatchObject({ deny: expect.stringContaining('no longer matches') })
    expect(p.nativeQuery).toHaveBeenCalledExactlyOnceWith({ tool: 'Bash', input: { command: 'original input' } })
    expect(p.nativeTransport).not.toHaveBeenCalled(); expect(p.resource).not.toHaveBeenCalled(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('compares checked input structurally without depending on property order', async () => {
    const p = await policy({ transportInput: input => Object.fromEntries(Object.entries(input).reverse()) })
    expect(await p.run({ tool: 'Bash', tool_use_id: 'ordered-input', command: 'opaque input', timeout: 1234 })).toEqual({ result: record })
    expect(p.resource).toHaveBeenCalledOnce(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('rejects direct or uncorrelated aliases despite an existing tool name', async () => {
    const p = await policy(), event = { tool: 'mcp__original_resource__Write', tool_use_id: 'forged', __agentmux_original_call_id: '[null,"missing"]', file_path: '/resource/file', content: 'authored' }
    expect(await p.run(event)).toHaveProperty('deny')
    expect(await p.run(event, { plugin: 'original-routing-plugin', tier: 'user' })).toHaveProperty('deny')
    expect(p.starts).toEqual([]); expect(p.resource).not.toHaveBeenCalled()
  })

  it.each([undefined, 'child'])('retains an unavailable native query for actor %s without a local replacement', async agentId => {
    const p = await policy({ query: () => { throw new Error('native query unavailable') } })
    expect(await p.run({ tool: 'Bash', tool_use_id: 'query-failed', ...(agentId === undefined ? {} : { agentId }), command: 'original input' })).toHaveProperty('deny')
    expect(p.resource).not.toHaveBeenCalled(); expect(p.localEffects).not.toHaveBeenCalled()
  })

  it.each([new Error('resource failed'), { result: [{ type: 'image', data: 'not a native record' }] }])('keeps an unknown resource result from executing locally (%j)', async value => {
    const p = await policy({ remote: () => { if (value instanceof Error) throw value; return value } })
    expect(await p.run({ tool: 'Write', tool_use_id: 'resource-failed', file_path: '/resource/file', content: 'original' })).toHaveProperty('deny')
    expect(p.localEffects).not.toHaveBeenCalled()
  })

  it('routes a durable resource task after policy reload and retains unrelated native tasks', async () => {
    const p = await policy()
    expect(await p.run({ tool: 'TaskStop', tool_use_id: 'native-stop', task_id: 'native-agent-task' })).toEqual({ result: 'native-local-result' })
    expect(p.localEffects).toHaveBeenCalledOnce(); expect(p.resource).not.toHaveBeenCalled()
    const fresh = await policy({ remote: () => ({ isError: true, result: 'Original task unknown', text: 'Original task unknown' }) })
    const task_id = 'amux-shell-00000000-0000-4000-8000-000000000001'
    expect(await fresh.run({ tool: 'TaskStop', tool_use_id: 'resource-stop', task_id })).toMatchObject({ isError: true })
    expect(fresh.resource.mock.calls[0]?.[0]).toEqual({ tool: 'mcp__original_resource__TaskStop', tool_use_id: 'native-alias-0', task_id })
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
