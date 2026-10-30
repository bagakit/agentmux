import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const entry = process.env.AGENTMUX_TEST_DURABLE_RESUME_ENTRY
if (!entry || !process.env.AGENTMUX_TEST_OBJECT_CLI) throw new Error('Dispatch proof requires its current-source compiled Core and CLI from the task oracle')
const core = await import(/* @vite-ignore */ entry)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private process proof cleanup failed')
})
it.each(['positional-argv', 'post-launch-only', 'no-input'] as const)('restores the original retained Run across actual Core processes and public consumers: %s', async shape => {
  const delivery = shape === 'no-input' ? 'positional-argv' : shape
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ard-'))), runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime, { mode: 0o700 }); await mkdir(state, { mode: 0o700 })
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let nativeError = ''; daemon.stderr!.on('data', bytes => { nativeError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(nativeError) })])
  const secret = 'private-env-sentinel-absent-from-public', request = { agentSessionId: 'original-session', operationId: 'original-resume',
    prompt: shape === 'no-input' ? '' : 'original process task', args: ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));console.log('LAUNCH');setInterval(()=>{},1000)"],
    env: { PRIVATE_SENTINEL: secret }, cols: 83, rows: 26 }
  const requestPath = join(root, 'request.json')
  await writeFile(requestPath, JSON.stringify({ root, storePath: join(root, 'sessions.sqlite'), delivery, request }), { mode: 0o600 })
  const env = objectCliEnvironment(root, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_TEST_DURABLE_RESUME_ENTRY: entry, AGENTMUX_TEST_RESUME_PROCESS_REQUEST: requestPath })
  async function owner(mode: string) {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/prepared-resume-process.mjs'), mode], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stderr = ''; child.stderr!.on('data', bytes => { stderr += String(bytes) })
    const ended = once(child, 'exit')
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); expect((await ended)[0], stderr).toBe(0) } })
    const [message] = await Promise.race([once(child, 'message'), ended.then(() => { throw new Error('Core process exited before receipt: ' + stderr) })]) as any
    expect(message.phase, JSON.stringify(message) + stderr).toBe(mode === 'seed' ? 'unknown' : 'ready')
    return { child, ended, message, stderr: () => stderr }
  }
  const first = await owner('seed')
  expect(first.message).toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED', starts: 1, inputs: 0, prepared: true, actualRun: expect.any(String), actualPid: expect.any(Number) })
  expect((await first.ended)[0], first.stderr()).toBe(0)
  const second = await owner('restore')
  expect(second.message.pid).not.toBe(first.message.pid)
  expect(second.message).toMatchObject({ starts: 0, inputs: delivery === 'post-launch-only' ? 1 : 0,
    session: { agentSessionId: request.agentSessionId, run: { runId: first.message.actualRun }, nativeHandle: first.message.previous.nativeHandle } })
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } })
  cleanups.push(() => rpc.dispose())
  const hosted = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => hosted.dispose())
  const same = shape === 'no-input' ? await hosted.ensureAgentContinuity({ agentSessionId: request.agentSessionId, operationId: request.operationId,
    expectedRun: first.message.previous.run, trigger: 'manual' }) : await hosted.resumeAgent(request)
  expect(same.run).toEqual(second.message.session.run)
  const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: request.agentSessionId } })
  expect(inspected.session.run).toEqual(second.message.session.run)
  const cliEnv = objectCliEnvironment(root)
  for (const args of [['agent', 'inspect', '--session', request.agentSessionId], ['agent', 'resume', '--session', request.agentSessionId, '--operation-id', request.operationId]]) {
    const result = await runCompiledObjectCli(args, cliEnv)
    if (args[1] === 'resume' && shape !== 'no-input') {
      // Textless CLI resume cannot impersonate the original input-bearing SDK request.
      expect(result.code).toBe(1); expect(JSON.parse(result.stderr.trim().split('\n').at(-1)!)).toMatchObject({ error: { code: 'AGENT_CONTINUITY_OPERATION_CONFLICT' } })
    } else { expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain(first.message.actualRun) }
    expect(result.stdout + result.stderr).not.toContain(secret)
  }
  expect(JSON.stringify(inspected) + JSON.stringify(second.message)).not.toContain(secret)
  expect(JSON.stringify(inspected)).not.toContain('preparedDispatch')
  await hosted.writeAgent({ agentSessionId: request.agentSessionId, expectedRun: second.message.session.run, source: 'user', data: 'healthy-after-process-restart' })
  await expect.poll(async () => (await hosted.readRunReplay(second.message.session.run)).replay.map((chunk: any) => chunk.data).join('')).toContain('healthy-after-process-restart')
  const final = once(second.child, 'message'); second.child.send('close')
  expect((await final)[0]).toMatchObject({ phase: 'final', starts: 0, inputs: delivery === 'post-launch-only' ? 1 : 0,
    stopped: [expect.objectContaining({ runId: first.message.actualRun, pid: first.message.actualPid, processExited: true })] })
  expect(() => process.kill(first.message.actualPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  expect((await second.ended)[0], second.stderr()).toBe(0)
})
