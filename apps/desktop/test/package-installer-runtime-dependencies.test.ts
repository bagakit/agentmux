import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createPrivateRuntimeScope } from '../scripts/package-runtime-upgrade.mjs'
import { observeApplicationProcesses } from '../scripts/package-process-scope.mjs'

const exec = promisify(execFile), repository = resolve(import.meta.dirname, '../../..')
const observation = join(repository, 'apps/desktop/scripts/package-native-observation.mjs')
const core = join(repository, 'packages/core')
const electron = await realpath(process.env.PROCESS_IDENTITY_ELECTRON ?? join(repository, 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
const wait = async (read: () => Promise<any>, accept: (value: any) => boolean) => {
  const end = Date.now() + 10_000
  do { const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 20)) } while (Date.now() < end)
  throw Error('Private installer observation did not settle.')
}

it('uses inherited signed image FD and exact architecture, releases all CF owners, and rejects unavailable slices', async () => {
  const image = await open(join(core, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd'), 'r')
  const read = async (architecture: string) => {
    const child = spawn(process.execPath, [observation, '--static-code', architecture],
      { stdio: ['ignore', 'pipe', 'pipe', image.fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let stdout = '', stderr = ''
    child.stdout!.on('data', bytes => { stdout += bytes })
    child.stderr!.on('data', bytes => { stderr += bytes })
    const exit = await once(child, 'close')
    expect(exit).toEqual([0, null]); expect(stderr).toBe('')
    return JSON.parse(stdout)
  }
  try {
    const value = await read(process.arch === 'arm64' ? 'arm64' : 'x86_64')
    expect(value.primary).toBeNull()
    expect(value.result).toMatchObject({ kind: 'security-static-code', dictionaryKey: 'kSecCodeInfoUnique', byteLength: 20, valid: true })
    expect(value.result.cdHash).toMatch(/^[a-f0-9]{40}$/)
    expect(value.cleanup).toEqual(['signing-information', 'static-code', 'architecture-attributes', 'architecture-string', 'file-url']
      .map(owner => ({ owner, released: true })))
    const wrong = await read(process.arch === 'arm64' ? 'x86_64' : 'arm64')
    expect(wrong.result).toBeNull(); expect(wrong.primary).toBeTruthy()
    expect(wrong.cleanup.every((entry: any) => entry.released)).toBe(true)
  } finally { await image.close() }
})

it('the original GUI consumer distinguishes a real GUI, its Node child, and an independent Node with usable IO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-installer-gui-'))
  const guiFile = join(root, 'main.cjs'), workerFile = join(root, 'worker.cjs'), guiState = join(root, 'gui.json')
  const children: ChildProcess[] = []
  try {
    await writeFile(workerFile, `process.stdout.write('ready\\n');process.stdin.on('data',bytes=>process.stdout.write('ACK:'+bytes));process.stdin.on('end',()=>process.exit(0));`)
    await writeFile(guiFile, `const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),cp=require('node:child_process');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});app.whenReady().then(()=>{const worker=cp.spawn(process.execPath,[${JSON.stringify(workerFile)}],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','ignore','ignore']});new BrowserWindow({show:false});fs.writeFileSync(${JSON.stringify(guiState)},JSON.stringify({pid:process.pid,worker:worker.pid}));process.stdin.on('end',()=>{worker.stdin.end();app.quit()});process.stdin.resume()});`)
    const external = spawn(electron, [workerFile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PRIVATE_ENV_SENTINEL: 'must-never-leave-reader' }, stdio: 'pipe' })
    children.push(external)
    expect((await once(external.stdout!, 'data'))[0].toString()).toBe('ready\n')
    const guiEnvironment = { ...process.env }; delete guiEnvironment.ELECTRON_RUN_AS_NODE
    const gui = spawn(electron, [guiFile, 'ELECTRON_RUN_AS_NODE=1'], { env: guiEnvironment, stdio: 'pipe' })
    children.push(gui)
    const state = await wait(async () => JSON.parse(await readFile(guiState, 'utf8').catch(() => 'null')), value => value?.pid === gui.pid)
    const scope = await observeApplicationProcesses({ executable: electron, helperRoot: resolve(electron, '../../Frameworks') + '/' })
    expect(scope.nodeModes.find((row: any) => row.pid === gui.pid)).toMatchObject({ mode: 'gui', executable: electron })
    expect(scope.nodeModes.find((row: any) => row.pid === state.worker)).toMatchObject({ mode: 'node', executable: electron })
    expect(scope.nodeModes.find((row: any) => row.pid === external.pid)).toMatchObject({ mode: 'node', executable: electron })
    expect(scope.serving).toContain(gui.pid); expect(scope.serving).toContain(state.worker)
    expect(scope.externalNode).toContain(external.pid)
    expect(JSON.stringify(scope.nodeModes)).not.toContain('must-never-leave-reader')
    const missing = await observeApplicationProcesses({ executable: electron, helperRoot: resolve(electron, '../../Frameworks') + '/' }, scope.admissions, { modes: async () => [] })
    expect(missing.serving).toContain(external.pid)
    const reply = once(external.stdout!, 'data'); external.stdin!.write('still-healthy\n')
    expect((await reply)[0].toString()).toBe('ACK:still-healthy\n')
    gui.stdin!.end(); expect(await once(gui, 'close')).toEqual([0, null])
    const again = once(external.stdout!, 'data'); external.stdin!.write('after-GUI-quit\n')
    expect((await again)[0].toString()).toBe('ACK:after-GUI-quit\n')
  } finally {
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
      const close = once(child, 'close'); child.stdin!.end(); await close
    }
    await rm(root, { recursive: true, force: true })
  }
})

