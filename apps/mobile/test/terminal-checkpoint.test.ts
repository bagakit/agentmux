// @vitest-environment node
import { fixturePath } from '../../../test/fixture-values.mjs'
import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxRunAttachment, type AgentMuxClientEvent } from '@agentmux/core'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import { createMobileTerminalReader, type MobileTerminalCanvas, type MobileTerminalReading } from '../src/terminal/reader'
import { session } from './conversation-fixture'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(resolve(repository, 'packages/core/package.json'))
const { Terminal } = require('@xterm/headless') as { Terminal: typeof HeadlessTerminal }
const encode = (text: string) => new TextEncoder().encode(text)
function contents(terminal: HeadlessTerminal, kind: 'active' | 'normal' = 'active') {
  const buffer = terminal.buffer[kind]
  return Array.from({ length: buffer.length }, (_, index) => ({ text: buffer.getLine(index)!.translateToString(true), wrapped: buffer.getLine(index)!.isWrapped }))
}
function headlessCanvas(terminal: HeadlessTerminal, facts: unknown[], held?: Array<() => void>): MobileTerminalCanvas {
  return {
    get options() { return terminal.options }, get rows() { return terminal.rows }, get buffer() { return terminal.buffer },
    reset() { terminal.reset() }, resize(cols, rows) { terminal.resize(cols, rows) }, scrollToLine(line) { terminal.scrollToLine(line) },
    write(data, done) {
      facts.push({ cols: terminal.cols, rows: terminal.rows, scrollback: terminal.options.scrollback, bytes: new TextDecoder().decode(data) })
      terminal.write(data, () => held ? held.push(done) : done())
    }
  }
}
async function write(terminal: HeadlessTerminal, data: Uint8Array) { await new Promise<void>(done => terminal.write(data, done)) }

it('restores the authoritative old grid, split seed boundary and temporary history capacity before acknowledging its original byte fence', async () => {
  const prefix = '\x1bc' + Array.from({ length: 20 }, (_, index) => `old-${index.toString().padStart(2, '0')}:abcdef\r\n`).join('') + '0123456789ABC', suffix = '\r\nfinal-seed\x1b[6n'
  const restore = encode(prefix + suffix), ownScrollback = 500
  const original = session(), snapshot: AgentMuxRunAttachment = {
    run: { ...original.run, nativeService: null, kind: 'agent', agentSessionId: original.agentSessionId, providerId: 'codex', executorId: 'local', workspacePath: fixturePath("private/checkpoint-fixture"), pid: 1,
      state: 'running', cols: 6, rows: 4, observedAt: 1, latestOutputBytes: 9_001, acceptedInputBytes: 0 },
    replay: [], gap: null, resizeRevision: 3,
    terminal: { type: 'basic-vt', checkpoint: { runId: original.run.runId, throughByte: 9_001, resizeRevision: 3,
      restoreSize: { cols: 12, rows: 6 }, size: { cols: 6, rows: 4 }, restoreScrollbackRows: 17, resizeAfterRestoreBytes: encode(prefix).length }, restoreBytes: restore, resizes: [] }
  }
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: ownScrollback, allowProposedApi: true }), reference = new Terminal({ cols: 12, rows: 6, scrollback: 17, allowProposedApi: true })
  const writes: unknown[] = [], held: Array<() => void> = [], reports: MobileTerminalReading[] = [], forbidden: string[] = [], queries: string[] = []
  terminal.onData(data => queries.push(data))
  const port = {
    agentSession: () => original, onEvent: (_listener: (event: AgentMuxClientEvent) => void) => () => {},
    reattachAgent: vi.fn(async () => ({ session: original, attachment: snapshot })), readRunReplay: vi.fn(async () => snapshot), releaseRunAttachment: vi.fn(async () => {}),
    writeAgent: vi.fn(() => { forbidden.push('writeAgent'); throw new Error('Passive Input') }), resizeAgent: vi.fn(() => { forbidden.push('resizeAgent'); throw new Error('Passive PTY resize') })
  }
  const reader = createMobileTerminalReader({ client: port, agentSessionId: original.agentSessionId, canvas: headlessCanvas(terminal, writes, held), report: value => reports.push(value), scrollback: ownScrollback })
  try {
    reader.setVisible(true)
    await vi.waitFor(() => expect(held).toHaveLength(1))
    expect(writes).toEqual([{ cols: 12, rows: 6, scrollback: 17, bytes: prefix }])
    expect(reader.facts().cursor).toBe(0)
    held.shift()!()
    await vi.waitFor(() => expect(held).toHaveLength(1))
    expect(writes).toEqual([{ cols: 12, rows: 6, scrollback: 17, bytes: prefix }, { cols: 6, rows: 4, scrollback: 17, bytes: suffix }])
    expect(reader.facts().cursor).toBe(0)
    held.shift()!()
    await vi.waitFor(() => expect(reader.facts().cursor).toBe(9_001))
    expect(terminal.options.scrollback).toBe(ownScrollback)
    await write(reference, encode(prefix)); reference.resize(6, 4); await write(reference, encode(suffix)); reference.options.scrollback = ownScrollback
    expect(contents(terminal).length).toBeGreaterThan(terminal.rows)
    expect(contents(terminal)).toEqual(contents(reference))
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([reference.buffer.active.cursorX, reference.buffer.active.cursorY])
    expect(reader.facts().resizeRevision).toBe(3)
    expect(queries).toEqual(['\x1b[4;5R'])
    expect(forbidden).toEqual([]); expect(port.writeAgent.mock.calls).toEqual([]); expect(port.resizeAgent.mock.calls).toEqual([])
    expect(port.readRunReplay.mock.calls).toEqual([])
    expect(reports.at(-1)?.phase).toBe('reading')
  } finally {
    for (const complete of held.splice(0)) complete()
    await reader.dispose(); terminal.dispose(); reference.dispose()
  }
  expect(port.releaseRunAttachment.mock.calls).toEqual([[original.run]])
})

