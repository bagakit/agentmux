import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { CrashLog } from '../src/main/crash-log.js'
import { reportStartupFailureAndExit, type StartupFailureExitIo } from '../src/main/startup-failure-exit.js'

const CONFIG_PATH = '/tmp/agentmux/agentmux.config.json'

function ioWith(overrides: Partial<StartupFailureExitIo> = {}): {
  io: StartupFailureExitIo
  diagnostics: string[]
  exits: number[]
} {
  const diagnostics: string[] = []
  const exits: number[] = []
  const io: StartupFailureExitIo = {
    configPath: CONFIG_PATH,
    showErrorBox: () => {},
    disposeOwners: async () => {},
    writeDiagnostic: (line) => diagnostics.push(line),
    attemptId: 'attempt-test-123',
    appVersion: '9.9.9-test',
    pid: 4242,
    exit: (code) => exits.push(code),
    ...overrides
  }
  return { io, diagnostics, exits }
}

describe('startup failure diagnostics', () => {
  it('persists a complete startup-failure record before exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-startup-diagnostics-'))
    const path = join(directory, 'crash-log.ndjson')
    const crashLog = new CrashLog(path)
    const { io, exits } = ioWith({ persistDiagnostic: (record) => crashLog.appendSync(record) })

    await reportStartupFailureAndExit(new Error('config schema rejected'), io)

    const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(record.kind).toBe('startup-failure')
    expect(record.phase).toBe('bootstrap')
    expect(record.attemptId).toBe('attempt-test-123')
    expect(record.appVersion).toBe('9.9.9-test')
    expect(record.pid).toBe(4242)
    expect(record.configPath).toBe(CONFIG_PATH)
    expect(record.summary).toContain('config schema rejected')
    expect(exits).toEqual([1])
  })

  it('keeps the original failure path when diagnostic persistence throws', async () => {
    const { io, diagnostics, exits } = ioWith({
      persistDiagnostic: () => {
        throw new Error('disk full while writing crash log')
      }
    })

    await reportStartupFailureAndExit(new Error('original startup failure'), io)

    expect(diagnostics).toContain('disk full while writing crash log')
    expect(diagnostics).toContain('original startup failure')
    expect(exits).toEqual([1])
  })
})
