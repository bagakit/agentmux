import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { AgentMuxError } from '../src/errors.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(nativeError: Record<string, unknown>, method = 'thread/items/list', errorExitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), 'native-read-error-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const script = join(root, 'reader.mjs'), trace = join(root, 'requests.jsonl'), response = join(root, 'response.json')
  await writeFile(response, JSON.stringify(nativeError))
  await writeFile(script, `
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
appendFileSync(process.env.READ_TRACE, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  appendFileSync(process.env.READ_TRACE, line + '\\n')
  if (!Object.hasOwn(request, 'id')) return
  if (request.method === ${JSON.stringify(method)}) {
    process.stderr.write('private stderr diagnostic')
    const error = JSON.parse(readFileSync(process.env.READ_RESPONSE, 'utf8'))
    if (error !== null) process.exitCode = ${errorExitCode}
    process.stdout.write(JSON.stringify(error === null ? { id: request.id, result: { data: [], nextCursor: null } } : { id: request.id, error }) + '\\n')
  } else if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n')
  else if (request.method === 'thread/read') process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'original-native', historyMode: 'paginated' } } }) + '\\n')
})
`)
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original-session', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'original-hook', hookToken: 'original-hook-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } })
  const installer = new AgentManagedHookInstaller(join(root, 'receipts'))
  const client = new AgentMuxClient({ store, hookInstaller: installer }); cleanup.push(() => client.dispose())
  const env = { CODEX_HOME: root, READ_TRACE: trace, READ_RESPONSE: response, LOCAL_READ_SECRET: 'private environment value' }
  const context = { command: process.execPath, args: [script], env, workspacePath: root }
  const calls = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { root, store, client, installer, context, response, calls,
    read: () => client.sessionHistoryPage('original-session', { commandOverride: context.command, args: context.args, env }),
    async assertOwnedReads() {
      const rows = await calls()
      expect(rows.filter(row => row.pid).length).toBeGreaterThan(0)
      for (const row of rows.filter(row => row.pid)) { expect(row.args).toEqual(['-s', 'read-only', '-a', 'never', 'app-server', '--stdio']); expect(() => process.kill(row.pid, 0)).toThrow(/ESRCH/u) }
      expect(rows.filter(row => row.method).every(row => ['initialize', 'initialized', 'thread/read', 'thread/items/list', 'hooks/list'].includes(row.method))).toBe(true)
      expect((await loadAgentSessions(store)).map(value => [value.agentSessionId, value.run])).toEqual([['original-session', { runId: 'original-run' }]])
    }
  }
}

async function rejected(read: Promise<unknown>): Promise<AgentMuxError> {
  const error = await read.then(() => null, error => error)
  expect(error).toBeInstanceOf(AgentMuxError)
  return error as AgentMuxError
}

it('preserves native read error fields through the public history consumer without changing the original Session', async () => {
  const native = { code: -32000, message: 'Selected model is at capacity. Please try a different model.', data: { request: 'original-read', codex_error_info: 'server_overloaded', nested: [1, null, { detail: 'local native data' }] } }
  const f = await fixture(native, 'thread/items/list', 1), stop = vi.spyOn(f.client, 'stopAgent'), create = vi.spyOn(f.client, 'createAgent')
  const error = await rejected(f.read())
  expect(error.code).toBe('AGENT_SESSION_HISTORY_UNAVAILABLE'); expect(error.message).toBe('Native read request failed.')
  expect(JSON.parse(error.detail!)).toEqual({ kind: 'native-read', purpose: 'history', method: 'thread/items/list', requestId: 3, error: native })
  expect(error).not.toHaveProperty('turnOutcome'); expect(error).not.toHaveProperty('failure')
  for (const privateValue of ['private stderr diagnostic', 'private environment value', f.context.args[0]!]) expect(error.detail).not.toContain(privateValue)
  await writeFile(f.response, 'null')
  expect(await f.read()).toMatchObject({ agentSessionId: 'original-session', source: { providerId: 'codex', nativeSessionId: 'original-native' }, items: [] })
  expect(stop).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); await f.assertOwnedReads()
})

it('keeps hook read errors separate from activation status and preserves native unsupported code', async () => {
  const native = { code: -32601, message: 'Original native read method unavailable', data: { method: 'hooks/list', nativeRevision: 'original' } }
  const f = await fixture(native, 'hooks/list'), provider = new AgentProviderRegistry().get('codex')
  const plan = provider.planManagedHooks!({ workspacePath: f.root, env: f.context.env })!
  await f.installer.ensure(plan)
  const error = await rejected(provider.inspectHookActivation!({ ...f.context, plan, signal: new AbortController().signal }))
  expect(error.code).toBe('AGENT_HOOK_READ_UNSUPPORTED')
  expect(JSON.parse(error.detail!)).toEqual({ kind: 'native-read', purpose: 'hooks', method: 'hooks/list', requestId: 2, error: native })
  const result = await f.client.inspectManagedHooks('codex', f.context)
  expect(result).toMatchObject({ status: 'error', code: 'HOOK_ACTIVATION_CHECK_FAILED' })
  expect(JSON.stringify(result)).not.toContain(native.message)
  expect(JSON.stringify(result)).not.toContain('private stderr diagnostic')
  await f.assertOwnedReads()
})

it('omits oversized native error data explicitly without losing the original read code or message', async () => {
  const data = { diagnostic: 'private oversized data '.repeat(2000) }, native = { code: -32602, message: 'Original history cursor rejected', data }
  const f = await fixture(native), error = await rejected(f.read())
  expect(error.code).toBe('AGENT_SESSION_HISTORY_UNAVAILABLE')
  expect(JSON.parse(error.detail!)).toEqual({ kind: 'native-read', purpose: 'history', method: 'thread/items/list', requestId: 3,
    error: { code: native.code, message: native.message }, dataOmitted: { reason: 'byte-budget', byteLength: Buffer.byteLength(JSON.stringify(data)), maxBytes: 16384 } })
  expect(Buffer.byteLength(error.detail!)).toBeLessThan(16384); expect(error.detail).not.toContain('private oversized data')
  await f.assertOwnedReads()
})

it('does not invent unsupported reads from native error text', async () => {
  const native = { code: -32602, message: 'Method not found (-32601), selected model at capacity.' }
  const f = await fixture(native), error = await rejected(f.read())
  expect(error.code).toBe('AGENT_SESSION_HISTORY_UNAVAILABLE')
  expect(JSON.parse(error.detail!).error).toEqual(native)
  await f.assertOwnedReads()
})