it('restores the local history policy on a failed parser write and leaves the original cursor unconfirmed', async () => {
  const original = session(), prefix = encode('old-grid'), snapshot: AgentMuxRunAttachment = {
    run: { ...original.run, nativeService: null, kind: 'agent', agentSessionId: original.agentSessionId, providerId: 'codex', executorId: 'local', workspacePath: fixturePath("private/checkpoint-fixture"), pid: 1,
      state: 'running', cols: 6, rows: 4, observedAt: 1, latestOutputBytes: 42, acceptedInputBytes: 0 },
    replay: [], gap: null, resizeRevision: 0,
    terminal: { type: 'basic-vt', checkpoint: { runId: original.run.runId, throughByte: 42, resizeRevision: 0,
      restoreSize: { cols: 12, rows: 6 }, size: { cols: 6, rows: 4 }, restoreScrollbackRows: 17, resizeAfterRestoreBytes: prefix.length }, restoreBytes: prefix, resizes: [] }
  }
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 500, allowProposedApi: true }), reports: MobileTerminalReading[] = [], writes: unknown[] = []
  const canvas = headlessCanvas(terminal, writes)
  canvas.write = () => { throw new Error('Actual local parser write failure') }
  const reader = createMobileTerminalReader({ client: { agentSession: () => original, onEvent: () => () => {}, reattachAgent: async () => ({ session: original, attachment: snapshot }),
    readRunReplay: async () => snapshot, releaseRunAttachment: async () => {} }, agentSessionId: original.agentSessionId, canvas, report: value => reports.push(value) })
  try {
    reader.setVisible(true)
    await vi.waitFor(() => expect(reports.at(-1)?.message).toContain('Actual local parser write failure'))
    expect(terminal.options.scrollback).toBe(500)
    expect(reader.facts().cursor).toBe(0)
    expect(reports.at(-1)?.message).toContain('原画面和会话引用仍保留')
  } finally { await reader.dispose(); terminal.dispose() }
})

