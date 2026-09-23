import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { Terminal } from '@xterm/headless'
import { activateRuntime, type RuntimeActivation, type RunInfo } from '@ctxmux/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'

const exec = promisify(execFile)
const coreDirectory = fileURLToPath(new URL('../', import.meta.url))
const markers = ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CI', 'CODEX_CI', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION']
const dirty = { NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0', CI: '1', CODEX_CI: '1', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' }
const clean = Object.fromEntries(markers.map(key => [key, null]))
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000
  do { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < deadline)
  throw new Error('Private color fixture did not observe the required fact')
}
async function exited(activation: RuntimeActivation, id: string): Promise<RunInfo> {
  return await waitFor(() => activation.client.status(id), run => run.state.type !== 'running')
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}
async function privateRuntime(run: (root: string, activation: RuntimeActivation, clients: AgentMuxClient[], pids: number[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp('/tmp/amx-color-run-')
  let activation: RuntimeActivation | undefined
  const clients: AgentMuxClient[] = [], pids: number[] = []
  try {
    const runtime = join(root, 'runtime'), state = join(root, 'state')
    await mkdir(runtime, { mode: 0o700 }); await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
    for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
    for (const [key, path] of Object.entries({ AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
      AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })) vi.stubEnv(key, path)
    for (const key of markers) vi.stubEnv(key, undefined)
    activation = await activateRuntime({ executable: join(coreDirectory, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
      socketPath: join(runtime, 'ctxmux.sock'), stateDir: join(state, 'ctxmux'), timeoutMs: 5000, env: dirty,
      childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'ignore' } })
    expect(activation.spawned).toBe(true)
    pids.push(activation.childPid!)
    await run(root, activation, clients, pids)
  } finally {
    await Promise.all(clients.map(client => client.dispose()))
    await activation?.dispose({ shutdown: true })
    for (const pid of pids) await waitFor(async () => gone(pid), value => value)
    await rm(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
  expect(pids.length).toBeGreaterThan(1)
  expect(pids.map(gone)).toEqual(pids.map(() => true))
}
async function colorCells(bytes: string): Promise<Record<string, { mode: number; color: number }>> {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  try {
    await new Promise<void>(resolve => terminal.write(bytes, resolve))
    const found: Record<string, { mode: number; color: number }> = {}
    for (let row = 0; row < terminal.buffer.active.length; row++) {
      const line = terminal.buffer.active.getLine(row)!
      for (const word of ['ANSI16', 'ANSI256', 'RGB']) {
        const column = line.translateToString().indexOf(word)
        if (column < 0) continue
        const cell = line.getCell(column)!
        found[word] = { mode: cell.getFgColorMode(), color: cell.getFgColor() }
      }
    }
    expect(Object.keys(found).sort()).toEqual(['ANSI16', 'ANSI256', 'RGB'])
    return found
  } finally { terminal.dispose() }
}

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('real Run exec against a long-lived dirty Native', () => {
  it('removes omitted host markers, preserves explicit values and literal argv/cwd/PID/exit/create identity', async () => {
    await privateRuntime(async (root, activation, clients, pids) => {
      const client = new AgentMuxClient(); clients.push(client); await client.connect()
      const command = `process.stdout.write(JSON.stringify({environment:Object.fromEntries(${JSON.stringify(markers)}.map(k=>[k,process.env[k]??null])),pid:process.pid,cwd:process.cwd(),argv:process.argv.slice(1)}));process.exit(37)`
      const literal = 'literal ; $(never) `never` * "$VALUE"'
      const input = { workspacePath: root, command: process.execPath, args: ['-e', command, '--', literal, '-u'], createOperationId: 'private-color-terminal' }
      const created = await client.createTerminal(input); pids.push(created.pid!)
      const state = await exited(activation, created.runId)
      const raw = await client.readRunReplay({ runId: created.runId })
      const observed = JSON.parse(raw.replay.map(chunk => Buffer.from(chunk.dataBytes).toString()).join('').trim())
      expect(observed).toEqual({ environment: clean, pid: created.pid, cwd: root, argv: [literal, '-u'] })
      expect(state.state).toEqual({ type: 'exited', code: 37, signal: null })
      expect(state.spec!.program).toBe('/usr/bin/env')
      expect(state.spec!.args.slice(-input.args.length - 1)).toEqual([process.execPath, ...input.args])
      expect(state.spec!.args).not.toContain('FORCE_COLOR=0')
      expect((await client.createTerminal(input)).runId).toBe(created.runId)
      const explicit = { FORCE_COLOR: '3', CLICOLOR: '1', CI: 'manual-ci', CODEX_CI: 'manual-codex', CLAUDECODE: 'manual-claude', CLAUDE_CODE_CHILD_SESSION: 'manual-child' }
      const override = await client.createTerminal({ ...input, createOperationId: 'private-color-explicit', env: explicit }); pids.push(override.pid!)
      await exited(activation, override.runId)
      const overrideRaw = await client.readRunReplay({ runId: override.runId })
      const overrideObserved = JSON.parse(overrideRaw.replay.map(chunk => Buffer.from(chunk.dataBytes).toString()).join('').trim())
      expect(overrideObserved.environment).toEqual({ NO_COLOR: null, ...explicit })
      const signalled = await client.createTerminal({ workspacePath: root, command: process.execPath,
        args: ['-e', "process.kill(process.pid,'SIGTERM')"] }); pids.push(signalled.pid!)
      const signalState = await exited(activation, signalled.runId)
      expect(signalState.state).toEqual({ type: 'exited', code: 1, signal: 'Terminated: 15' })
      expect((await activation.client.runtimeInfo()).daemonInstanceId).toBe(activation.runtime.daemonInstanceId)
    })
  }, 20000)

  it('new Agent and semantic resume remain colored across real client process restart without disturbing an existing Run', async () => {
    await privateRuntime(async (root, activation, _clients, pids) => {
      const sentinel = await activation.client.start({ program: process.execPath,
        args: ['-e', "process.stdout.write('existing healthy Run');process.stdin.resume()"], cwd: root, env: {},
        initial_size: { cols: 80, rows: 24 }, declared_inputs: [] })
      pids.push(sentinel.pid!)
      const before = await waitFor(() => activation.client.status(sentinel.id), run => run.latest_output_bytes > 0)
      const app = join(root, 'app'); await mkdir(join(app, 'dist'), { recursive: true })
      await symlink(join(coreDirectory, 'node_modules'), join(app, 'node_modules'), 'dir')
      await symlink(join(coreDirectory, 'vendor'), join(app, 'vendor'), 'dir')
      await writeFile(join(root, 'cli.mjs'), await readFile(new URL('./fixtures/color-runtime-cli.mjs', import.meta.url)))
      await writeFile(join(root, 'agent.ndjson'), '')
      const worker = join(app, 'dist', 'worker.mjs')
      await build({ entryPoints: [fileURLToPath(new URL('./fixtures/color-runtime-client.ts', import.meta.url))],
        outfile: worker, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
      const invoke = async (phase: string): Promise<any> => {
        const output = await exec(process.execPath, [worker, root, phase], { maxBuffer: 1024 * 1024 })
        const receipt = JSON.parse(output.stdout.trim())
        if (!pids.includes(receipt.run.pid)) pids.push(receipt.run.pid)
        expect(receipt.observation.environment).toEqual(clean)
        expect(receipt.observation.pid).toBe(receipt.run.pid)
        expect(receipt.observation.cwd).toBe(root)
        expect(receipt.hook).toMatchObject({ status: 204, pid: receipt.run.pid })
        expect(receipt.rawText).toContain('\x1b[31mANSI16')
        expect(receipt.rawText).toContain('\x1b[38;5;208mANSI256')
        expect(receipt.rawText).toContain('\x1b[38;2;10;120;240mRGB')
        expect(receipt.terminal.type).toBe('basic-vt')
        expect(receipt.terminal.checkpoint.runId).toBe(receipt.run.runId)
        const rawColors = await colorCells(receipt.rawText)
        expect(Object.values(rawColors).map(cell => cell.color)).toEqual([1, 208, 0x0a78f0])
        expect(await colorCells(Buffer.from(receipt.terminal.restoreBytes, 'base64').toString())).toEqual(rawColors)
        return receipt
      }
      const created = await invoke('create')
      expect(created.restored).toEqual([])
      expect(created.observation.argv).toEqual(['literal ; $(never) `never` * "$VALUE"', '-u', '--'])
      const reattached = await invoke('reattach')
      expect(reattached.processPid).not.toBe(created.processPid)
      expect(reattached.restored).toEqual([{ id: created.session.id, run: created.session.run, nativeHandle: created.session.nativeHandle }])
      expect(reattached.run.pid).toBe(created.run.pid)
      expect(reattached.session).toEqual(created.session)
      expect(reattached.finalState).toMatchObject({ state: 'exited', exitCode: 23, pid: created.run.pid })
      expect(reattached.input).toMatchObject({ runId: created.run.runId, acceptedThroughByte: 19 })
      const resumed = await invoke('resume')
      expect(resumed.processPid).not.toBe(reattached.processPid)
      expect(resumed.restored).toEqual(reattached.restored)
      expect(resumed.session.id).toBe(created.session.id)
      expect(resumed.session.nativeHandle).toEqual(created.session.nativeHandle)
      expect(resumed.session.run).not.toEqual(created.session.run)
      expect(resumed.session.retiredRuns).toEqual([created.session.run])
      expect(resumed.observation.argv).toEqual([...created.observation.argv, '--resume-id', 'private-native-color', '--prompt', 'resume-color-private'])
      const after = await activation.client.status(sentinel.id)
      expect({ id: after.id, pid: after.pid, state: after.state, accepted: after.applied_input_bytes, bytes: after.latest_output_bytes })
        .toEqual({ id: before.id, pid: before.pid, state: before.state, accepted: before.applied_input_bytes, bytes: before.latest_output_bytes })
      expect((await activation.client.runtimeInfo()).daemonInstanceId).toBe(activation.runtime.daemonInstanceId)
      console.info(JSON.stringify({ schema: 'agentmux.private-product-color-regression.v1', productionControls: [],
        phases: [created, reattached, resumed].map(row => ({ phase: row.phase, processPid: row.processPid, cliPid: row.run.pid,
          runId: row.run.runId, agentSessionId: row.session.id, nativeHandle: row.session.nativeHandle, environment: row.observation.environment,
          terminalType: row.terminal.type })), originalRunPreserved: true, servingNativeUnchanged: true }))
    })
  }, 30000)
})
