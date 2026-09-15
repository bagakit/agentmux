import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxClientEvent, AgentMuxRunDataEvent } from '../src/types.js'

const cli = vi.hoisted(() => ({
  argv: [] as string[], lines: [] as string[], errors: [] as string[],
  exitCode: undefined as number | undefined, client: null as unknown
}))
// Execute the actual CLI entry without changing the test runner's argv, environment, streams or
// signal listeners, and without connecting to any real user Runtime or Session store.
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:process') }>()
  return { default: {
    ...actual.default, argv: cli.argv,
    env: { ...actual.default.env, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: 'cli-byte-session' },
    stdout: { write: (line: string) => { cli.lines.push(line); return true } },
    stderr: { write: (line: string) => { cli.errors.push(line); return true } },
    once: vi.fn(), off: vi.fn(),
    get exitCode() { return cli.exitCode }, set exitCode(code: number | undefined) { cli.exitCode = code }
  } }
})
vi.mock('../src/runtime-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/runtime-client.js')>(),
  connectLocalAgentMux: async () => cli.client
}))

beforeEach(() => {
  vi.resetModules()
  cli.argv.length = 0
  cli.lines.length = 0
  cli.errors.length = 0
  cli.exitCode = undefined
})

function fixture() {
  const listeners = new Set<(event: AgentMuxClientEvent) => void>()
  const replay: AgentMuxRunDataEvent[] = [
    { type: 'data', runId: 'cli-byte-run', startByte: 0, endByte: 1, data: '', dataBytes: Uint8Array.from([0xe4]) },
    { type: 'data', runId: 'cli-byte-run', startByte: 0, endByte: 2, data: '', dataBytes: Uint8Array.from([0xe4, 0xb8]) }
  ]
  const live: AgentMuxClientEvent[] = [
    { type: 'terminal-output', run: { runId: 'cli-byte-run' }, data: '中', dataBytes: Uint8Array.from([0xb8, 0xad]),
      evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte: 1, endByte: 3 } } },
    { type: 'process-state', run: { runId: 'cli-byte-run' }, state: 'exited', pid: 1, exitCode: 0,
      evidence: { source: 'run-process', observedAt: 1 } }
  ]
  const dispose = vi.fn(async () => {})
  const release = vi.fn(async () => {})
  const reattach = vi.fn(async () => {
    for (const event of live) for (const listener of listeners) listener(event)
    return { session: { agentSessionId: 'cli-byte-session' }, attachment: {
      run: { runId: 'cli-byte-run', state: 'running' }, replay, gap: null
    } }
  })
  cli.client = {
    agentSession: () => ({ run: { runId: 'cli-byte-run' } }), reattachAgent: reattach,
    onEvent: (listener: (event: AgentMuxClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }, releaseRunAttachment: release, dispose
  }
  return { reattach, dispose, release, listeners }
}

describe('actual CLI ordered byte JSON', () => {
  it('serializes non-follow replay with base64 and trims the requested mid-character prefix', async () => {
    const { reattach, dispose, release, listeners } = fixture()
    cli.argv.push('node', 'agentmux', 'output', '--session', 'self', '--after-byte', '1')
    await import('../src/agentmux.js')
    await vi.waitFor(() => expect(cli.exitCode).toBe(0))
    expect(cli.errors).toEqual([])
    expect(cli.lines).toHaveLength(1)
    const result = JSON.parse(cli.lines[0]!).result
    expect(result.replay).toEqual([
      { runId: 'cli-byte-run', replay: true, startByte: 1, endByte: 2, dataBase64: 'uA==' }
    ])
    expect([...Buffer.from(result.replay[0].dataBase64, 'base64')]).toEqual([0xb8])
    expect(reattach).toHaveBeenCalledExactlyOnceWith('cli-byte-session', 1)
    expect(release).toHaveBeenCalledExactlyOnceWith({ runId: 'cli-byte-run', state: 'running' })
    expect(dispose).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })

  it('serializes follow replay and live overlap with the same base64 contract and exact raw bytes', async () => {
    const { reattach, dispose, listeners } = fixture()
    cli.argv.push('node', 'agentmux', 'output', '--session', 'self', '--after-byte', '1', '--follow')
    await import('../src/agentmux.js')
    await vi.waitFor(() => expect(cli.exitCode).toBe(0))
    expect(cli.errors).toEqual([])
    const reports = cli.lines.map((line) => JSON.parse(line))
    expect(reports.map((report) => report.event)).toEqual(['attached', 'output', 'output', 'end'])
    const output = reports.filter((report) => report.event === 'output').map((report) => report.result)
    expect(output).toEqual([
      { runId: 'cli-byte-run', replay: true, startByte: 1, endByte: 2, dataBase64: 'uA==' },
      { runId: 'cli-byte-run', replay: false, startByte: 2, endByte: 3, dataBase64: 'rQ==' }
    ])
    expect(output.flatMap((event) => [...Buffer.from(event.dataBase64, 'base64')])).toEqual([0xb8, 0xad])
    expect(reattach).toHaveBeenCalledExactlyOnceWith('cli-byte-session', 1)
    expect(dispose).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })
})
