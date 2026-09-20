import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, type AgentMuxControlRequest } from '../src/control.js'
import { parseSettingsCommand } from '../src/settings-cli.js'

const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
let root: string, server: AgentMuxControlServer
const seen: AgentMuxControlRequest[] = []
// Client-owned JSON: Core has no Desktop Host schema or connection defaults.
const saved = { id: '--help', connection: 'literal current route' }
beforeEach(async () => {
  root = await mkdtemp('/tmp/amux-hosts-cli-'); seen.splice(0)
  server = new AgentMuxControlServer({ async execute(request) {
    seen.push(request)
    if (request.operation === 'settings.hosts.list') return { operation: request.operation, hosts: [saved] }
    if (request.operation === 'settings.hosts.test') return { operation: request.operation,
      input: request.input ?? { ...saved, id: request.id }, outcome: 'unsupported', detail: 'This connection is not supported.' }
    throw new Error(`Unexpected operation ${request.operation}`)
  } }, join(root, 'control.sock'))
  await server.start()
})
afterEach(async () => { await server?.stop(); if (root) await rm(root, { recursive: true }) })

it('discovers Host read and Test in the built skill without losing project registration', async () => {
  const result = await exec(process.execPath, [cli, '--skill'], {
    timeout: 5_000, env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: join(root, 'absent-owner'), AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined }
  })
  expect(result.stdout.length).toBeGreaterThan(0)
  expect(result.stdout).toContain('agentmux settings hosts list')
  expect(result.stdout).toContain('agentmux settings hosts test <id>')
  expect(result.stdout).toContain('agentmux settings workspaces add --input <file|->')
  expect(seen).toEqual([])
})

async function run(args: string[], input?: string | Buffer, directory = root) {
  try {
    const pending = exec(process.execPath, [cli, 'settings', 'hosts', ...args], {
      timeout: 5_000, env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined }
    })
    if (input !== undefined) pending.child.stdin!.end(input)
    return { code: 0, ...await pending }
  } catch (error) { return error as { code: number; stdout: string; stderr: string } }
}

it('built public CLI reaches Control without a View and treats special saved IDs as data', async () => {
  const list = await run(['list']); expect(list.code).toBe(0)
  expect(JSON.parse(list.stdout).result.hosts).toEqual([saved])
  for (const id of ['--help', '--input', 'literal host', '  ']) {
    const test = await run(['test', id]); expect(test.code).toBe(0)
    expect(JSON.parse(test.stdout).result).toEqual({ input: { ...saved, id }, outcome: 'unsupported', detail: 'This connection is not supported.' })
  }
  expect(seen.map(r => r.operation)).toEqual(['settings.hosts.list', 'settings.hosts.test', 'settings.hosts.test', 'settings.hosts.test', 'settings.hosts.test'])
})

it('accepts stdin and rejects malformed or over-budget draft bytes before Control', async () => {
  const input = { id: 'stdin', route: 'captured bytes' }
  const result = await run(['test', '--input', '-'], JSON.stringify(input))
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout).result.input).toEqual(input)
  expect(seen).toHaveLength(1)
  for (const bytes of [Buffer.from([0xc3, 0x28]), '{', '[]', JSON.stringify({ route: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) })]) {
    const invalid = await run(['test', '--input', '-'], bytes)
    expect(invalid.code).not.toBe(0)
  }
  expect(seen).toHaveLength(1)
})

it('documents explicit Test without a live owner, while ordinary list and Test stay unavailable offline', async () => {
  const offline = join(root, 'absent-owner')
  const help = await run(['--help'], undefined, offline)
  expect(help.code).toBe(0); expect(help.stdout).toContain('settings hosts test <id>')
  expect(help.stdout).toContain('settings hosts test --input <file|->')
  expect(help.stdout).toContain('check-failed'); expect(help.stdout).toContain('Exit 0')
  for (const args of [['list'], ['test', 'saved'], ['test', '--input', '-']]) {
    const result = await run(args, args.includes('-') ? '{}' : undefined, offline)
    expect(result.code).not.toBe(0); expect(JSON.parse(result.stderr).error.code).toBe('CONTROL_UNAVAILABLE')
  }
  expect(seen).toEqual([])
})

it('draft file carries bounded literal JSON and malformed/mixed modes never reach the owner', async () => {
  const path = join(root, 'draft.json'), input = { id: 'draft', route: ' a\\b\n<kept> ' }
  await writeFile(path, JSON.stringify(input))
  const result = await run(['test', '--input', path]); expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).result.input).toEqual(input)
  const count = seen.length
  for (const args of [['test'], ['test', 'saved', '--input', path], ['test', '--input', path, '--input', path], ['list', 'extra']]) {
    expect((await run(args)).code).not.toBe(0)
  }
  await writeFile(path, Buffer.from([0xc3, 0x28])); expect((await run(['test', '--input', path])).code).not.toBe(0)
  expect(seen).toHaveLength(count)
})

it('strict public envelope rejects ambiguous input and preserves captured diagnostic facts', async () => {
  const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'host-test', operation: 'settings.hosts.test' }
  for (const fields of [{}, { id: 'saved', input: {} }, { input: [] }, { input: { nested: undefined } }, { id: 'saved', path: 'x' }]) {
    expect(() => parseAgentMuxControlRequest({ ...base, ...fields })).toThrow()
  }
  expect(await parseSettingsCommand(['hosts', 'test', '--input'])).toEqual({ operation: 'settings.hosts.test', id: '--input' })
  const receipt = { ...base, ok: true, result: { input: saved, outcome: 'check-failed', detail: 'Facts could not be read.' } }
  expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
  expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { ...receipt.result, outcome: 'ready', extra: true } })).toThrow()
})