it('hydrates one real private Core21 checkpoint without changing its live Run, accepted Input or PTY geometry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-mobile-checkpoint-'))
  await mkdir(join(root, 'home/codex'), { recursive: true })
  const originalHomes = Object.fromEntries(['HOME', 'home', 'CODEX_HOME'].map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries({
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })) vi.stubEnv(key, value)
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
  const sourceFiles = ['apps/mobile/src/terminal/reader.ts', 'apps/mobile/test/terminal-checkpoint.test.ts',
    'packages/core/src/terminal-continuation.ts', 'packages/client-ui/src/terminal/replay.ts']
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
    [file, createHash('sha256').update(await readFile(resolve(repository, file))).digest('hex')])))
  const source = await sourceHashes()
  let evidence: Record<string, unknown> | undefined
  let original: Awaited<ReturnType<AgentMuxClient['createAgent']>> | undefined, reader: ReturnType<typeof createMobileTerminalReader> | undefined
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000, allowProposedApi: true }), reference = new Terminal({ cols: 24, rows: 6, scrollback: 10_000, allowProposedApi: true })
  try {
    const worker = join(root, 'worker.py')
    await writeFile(worker, '#!/usr/bin/python3\nimport os,sys,tty\nif "--version" in sys.argv:\n print("Private checkpoint fixture 1");sys.exit(0)\ntty.setraw(0)\nos.write(1,b"\\x1bc"+b"".join(("old-%02d:abcdef\\r\\n"%i).encode() for i in range(30))+b"prefix-ready\\r\\n\\x1b[?1049hALT-SEED")\nwhile True:\n data=os.read(0,4096)\n if not data:break\n os.write(1,b"tail-confirmed\\r\\n")\n', { mode: 0o700 })
    await client.connect()
    original = await client.createAgent({ createOperationId: crypto.randomUUID(), providerId: 'codex', executorId: 'private-checkpoint', commandOverride: worker,
      workspacePath: root, injectAgentMuxGuide: false, env: { CODEX_HOME: join(root, 'home/codex') }, cols: 24, rows: 6 })
    await vi.waitFor(async () => {
      const result = await client.readRunReplay(original!.run, 0, 'raw')
      expect(result.replay.map(chunk => chunk.data).join('')).toContain('prefix-ready')
    }, { timeout: 5_000 })
    await client.resizeAgent(original.agentSessionId, original.run, 12, 4)
    await client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, data: 'Mac fixture tail', source: 'user' })
    await vi.waitFor(async () => {
      const result = await client.readRunReplay(original!.run, 0, 'raw')
      expect(result.replay.map(chunk => chunk.data).join('')).toContain('tail-confirmed')
    }, { timeout: 5_000 })
    const before = (await client.listRuns()).find(run => run.runId === original!.run.runId)!
    const snapshot = await client.readRunReplay(original.run, 0, 'terminal')
    expect(snapshot.terminal.type).toBe('basic-vt')
    if (snapshot.terminal.type !== 'basic-vt') throw new Error('Actual private Run did not produce an authoritative checkpoint')
    const checkpoint = snapshot.terminal.checkpoint
    expect(checkpoint.restoreSize).toEqual({ cols: 24, rows: 4 })
    expect(checkpoint.size).toEqual({ cols: 12, rows: 4 })
    expect(checkpoint.resizeAfterRestoreBytes).toBeGreaterThan(0)
    console.info('ACTUAL_MOBILE_CHECKPOINT', JSON.stringify(checkpoint))
    const writes: unknown[] = [], forbidden: string[] = [], reports: MobileTerminalReading[] = []
    const port = {
      agentSession: client.agentSession.bind(client), onEvent: client.onEvent.bind(client), reattachAgent: client.reattachAgent.bind(client),
      readRunReplay: client.readRunReplay.bind(client), releaseRunAttachment: client.releaseRunAttachment.bind(client),
      writeAgent() { forbidden.push('writeAgent'); throw new Error('Passive Input') }, resizeAgent() { forbidden.push('resizeAgent'); throw new Error('Passive PTY resize') }
    }
    reader = createMobileTerminalReader({ client: port, agentSessionId: original.agentSessionId, canvas: headlessCanvas(terminal, writes), report: value => reports.push(value) })
    reader.setVisible(true)
    await vi.waitFor(() => expect(reader!.facts().cursor).toBe(snapshot.run.latestOutputBytes), { timeout: 5_000 })
    // Reference applies the Runtime's actual seed facts through the public emulator, never reconstructing a checkpoint.
    reference.reset(); reference.resize(checkpoint.restoreSize.cols, checkpoint.restoreSize.rows)
    const ownScrollback = reference.options.scrollback!
    if (checkpoint.restoreScrollbackRows !== null) reference.options.scrollback = checkpoint.restoreScrollbackRows
    await write(reference, snapshot.terminal.restoreBytes.subarray(0, checkpoint.resizeAfterRestoreBytes))
    reference.resize(checkpoint.size.cols, checkpoint.size.rows)
    await write(reference, snapshot.terminal.restoreBytes.subarray(checkpoint.resizeAfterRestoreBytes))
    reference.options.scrollback = ownScrollback
    for (const chunk of snapshot.replay) await write(reference, chunk.dataBytes)
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(contents(terminal, 'normal').length).toBeGreaterThan(terminal.rows)
    expect(contents(terminal, 'normal')).toEqual(contents(reference, 'normal'))
    expect(contents(terminal)).toEqual(contents(reference))
    expect([terminal.cols, terminal.rows, terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([reference.cols, reference.rows, reference.buffer.active.cursorX, reference.buffer.active.cursorY])
    expect(terminal.options.scrollback).toBe(10_000)
    expect(forbidden).toEqual([])
    const after = (await client.listRuns()).find(run => run.runId === original!.run.runId)!
    expect({ runId: after.runId, pid: after.pid, state: after.state, cols: after.cols, rows: after.rows, acceptedInputBytes: after.acceptedInputBytes })
      .toEqual({ runId: before.runId, pid: before.pid, state: before.state, cols: before.cols, rows: before.rows, acceptedInputBytes: before.acceptedInputBytes })
    expect(client.agentSession(original.agentSessionId).run).toEqual(original.run)
    expect(reports.at(-1)?.phase).toBe('reading')
    evidence = { checkpoint, restoreByteLength: snapshot.terminal.restoreBytes.length,
      parsedCursor: reader.facts().cursor, latestOutputBytes: snapshot.run.latestOutputBytes,
      before: { runId: before.runId, pid: before.pid, state: before.state, cols: before.cols, rows: before.rows, acceptedInputBytes: before.acceptedInputBytes },
      after: { runId: after.runId, pid: after.pid, state: after.state, cols: after.cols, rows: after.rows, acceptedInputBytes: after.acceptedInputBytes },
      forbidden, normalBufferLines: contents(terminal, 'normal').length, activeBuffer: terminal.buffer.active.type, normalAndAlternateBuffersMatchReference: true,
      inheritedHomesUnchanged: Object.entries(originalHomes).every(([key, value]) => process.env[key] === value) }
    expect(evidence.inheritedHomesUnchanged).toBe(true)
  } finally {
    try {
      try { await reader?.dispose() }
      finally { if (original) await client.stopAgent(original.agentSessionId, original.run) }
    } finally {
      try { await client.dispose() }
      finally {
        terminal.dispose(); reference.dispose()
        try {
          const cleanup = await import(pathToFileURL(resolve(repository, 'apps/desktop/scripts/probe-process.mjs')).href) as {
            listProbeProcesses(group: number, root: string): Promise<number[]>
            signalOwnedProbeProcess(pid: number, root: string, signal: NodeJS.Signals): Promise<boolean>
          }
          for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
            for (const pid of await cleanup.listProbeProcesses(process.pid + 1_000_000_000, root)) await cleanup.signalOwnedProbeProcess(pid, root, signal)
            await new Promise(done => setTimeout(done, 150))
          }
          const processes = await cleanup.listProbeProcesses(process.pid + 1_000_000_000, root)
          expect(processes).toEqual([])
          if (evidence) evidence.cleanup = processes
          await rm(root, { recursive: true, force: true })
        } finally { vi.unstubAllEnvs() }
      }
    }
  }
  expect(await sourceHashes()).toEqual(source)
  if (process.env.AGENTMUX_CHECKPOINT_EVIDENCE) await writeFile(process.env.AGENTMUX_CHECKPOINT_EVIDENCE,
    JSON.stringify({ source, sourceBeforeAfterEqual: true, ...evidence }, null, 2) + '\n')
}, 30_000)