it('the original installer compares live kernel code to the signed artifact while preserving one original Runtime and Run', async () => {
  const scope = await createPrivateRuntimeScope(core)
  let daemon: ChildProcess | undefined, client: any, run: any
  try {
    const sdkRoot = join(scope.directory, 'sdk'); await mkdir(sdkRoot)
    await exec('/usr/bin/tar', ['-xzf', join(core, 'vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz'), '-C', sdkRoot])
    const sdk = await import(/* @vite-ignore */ pathToFileURL(join(sdkRoot, 'package/dist/index.js')).href)
    await mkdir(scope.stateDirectory, { recursive: true, mode: 0o700 })
    daemon = spawn(scope.daemonPath, ['--socket', scope.socketPath, '--state-dir', scope.stateDirectory, '--readiness-fd', '3'],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let stderr = ''
    daemon.stderr!.on('data', bytes => { stderr += bytes })
    await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw Error(stderr) })])
    client = new sdk.CtxmuxClient({ socketPath: scope.socketPath })
    const identity = await client.runtimeInfo()
    const worker = join(scope.directory, 'pty.cjs')
    await writeFile(worker, `process.stdin.setRawMode(true);process.stdout.write('PRIVATE-READY\\r\\n');process.stdin.on('data',bytes=>{if(bytes.toString()==='q')process.exit(0);process.stdout.write('PRIVATE-ACK:'+bytes.toString()+'\\r\\n')});`)
    run = await client.start(sdk.defineRun(process.execPath, { args: [worker], cwd: scope.directory,
      env: { ELECTRON_RUN_AS_NODE: '1' }, initialSize: { rows: 8, cols: 40 } }))
    await wait(() => client.status(run.id), value => value.latest_output_bytes > 0)
    const before = await client.status(run.id), owner = await scope.observeOwner()
    expect(owner.pid).toBe(daemon.pid)
    expect(owner.imageIdentity).toMatchObject({ kind: 'kernel-code-directory', cdHash: expect.stringMatching(/^[a-f0-9]{40}$/) })
    const independent = JSON.parse((await exec(process.execPath, [observation, '--kernel-code', String(daemon.pid)],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })).stdout)
    expect(independent.cdHash).toBe(owner.imageIdentity.cdHash)
    expect(`${independent.startSeconds}:${independent.startMicroseconds}`).toBe(owner.birth)
    await client.input(run.id, 'x')
    await wait(() => client.status(run.id), value => value.latest_output_bytes > before.latest_output_bytes)
    const attachment = await client.attach(run.id, 0)
    const replay = Buffer.concat(attachment.snapshot.replay.chunks.map((chunk: any) => Buffer.from(chunk.data)))
    attachment.close()
    expect(replay.toString()).toContain('PRIVATE-ACK:x')
    expect((await client.status(run.id)).pid).toBe(run.pid)
    expect(await client.runtimeInfo()).toEqual(identity)
    expect((await scope.observeOwner()).birth).toBe(owner.birth)
    if (process.env.INSTALLER_NATIVE_PRODUCT_PROOF) await writeFile(process.env.INSTALLER_NATIVE_PRODUCT_PROOF,
      JSON.stringify({ runtime: identity, owner, runId: run.id, childPid: run.pid,
        replaySha256: createHash('sha256').update(replay).digest('hex'), replayBytes: replay.length, originalInputAck: true }))
  } finally {
    if (run && client) {
      const before = await client.status(run.id)
      // Even a failed observation cannot revoke an already-running writer.
      await client.input(run.id, 'z')
      await wait(() => client.status(run.id), value => value.latest_output_bytes > before.latest_output_bytes)
      expect((await client.status(run.id)).pid).toBe(run.pid)
      await client.input(run.id, 'q')
      await wait(() => client.status(run.id), value => value.state.type === 'exited')
    }
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, 'close'); daemon.kill('SIGTERM'); await closed
    }
    await rm(scope.directory, { recursive: true, force: true })
  }
})
