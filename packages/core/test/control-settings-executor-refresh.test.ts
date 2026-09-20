import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, AGENTMUX_CONTROL_MAX_MESSAGE_BYTES,
  isLongAgentMuxControlOperation, type AgentMuxControlRequest } from '../src/control.js'
import { parseSettingsCommand } from '../src/settings-cli.js'

const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'refresh', operation: 'settings.executors.refresh' } as const
let root: string, server: AgentMuxControlServer
const seen: AgentMuxControlRequest[] = []
beforeEach(async () => {
  root = await mkdtemp('/tmp/amux-refresh-cli-'); seen.splice(0)
  server = new AgentMuxControlServer({ async execute(request) {
    seen.push(request)
    if (request.operation !== 'settings.executors.refresh') throw new Error(`Unexpected ${request.operation}`)
    return { operation: request.operation, input: { executorId: request.executorId, providerId: 'generic-provider', command: 'literal command',
      host: { id: request.hostId, connection: 'client-owned route' } }, availability: 'check-failed',
      cause: { code: 'EIO', message: 'controlled read failed <kept>\n' } }
  } }, join(root, 'control.sock'))
  await server.start()
})
afterEach(async () => { await server?.stop(); if (root) await rm(root, { recursive: true }) })
async function run(args: string[], offline = false) {
  try {
    return { code: 0, ...await exec(process.execPath, [cli, ...args], { timeout: 5_000,
      env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: offline ? join(root, 'absent') : root,
        AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined } }) }
  } catch (error) { return error as { code: number; stdout: string; stderr: string } }
}

it('built CLI sends the two exact IDs without a managed Agent or View; positional --help remains data', async () => {
  const pairs = [['first', 'local'], ['second', 'remote'], ['--help', '--help'], [' a ', '--input']]
  for (const [executorId, hostId] of pairs) {
    const receipt = await run(['settings', 'executors', 'refresh', executorId!, '--host', hostId!])
    expect(receipt.code).toBe(0)
    expect(JSON.parse(receipt.stdout).result).toEqual({ input: { executorId, providerId: 'generic-provider', command: 'literal command',
      host: { id: hostId, connection: 'client-owned route' } }, availability: 'check-failed', cause: { code: 'EIO', message: 'controlled read failed <kept>\n' } })
  }
  expect(seen.map(request => request.operation === 'settings.executors.refresh' && [request.executorId, request.hostId])).toEqual(pairs)
})

it('rejects absent, guessed, draft, duplicate and extra arguments before reaching Control', async () => {
  for (const tail of [[], ['first'], ['first', '--host'], ['first', '--host', ''], ['', '--host', 'local'],
    ['first', 'local'], ['first', '--all'], ['first', '--input', '-'], ['first', '--host', 'local', '--host', 'remote'],
    ['first', '--host', 'local', 'extra']]) {
    const receipt = await run(['settings', 'executors', 'refresh', ...tail])
    expect(receipt.code).not.toBe(0)
    expect(JSON.parse(receipt.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
  }
  expect(seen).toEqual([])
})

it('help and skill discover Refresh offline, while the actual operation returns CONTROL_UNAVAILABLE', async () => {
  const help = await run(['settings', 'executors', 'refresh', '--help'], true)
  expect(help.code).toBe(0); expect(help.stdout).toContain('refresh <executor-id> --host <host-id>')
  expect(help.stdout).toContain('cause.code/message'); expect(help.stdout).toContain('Exit 0')
  const group = await run(['settings', 'executors', '--help'], true)
  expect(group.code).toBe(0); expect(group.stdout).toContain('refresh <executor-id> --host <host-id>')
  const skill = await run(['--skill'], true)
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('settings executors refresh <executor-id> --host <host-id>')
  const offline = await run(['settings', 'executors', 'refresh', 'first', '--host', 'local'], true)
  expect(offline.code).not.toBe(0); expect(JSON.parse(offline.stderr).error.code).toBe('CONTROL_UNAVAILABLE')
  expect(seen).toEqual([])
})

it('the strict bounded primitive owns exactly the two IDs and uses the existing long diagnostic deadline', async () => {
  const request = { ...envelope, executorId: 'exact', hostId: '--help' }
  expect(parseAgentMuxControlRequest(request)).toEqual(request)
  expect(await parseSettingsCommand(['executors', 'refresh', 'exact', '--host', '--help']))
    .toEqual({ operation: request.operation, executorId: 'exact', hostId: '--help' })
  expect(isLongAgentMuxControlOperation(request.operation)).toBe(true)
  for (const fields of [{ executorId: '', hostId: 'local' }, { executorId: 'exact' }, { executorId: 1, hostId: 'local' },
    { ...request, input: {} }, { ...request, path: '/arbitrary' }, { ...request, caller: {} },
    { executorId: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES), hostId: 'local' }]) {
    expect(() => parseAgentMuxControlRequest({ ...envelope, ...fields })).toThrow()
  }
  expect(seen).toEqual([])
})

it('receipt validation preserves all three observed outcomes and rejects invented or incomplete facts', () => {
  const input = { executorId: 'exact', providerId: 'provider', command: 'authored', host: { client: ['bounded', true, 42] } }
  const cause = { code: 'EIO', message: 'original\n<read failure>' }
  for (const result of [{ input, executable: 'resolved', availability: 'available' },
    { input, executable: 'resolved', availability: 'missing' },
    { input, executable: 'resolved', availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FILE', message: 'a directory' } },
    { input, executable: 'resolved', availability: 'check-failed', cause }, { input, availability: 'check-failed', cause }]) {
    const receipt = { ...envelope, ok: true, result }
    expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
  }
  for (const result of [{ input, availability: 'available' }, { input, executable: 'resolved', availability: 'available', cause },
    { input, availability: 'missing' }, { input, availability: 'check-failed' },
    { input, availability: 'check-failed', cause: { code: 'EIO' } },
    { input: { ...input, extra: true }, executable: 'resolved', availability: 'available' },
    { input, executable: 'resolved', availability: 'unknown' },
    { input, availability: 'check-failed', cause, argv: [] },
    { input: { ...input, host: { bad: undefined } }, availability: 'check-failed', cause },
    { input, availability: 'check-failed', cause: { code: 'EIO', message: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) } }]) {
    expect(() => parseAgentMuxControlReceipt({ ...envelope, ok: true, result })).toThrow()
  }
  expect(seen).toEqual([])
})
