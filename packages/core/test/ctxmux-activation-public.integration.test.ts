import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'

const exec = promisify(execFile)
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error('Original private Runtime observation did not complete')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done }
}

it('compiled Core owns SDK activation and public client/CLI reconnect to two original Runs after owner restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-sdk-public-')), runtime = join(root, 'runtime'), state = join(root, 'state')
  await mkdir(runtime, { mode: 0o700 }); await mkdir(state, { mode: 0o700 })
  const nativePids = join(root, 'native-pids'), preload = join(root, 'observe-spawn.cjs')
  // This observes only children created by this isolated Core. SDK spawn/stdio and all
  // public protocol calls remain real; the PID is retained solely for fixture cleanup.
  await writeFile(nativePids, '')
  await writeFile(preload, `const cp=require('node:child_process'),fs=require('node:fs'),original=cp.spawn;cp.spawn=function(...args){const child=original.apply(this,args);if(String(args[0]).endsWith('/ctxmuxd'))fs.appendFileSync(${JSON.stringify(nativePids)},String(child.pid)+'\\n');return child};require('node:module').syncBuiltinESMExports();`)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
    AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson') }
  const cli = resolve(import.meta.dirname, '../dist/headless-runtime-cli.js')
  const owners: ChildProcess[] = [], clients: Array<{ dispose(): Promise<void> }> = []
  const launch = async () => {
    const owner = spawn(process.execPath, ['--require', preload, cli, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    owners.push(owner)
    return await new Promise<{ socketPath: string; owner: { runtimeId: string; ownerInstanceId: string } }>((yes, no) => {
      let stdout = '', stderr = ''
      const timer = setTimeout(() => no(new Error(`Private Core startup did not finish: ${stderr}`)), 20_000)
      owner.stderr!.on('data', data => { stderr += String(data) })
      owner.stdout!.on('data', data => { stdout += String(data); if (!stdout.includes('\n')) return; clearTimeout(timer); try { yes(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))) } catch (error) { no(error) } })
      owner.once('error', error => { clearTimeout(timer); no(error) })
      owner.once('exit', code => { clearTimeout(timer); no(new Error(`Private Core exited ${code}: ${stderr}`)) })
    })
  }
  try {
    const first = await launch()
    const status = async (socket: string) => JSON.parse((await exec(process.execPath, [cli, '--endpoint', `unix:${socket}`, 'status'], { env, timeout: 10_000 })).stdout).result.owner
    const before = await until(() => status(first.socketPath), owner => owner.ctxmux !== null)
    expect(before.runtimeId).toBe(first.owner.runtimeId)
    expect((await readFile(nativePids, 'utf8')).trim().split('\n')).toHaveLength(1)
    const open = async (socket: string) => {
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); clients.push(rpc)
      const client = await connectHostedAgentMux({ rpc }); clients.push(client); return client
    }
    const client = await open(first.socketPath)
    const runs = []
    for (let index = 0; index < 2; index++) {
      const run = await client.createTerminal({ workspacePath: root, command: process.execPath,
        args: ['-e', 'process.stdin.setRawMode(true);process.stdin.on("data",d=>process.stdout.write("echo:"+d));console.log("original-ready");setInterval(()=>{},1000)'] })
      runs.push(run)
      await until(async () => (await client.readRunReplay(run)).replay.map(chunk => chunk.data).join(''), value => value.includes('original-ready'))
    }
    await stop(owners[0]!)
    const second = await launch(), after = await until(() => status(second.socketPath), owner => owner.ctxmux !== null)
    expect(after.runtimeId).toBe(before.runtimeId)
    expect(after.ownerInstanceId).not.toBe(before.ownerInstanceId)
    expect(after.ctxmux).toEqual(before.ctxmux)
    expect((await readFile(nativePids, 'utf8')).trim().split('\n')).toHaveLength(1)
    const reopened = await open(second.socketPath), listed = await reopened.listRuns()
    for (const [index, run] of runs.entries()) {
      expect(listed).toContainEqual(expect.objectContaining({ runId: run.runId, pid: run.pid, state: 'running' }))
      const text = `original-input-${index}`
      await reopened.writeTerminal(run, { ownerInstanceId: after.ctxmux.instanceId, operationId: `input-${index}`, expectedByte: 0, data: text })
      await until(async () => (await reopened.readRunReplay(run)).replay.map(chunk => chunk.data).join(''), value => value.includes('echo:' + text))
      await reopened.stopTerminal({ runId: run.runId })
    }
    expect((await status(second.socketPath)).ctxmux).toEqual(before.ctxmux)
  } finally {
    for (const client of clients.reverse()) await client.dispose()
    for (const owner of owners.reverse()) await stop(owner)
    for (const pid of (await readFile(nativePids, 'utf8')).trim().split('\n').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}, 60_000)
