import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentMuxControlServer, parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest, type AgentMuxControlCrashLogFact } from '../src/control.js'
import { AgentMuxError } from '../src/errors.js'

const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
let root: string, server: AgentMuxControlServer
let fact: AgentMuxControlCrashLogFact
const seen: AgentMuxControlRequest[] = []
beforeEach(async () => {
  root = await mkdtemp('/tmp/amux-crash-log-cli-'); seen.splice(0)
  fact = { path: '/client-owned/fixed-crash-log', outcome: 'present' }
  server = new AgentMuxControlServer({ async execute(request) {
    seen.push(request)
    if (request.operation === 'diagnostics.crash-log.get') return { operation: request.operation, ...fact }
    if (request.operation === 'diagnostics.crash-log.reveal') {
      if (fact.outcome !== 'present') throw new AgentMuxError('Original client check failed', fact.outcome === 'check-failed' && fact.cause.code === 'CRASH_LOG_NOT_FILE' ? 'CRASH_LOG_NOT_FILE' : 'CONTROL_FAILED')
      return { operation: request.operation, path: fact.path, requested: true }
    }
    throw new Error(`Unexpected ${request.operation}`)
  } }, join(root, 'control.sock'))
  await server.start()
})
afterEach(async () => { await server?.stop(); if (root) await rm(root, { recursive: true }) })
async function run(args: string[], directory = root) {
  try {
    return { code: 0, ...await exec(process.execPath, [cli, ...args], { timeout: 5_000,
      env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined } }) }
  } catch (error) { return error as { code: number; stdout: string; stderr: string } }
}

it('the built public CLI gets typed client facts without a managed caller or View', async () => {
  for (const next of [fact, { path: fact.path, outcome: 'absent' } as const,
    { path: fact.path, outcome: 'check-failed', cause: { code: 'EACCES', message: 'Original client cause' } } as const]) {
    fact = next
    const result = await run(['diagnostics', 'crash-log'])
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).result).toEqual(next)
  }
  expect(seen.map(request => request.operation)).toEqual(['diagnostics.crash-log.get', 'diagnostics.crash-log.get', 'diagnostics.crash-log.get'])
})

it('explicit reveal only reports requested and retains typed failure as nonzero', async () => {
  const result = await run(['diagnostics', 'crash-log', 'reveal'])
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout).result).toEqual({ path: fact.path, requested: true })
  for (const cause of [{ code: 'EIO', message: 'IO failed' }, { code: 'CRASH_LOG_NOT_FILE', message: 'Not regular' }]) {
    fact = { path: fact.path, outcome: 'check-failed', cause }
    const failed = await run(['diagnostics', 'crash-log', 'reveal'])
    expect(failed.code).not.toBe(0)
    expect(JSON.parse(failed.stderr).error.code).toBe(cause.code === 'CRASH_LOG_NOT_FILE' ? cause.code : 'CONTROL_FAILED')
  }
  expect(seen).toHaveLength(3)
})

it('discovers exact fixed commands offline in the sole help and skill, with no Control call', async () => {
  const offline = join(root, 'offline')
  for (const args of [['--help'], ['--skill'], ['diagnostics', '--help'], ['diagnostics', 'crash-log', '--help'], ['diagnostics', 'crash-log', 'reveal', '--help']]) {
    const result = await run(args, offline)
    expect(result.code).toBe(0); expect(result.stdout.length).toBeGreaterThan(0)
    expect(result.stdout).toContain('diagnostics')
    if (args[0] !== '--help') {
      expect(result.stdout).toContain('agentmux diagnostics crash-log')
      expect(result.stdout).toContain('agentmux diagnostics crash-log reveal')
    }
  }
  expect(seen).toEqual([])
})

it('rejects arbitrary data and unknown actions before reaching Main and has no offline fallback', async () => {
  for (const args of [[], ['crash-log', '/path'], ['crash-log', '--input', '-'], ['crash-log', 'reveal', 'extra'], ['crash-log', 'unknown'], ['unknown', '--help']]) {
    const result = await run(['diagnostics', ...args])
    expect(result.code).not.toBe(0); expect(JSON.parse(result.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
  }
  for (const args of [['crash-log'], ['crash-log', 'reveal']]) {
    const result = await run(['diagnostics', ...args], join(root, 'offline'))
    expect(result.code).not.toBe(0); expect(JSON.parse(result.stderr).error.code).toBe('CONTROL_UNAVAILABLE')
  }
  expect(seen).toEqual([])
})

it('strict public envelopes and primitive receipts reject invented fields and wrong types', () => {
  const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'crash-log', operation: 'diagnostics.crash-log.get' }
  expect(parseAgentMuxControlRequest(base)).toEqual(base)
  for (const extra of [{ path: '/path' }, { input: {} }, { target: 'self' }, { schemaVersion: '5' }, { operation: 'diagnostics.crash-log.unknown' }]) {
    expect(() => parseAgentMuxControlRequest({ ...base, ...extra })).toThrow()
  }
  const receipt = { ...base, ok: true, result: { path: '/client/path', outcome: 'check-failed', cause: { code: 'EIO', message: 'Original cause' } } }
  expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
  for (const result of [{ ...receipt.result, path: 1 }, { ...receipt.result, cause: { code: 'EIO' } }, { ...receipt.result, body: 'secret' }, { path: '/x', outcome: 'absent', cause: receipt.result.cause }]) {
    expect(() => parseAgentMuxControlReceipt({ ...receipt, result })).toThrow()
  }
  expect(() => parseAgentMuxControlReceipt({ ...receipt, operation: 'diagnostics.crash-log.reveal', result: { path: '/x', requested: false } })).toThrow()
})
