import { fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation } from '../src/agent-terminal-frontend.js'
import { runCodexManaged } from '../src/providers/codex-managed-run.js'

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), publish: vi.fn(), handlers: undefined as any }))
vi.mock('node:child_process', () => ({ spawn: boundary.spawn }))
vi.mock('../src/agent-native-process.js', () => ({ nativeProcessTcpListeners: async () => [{ endpoint: 'ws://127.0.0.1:12345' }] }))
vi.mock('../src/providers/codex-managed-frontend.js', () => ({
  CODEX_ACTOR_ID_ENV: 'AGENTMUX_CODEX_ACTOR_ID', CODEX_ACTOR_LIFECYCLE_ENV: 'AGENTMUX_CODEX_ACTOR_LIFECYCLE',
  openCodexFrontendControl: async (_token: string, _identity: unknown, handlers: unknown) => {
    boundary.handlers = handlers
    return { publish: boundary.publish, close: async () => {} }
  }
}))
vi.mock('../src/providers/codex-native-rpc.js', () => ({ connectCodexNativeActor: async () => ({
  request: async () => ({ thread: { id: 'original-native', canAcceptDirectInput: true } }), dispose() {}
}) }))

class Child extends EventEmitter {
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}
let children: Child[], pending: Promise<number> | undefined, originalBytes: Buffer[]
const current = (): AgentTerminalFrontendObservation => boundary.handlers.current()
async function start() {
  pending = runCodexManaged({ command: 'private-provider', args: [], serverConfig: [], frontendArgs: [] })
  await vi.waitFor(() => expect(current()?.state).toBe('attached'))
  return children[1]!
}
beforeEach(() => {
  children = []; originalBytes = []; boundary.publish.mockClear(); boundary.handlers = undefined
  vi.stubEnv('AGENTMUX_CODEX_ACTOR_TOKEN', 'private-token')
  vi.stubEnv('AGENTMUX_CODEX_ACTOR_ID', 'original-actor')
  vi.stubEnv('AGENTMUX_CODEX_ACTOR_LIFECYCLE', 'original-lifecycle')
  boundary.spawn.mockImplementation(() => {
    const child = new Child(); children.push(child); queueMicrotask(() => child.emit('spawn')); return child
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(((bytes: Buffer | string) => {
    originalBytes.push(Buffer.from(bytes)); return true
  }) as typeof process.stderr.write)
})
afterEach(async () => {
  children[0]?.emit('exit', 0, null)
  await pending; pending = undefined
  for (const child of children) child.stderr.destroy()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

it.each([
  'Error: account route request timed out\nCaused by: connection deadline exceeded',
  "Configuration could not be loaded:\nPermission denied while reading " + _tailFixturePath("private/example/config")
])('publishes the exact child diagnostic after an authoritative nonzero exit and preserves original PTY bytes: %s', async diagnostic => {
  const child = await start(), id = current().frontendId
  const bytes = Buffer.from('\u001b[31m' + diagnostic + '\u001b[0m\n')
  child.stderr.write(bytes.subarray(0, 7)); child.stderr.write(bytes.subarray(7))
  expect(current()).toMatchObject({ frontendId: id, state: 'attached' })
  expect(current().message).toBeUndefined() // Text is never a lifecycle signal.
  child.emit('exit', 1, null); child.stderr.end(); child.emit('close', 1, null)
  expect(current()).toMatchObject({ frontendId: id, state: 'detached', backendState: 'running', exitCode: 1, message: diagnostic })
  expect(Buffer.concat(originalBytes)).toEqual(bytes)
  expect(children[0]!.kill).not.toHaveBeenCalled()
  expect(boundary.spawn.mock.calls[1]![2].stdio).toEqual(['inherit', 'inherit', 'pipe'])
})

it('bounds the public tail while the complete long diagnostic remains on the original PTY', async () => {
  const child = await start(), diagnostic = 'early diagnostic\n' + '长'.repeat(20_000) + '\nfinal startup failure'
  const bytes = Buffer.from(diagnostic)
  for (let n = 0; n < bytes.length; n += 137) child.stderr.write(bytes.subarray(n, n + 137))
  child.emit('exit', 7, null); child.stderr.end(); child.emit('close', 7, null)
  expect(current().message).toBe(diagnostic.slice(-4096))
  expect(parseTerminalFrontendObservation(current()).message).toHaveLength(4096)
  expect(Buffer.concat(originalBytes)).toEqual(bytes)
})

it('starts a clean generation and refuses to put late original stderr onto its repaired frontend', async () => {
  const child = await start(), originalId = current().frontendId
  child.stderr.write('original failure'); child.emit('exit', 1, null)
  expect(current().message).toBe('original failure')
  await boundary.handlers.reconnect({ operationId: 'original-reconnect', expectedFrontendId: originalId, nativeSessionId: 'original-native' })
  const repairedId = current().frontendId
  expect(repairedId).not.toBe(originalId)
  expect(current()).toMatchObject({ state: 'attached', backendState: 'running' })
  expect(current().message).toBeUndefined()
  child.stderr.write('\nlate original bytes'); child.stderr.end(); child.emit('close', 1, null)
  expect(current()).toMatchObject({ frontendId: repairedId, state: 'attached' })
  expect(current().message).toBeUndefined()
  children[2]!.emit('exit', 0, null); children[2]!.emit('close', 0, null)
  expect(current()).toMatchObject({ frontendId: repairedId, state: 'detached', exitCode: 0 })
  expect(current().message).toBeUndefined()
})
