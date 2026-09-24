import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

const processTable = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  // Actual list/signal helpers use promisified execFile. This process table never
  // executes ps, spawns an App, or sends an OS signal.
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: (...args: unknown[]) => processTable.exec(...args) })
  return { ...original, execFile }
})
import { listProbeProcesses, signalOwnedProbeProcess } from '../scripts/probe-process.mjs'

const source = readFileSync(new URL('../scripts/verify-terminal-live-scroll.mjs', import.meta.url), 'utf8')
function actualCleanup() {
  const file = ts.createSourceFile('verify-terminal-live-scroll.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  expect(file.parseDiagnostics).toHaveLength(0)
  const owners = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'cleanupOwnedProbes')
  expect(owners).toHaveLength(1)
  expect(owners[0]!.body!.statements.length).toBeGreaterThan(0)
  return owners[0]!.getText(file)
}

type Entry = { pid: number; pgid: number; state: string; command: string }
function fixture(entries: Entry[]) {
  const root = '/tmp/agentmux-live-read-source-owned'
  const table = new Map(entries.map(entry => [entry.pid, entry]))
  let beforeVerify: ((pid: number) => void) | undefined
  let emptyObservation = false, now = 0
  const signals: Array<{ pid: number; name: NodeJS.Signals | number | undefined }> = []
  const rejectedSignals = new Set<number>()
  processTable.exec.mockReset()
  processTable.exec.mockImplementation(async (file: string, args: string[]) => {
    if (file === 'ps') {
      expect(args).toEqual(['-axo', 'pid=,pgid=,stat=,command='])
      return { stdout: [...table.values()].map(entry => `${entry.pid} ${entry.pgid} ${entry.state} ${entry.command}`).join('\n'), stderr: '' }
    }
    expect(file).toBe('/bin/ps')
    const pid = Number(args[1]); expect(args).toEqual(['-p', String(pid), '-o', 'stat=,command='])
    beforeVerify?.(pid)
    const entry = table.get(pid)
    if (!entry) throw Object.assign(new Error('exited'), { code: 1, stdout: '', stderr: '' })
    return { stdout: emptyObservation ? '' : `${entry.state} ${entry.command}`, stderr: '' }
  })
  vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
    signals.push({ pid, name })
    expect(pid).toBeGreaterThan(1)
    const entry = table.get(pid)
    if (!entry) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    if (name === 0) return true
    if (rejectedSignals.has(pid)) throw Object.assign(new Error(`permission rejected ${pid}`), { code: 'EPERM' })
    table.delete(pid); return true
  })
  const globals = { assert, listProbeProcesses, signalOwnedProbeProcess, Date: { now: () => now },
    setTimeout: (done: () => void, ms: number) => { now += ms; done(); return 0 } }
  const cleanup = new Function(...Object.keys(globals), `${actualCleanup()}\nreturn cleanupOwnedProbes`)(...Object.values(globals)) as
    (temporaryRoot: string) => Promise<{ remaining: number[] | null; errors: string[] }>
  return { root, table, signals, rejectedSignals, cleanup, setBeforeVerify: (fn: (pid: number) => void) => { beforeVerify = fn },
    setEmptyObservation: () => { emptyObservation = true } }
}
const root = '/tmp/agentmux-live-read-source-owned'
const owned = (pid: number): Entry => ({ pid, pgid: 720001, state: 'S', command: `node ${root}/native-reader.mjs` })
const foreign = (pid: number): Entry => ({ pid, pgid: 720001, state: 'S', command: 'node /tmp/foreign-runtime/reader.mjs' })
afterEach(() => vi.restoreAllMocks())

describe('actual private terminal Native cleanup owner', () => {
  it('cleans an owned reader after the original child exited while a foreign process reuses its PID/PGID', async () => {
    const reader = owned(720002), reusedChild = foreign(720001), other = foreign(720003)
    const x = fixture([reader, reusedChild, other])
    expect(await x.cleanup(x.root)).toEqual({ remaining: [], errors: [] })
    expect(x.signals).toEqual([{ pid: reader.pid, name: 'SIGTERM' }])
    expect([...x.table.values()]).toEqual([reusedChild, other])
    expect(processTable.exec.mock.calls.some(call => call[0] === '/bin/ps' && call[1][1] === String(reader.pid))).toBe(true)
  })

  it('rechecks a discovered PID and refuses its new foreign identity while still cleaning another owned reader', async () => {
    const first = owned(720002), second = owned(720003), replacement = foreign(first.pid)
    const x = fixture([first, second])
    x.setBeforeVerify(pid => { if (pid === first.pid) x.table.set(pid, replacement) })
    expect(await x.cleanup(x.root)).toEqual({ remaining: [], errors: ['Private process identity changed'] })
    expect(x.signals).toEqual([{ pid: second.pid, name: 'SIGTERM' }])
    expect([...x.table.values()]).toEqual([replacement])
  })

  it('keeps one PID permission failure visible and continues with the next owned reader', async () => {
    const denied = owned(720002), healthy = owned(720003), unrelated = foreign(720004)
    const x = fixture([denied, healthy, unrelated]); x.rejectedSignals.add(denied.pid)
    const result = await x.cleanup(x.root)
    expect(result.remaining).toEqual([denied.pid])
    expect(result.errors.slice(0, 2)).toEqual([`permission rejected ${denied.pid}`, `permission rejected ${denied.pid}`])
    expect(result.errors).toHaveLength(3)
    expect(x.signals).toEqual([{ pid: denied.pid, name: 'SIGTERM' }, { pid: healthy.pid, name: 'SIGTERM' }, { pid: denied.pid, name: 'SIGKILL' }])
    expect([...x.table.values()]).toEqual([denied, unrelated])
  })

  it('handles a real exited PID observation race without signalling a replacement process', async () => {
    const reader = owned(720002), x = fixture([reader])
    x.setBeforeVerify(pid => x.table.delete(pid))
    expect(await x.cleanup(x.root)).toEqual({ remaining: [], errors: [] })
    expect(x.signals).toEqual([{ pid: reader.pid, name: 0 }])
    expect([...x.table.values()]).toEqual([])
  })

  it('retains an empty ps observation as an identity failure when the positive PID is still live', async () => {
    const reader = owned(720002), x = fixture([reader]); x.setEmptyObservation()
    const result = await x.cleanup(x.root)
    expect(result.remaining).toEqual([reader.pid])
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toContain('Private process state could not be observed')
    expect(result.errors[1]).toContain('Private process state could not be observed')
    expect(x.signals).toEqual([{ pid: reader.pid, name: 0 }, { pid: reader.pid, name: 0 }])
    expect([...x.table.values()]).toEqual([reader])
  })
})
