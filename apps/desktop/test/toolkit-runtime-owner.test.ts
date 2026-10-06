import { expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { activateRuntime } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import { toolkitRuntime } from './helpers/toolkit-runtime.fixture.js'
import { cleanups, nativeMain, oneCli, record, until } from './toolkit-main.fixture.js'

const privateRuntime = toolkitRuntime
async function reap(owned: Awaited<ReturnType<typeof toolkitRuntime>>) {
  // Independent corrective cleanup uses the original SDK owner even while the
  // fixture consumer is deliberately mutated; it is not the product oracle.
  await owned.activation.shutdown(); await owned.activation.dispose(); await owned.cleanup()
}

it('Toolkit owner awaits the original SDK child exit and leaves a peer and argv lookalike alive', async () => {
  const owned = await privateRuntime(), peer = await privateRuntime()
  const lookalike = spawn(process.execPath, ['-e', 'process.stdin.resume()', `ctxmuxd --socket ${owned.activation.socketPath}`], { stdio: ['pipe', 'ignore', 'ignore'] })
  const originalShutdown = owned.activation.shutdown.bind(owned.activation)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const delayed = vi.spyOn(owned.activation, 'shutdown').mockImplementation(async () => { await gate; await originalShutdown() })
  try {
    const peerBefore = await peer.activation.client.runtimeInfo()
    let settled = false
    const cleaning = owned.cleanup().then(receipt => { settled = true; return receipt })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect((await lstat(owned.directory)).isDirectory()).toBe(true)
    release()
    const receipt = await cleaning
    expect(receipt).toMatchObject({ childExit: 'confirmed', namespace: 'removed', childPid: owned.activation.childPid })
    await expect(lstat(owned.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(lookalike.exitCode).toBeNull(); expect(lookalike.signalCode).toBeNull()
    expect(await peer.activation.client.runtimeInfo()).toEqual(peerBefore)
    await record('runtime-owner-exit', { receipt, peerIdentity: peerBefore, lookalikePid: lookalike.pid, peerPreserved: true })
  } finally {
    release(); delayed.mockRestore()
    if (lookalike.exitCode === null && lookalike.signalCode === null) {
      const exited = once(lookalike, 'exit'); lookalike.kill('SIGTERM'); await exited
    }
    await reap(owned); await reap(peer)
  }
})

it('a selected existing Runtime has no fixture creation authority', async () => {
  const owner = await privateRuntime()
  const adopted = await activateRuntime({ executable: owner.executable, socketPath: owner.activation.socketPath, timeoutMs: 5000 })
  try {
    expect(adopted.spawned).toBe(false)
    const before = await owner.activation.client.runtimeInfo()
    await expect(adopted.shutdown()).rejects.toMatchObject({ code: 'runtime_conflict' })
    // Controlled producer fact at the fixture boundary; the real selected handle
    // above establishes the SDK's independent ownership refusal.
    Object.defineProperty(owner.activation, 'spawned', { value: false })
    expect(await owner.cleanup()).toMatchObject({ childExit: 'not-owned', namespace: 'retained' })
    Object.defineProperty(owner.activation, 'spawned', { value: true })
    expect((await lstat(owner.directory)).isDirectory()).toBe(true)
    expect(await owner.activation.client.runtimeInfo()).toEqual(before)
    await record('runtime-owner-adopted', { directory: owner.directory, identity: before, retained: true })
  } finally { Object.defineProperty(owner.activation, 'spawned', { value: true }); await adopted.dispose(); await reap(owner) }
})

it('unknown SDK exit receipt retains the original healthy Runtime and namespace', async () => {
  const owned = await privateRuntime()
  const unavailable = vi.spyOn(owned.activation, 'shutdown').mockRejectedValue(new Error('Controlled unavailable exit observation'))
  try {
    const before = await owned.activation.client.runtimeInfo()
    expect(await owned.cleanup()).toMatchObject({ childExit: 'unknown', namespace: 'retained' })
    expect((await lstat(owned.directory)).isDirectory()).toBe(true)
    expect(await owned.activation.client.runtimeInfo()).toEqual(before)
    await record('runtime-owner-unknown', { directory: owned.directory, identity: before, retained: true, controlledShutdownReceipt: true })
  } finally { unavailable.mockRestore(); await reap(owned) }
})

it('the original child exit does not authorize deletion of a replacement live socket', async () => {
  const owned = await privateRuntime()
  await unlink(owned.activation.socketPath)
  const stateDir = join(owned.directory, 'replacement-state'); await mkdir(stateDir, { mode: 0o700 })
  const replacement = await activateRuntime({ executable: owned.executable, socketPath: owned.activation.socketPath, stateDir, timeoutMs: 5000 })
  try {
    expect(replacement.spawned).toBe(true)
    const before = await replacement.client.runtimeInfo()
    expect(before.daemonInstanceId).not.toBe(owned.activation.runtime.daemonInstanceId)
    const receipt = await owned.cleanup()
    expect(receipt).toMatchObject({ childExit: 'confirmed', namespace: 'retained' })
    expect((await lstat(owned.directory)).isDirectory()).toBe(true)
    expect(await replacement.client.runtimeInfo()).toEqual(before)
    await record('runtime-owner-replacement', { receipt, replacement: before, replacementPreserved: true })
  } finally { await replacement.shutdown(); await replacement.dispose(); await reap(owned) }
})

it('the original child exit does not authorize deletion of a replaced private directory', async () => {
  const owned = await privateRuntime(), saved = owned.directory + '-original'
  await rename(owned.directory, saved); await mkdir(owned.directory, { mode: 0o700 })
  const marker = join(owned.directory, 'replacement.txt'); await writeFile(marker, 'replacement')
  try {
    const receipt = await owned.cleanup()
    expect(receipt).toMatchObject({ childExit: 'confirmed', namespace: 'retained' })
    expect(await readFile(marker, 'utf8')).toBe('replacement')
    await record('runtime-owner-directory', { receipt, replacementPreserved: true })
  } finally { await owned.activation.shutdown(); await owned.activation.dispose(); await rm(owned.directory, { recursive: true, force: true }); await rm(saved, { recursive: true, force: true }) }
})

it('failed Main disposal still awaits its SDK child exit and retains the original namespace', async () => {
  const main = await nativeMain(), identity = await lstat(main.directory)
  const automaticClose = cleanups[cleanups.length - 1]!
  const primary = new Error('Controlled Main disposal failure')
  const failure = vi.spyOn(main.sender, 'off').mockImplementation(() => { throw primary })
  const shutdown = vi.spyOn(main.activation, 'shutdown')
  const directoryOutcome = async () => lstat(main.directory).then(stat => ({ state: 'present' as const, identity: [stat.dev, stat.ino] }), error => {
    if (error.code === 'ENOENT') return { state: 'absent' as const, identity: null }
    throw error
  })
  const containsPrimary = (error: unknown): boolean => error === primary ||
    error instanceof AggregateError && error.errors.some(containsPrimary) ||
    error instanceof Error && error.cause !== undefined && containsPrimary(error.cause)
  try {
    const observed = await main.close().then(() => null, error => error)
    expect(observed).toBeInstanceOf(AggregateError)
    expect(containsPrimary(observed)).toBe(true)
    expect(shutdown).toHaveBeenCalledOnce()
    await expect(main.sdk.runtimeInfo()).rejects.toThrow()
    const retained = await directoryOutcome()
    expect(retained).toEqual({ state: 'present', identity: [identity.dev, identity.ino] })
    await record('runtime-owner-main-disposal-failure', { directory: main.directory,
      primaryRetained: containsPrimary(observed), originalChildExitAwaited: true, namespace: 'retained' })
  } finally {
    failure.mockRestore(); shutdown.mockRestore()
    // This case explicitly consumed the expected close failure. Corrective
    // cleanup uses the original SDK owner and unchanged directory, never a PID scan.
    cleanups.splice(cleanups.indexOf(automaticClose), 1)
    await main.activation.shutdown(); await main.activation.dispose()
    const retained = await directoryOutcome()
    if (retained.state === 'present') {
      expect(retained.identity).toEqual([identity.dev, identity.ino])
      await rm(main.directory, { recursive: true })
    } else await record('runtime-owner-corrective-close', { directory: main.directory, namespace: 'already-absent', originalChildExitAwaited: true })
  }
})

it('registered Main IPC public RPC and CLI reconnect to the original SDK-created Native', async () => {
  const callerKeys = ['AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY'] as const
  const originalCaller = callerKeys.map(key => process.env[key])
  cleanups.push(async () => callerKeys.forEach((key, index) => {
    if (originalCaller[index] === undefined) delete process.env[key]; else process.env[key] = originalCaller[index]
  }))
  process.env.AGENTMUX_AGENT_SESSION_ID = 'controlled-original-caller'
  process.env.AGENTMUX_AGENT_CAPABILITY = 'controlled-original-capability'
  const main = await nativeMain()
  try {
  const before = await main.sdk.runtimeInfo()
  expect(main.activation.spawned).toBe(true)
  expect(before.daemonInstanceId).toBe(main.activation.runtime.daemonInstanceId)
  const fields = { name: 'Owned Runtime', icon: 'terminal', enabled: true, statusBar: 'icon',
    workspacePath: join(main.directory, 'work'), script: "process.stdout.write('owned-runtime-ACK')", args: [] }
  await main.rpc.call('toolkit.create', { toolId: 'owned-runtime', value: fields })
  await oneCli('toolkit', 'run', 'owned-runtime')
  let snapshot: any
  await until(async () => { snapshot = (await oneCli('toolkit', 'inspect', 'owned-runtime')).result.snapshot; expect(snapshot.latestConfirmed?.text).toBe('owned-runtime-ACK') })
  const execution = snapshot.latestConfirmed
  const ipc = await Promise.resolve().then(() => main.invoke('toolkit:get', 'owned-runtime')).then((result: any) => ({ result, error: null }), (error: unknown) => ({ result: null, error: String(error) }))
  expect(ipc.error).toBeNull()
  expect(ipc.result.snapshot.latestConfirmed).toEqual(execution)
  const terminal = await main.core.createTerminal({ workspacePath: join(main.directory, 'work'), command: process.execPath,
    args: ['-e', "process.stdout.write(JSON.stringify({session:process.env.AGENTMUX_AGENT_SESSION_ID??null,capability:process.env.AGENTMUX_AGENT_CAPABILITY!==undefined,endpoint:process.env.AGENTMUX_RPC_ENDPOINT}))"] })
  await until(async () => expect((await main.sdk.status(terminal.runId as any)).state.type).toBe('exited'))
  const replay = await main.core.readRunReplay({ runId: terminal.runId })
  const environment = JSON.parse(replay.replay.map(chunk => Buffer.from(chunk.dataBytes).toString()).join('').trim())
  expect(environment).toEqual({ session: null, capability: false, endpoint: 'unix:' + main.controlPath })
  await main.core.removeTerminal({ runId: terminal.runId })
  await main.restart()
  expect(await main.sdk.runtimeInfo()).toEqual(before)
  expect((await oneCli('toolkit', 'inspect', 'owned-runtime')).result.snapshot.latestConfirmed).toEqual(execution)
  await record('runtime-owner-main-consumer', { nativeIdentity: before, originalExecution: execution, environment, restartPreserved: true, consumers: ['registered Main IPC', 'public toolkit RPC', 'actual CLI'] })
  const receipt = await main.close()
  expect(receipt).toMatchObject({ childExit: 'confirmed', namespace: 'removed' })
  const namespace = await lstat(main.directory).then(() => ({ exists: true, code: null }), error => ({ exists: false, code: error.code }))
  expect(namespace).toEqual({ exists: false, code: 'ENOENT' })
  await expect(main.sdk.runtimeInfo()).rejects.toThrow()
  } finally {
    // Exact SDK producer cleanup remains available if the tested fixture close
    // consumer is mutated. This test creates no replacement namespace.
    await main.close().catch(error => record('runtime-owner-corrective-close', { directory: main.directory, error: String(error) }))
    await main.activation.shutdown(); await main.activation.dispose()
    await rm(main.directory, { recursive: true, force: true })
  }
}, 20000)
