import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/control-host.js'

const children: ChildProcess[] = [], dirs: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true })
})
async function cli(directory: string, args: string[], help = false) {
  const sourceEntry = process.env.AGENTMUX_METRICS_CLI
  expect(sourceEntry, 'Owning verifier must compile the actual CLI to its private evidence directory').toBeTruthy()
  const child = spawn(process.execPath, [sourceEntry!, ...args], { env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk.toString() }); child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  if (process.env.AGENTMUX_METRICS_EVIDENCE) await appendFile(join(process.env.AGENTMUX_METRICS_EVIDENCE, help ? 'cli.help.raw.jsonl' : 'cli.raw.ndjson'),
    help ? JSON.stringify({ args, code, stdout, stderr }) + '\n' : stdout + stderr)
  return { code, stdout, stderr, frames: help ? [] : (stdout + stderr).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
describe('actual product metrics CLI', () => {
  it.each(['get','watch'])('supports actual metrics %s subcommand help without an endpoint connection', async verb => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-metrics-help-')); dirs.push(dir)
    const execute = vi.fn(), subscribe = vi.fn(), connected = vi.fn()
    const owner = new AgentMuxControlServer({ execute, metrics: { subscribe } }, join(dir, 'control.sock'))
    await owner.start()
    ;(owner as unknown as { server: Server }).server.on('connection', connected)
    try {
      for (const flag of ['--help','-h']) {
        const result = await cli(dir, ['metrics', verb, flag], true)
        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout.trim().length).toBeGreaterThan(0)
        expect(result.stdout).toContain('Usage: agentmux metrics get | watch')
        expect(result.stdout).toContain('No Runtime is started or connected')
      }
      expect(connected).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled()
    } finally { await owner.stop() }
  })
  it('get/watch use the existing Unix endpoint and preserve typed unsupported without Runtime startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-metrics-cli-')); dirs.push(dir)
    const execute = vi.fn()
    const owner = new AgentMuxControlServer({ execute }, join(dir, 'control.sock'))
    await owner.start()
    try {
      for (const verb of ['get','watch']) {
        const result = await cli(dir, ['metrics', verb])
        expect(result.code).toBe(1)
        expect(result.frames).toHaveLength(1)
        expect(result.frames[0]).toMatchObject({ ok: false, operation: `metrics.${verb}`, error: { code: 'METRICS_UNSUPPORTED' } })
        expect(typeof result.frames[0].requestId).toBe('string')
      }
      expect(execute).not.toHaveBeenCalled()
    } finally { await owner.stop() }
  })
  it('offline get is unavailable and bad arguments are rejected as complete NDJSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-metrics-cli-offline-')); dirs.push(dir)
    const result = await cli(dir, ['metrics','get'])
    expect(result.code).toBe(1); expect(result.frames).toHaveLength(1)
    expect(result.frames[0]).toMatchObject({ ok: false, error: { code: 'CONTROL_UNAVAILABLE' } })
    const invalid = await cli(dir, ['metrics','get','--host','remote'])
    expect(invalid.frames).toHaveLength(1)
    expect(invalid.frames[0]).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
  })
})
