import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { canonicalInstallPath } from './package-identity.mjs'
import { stopProbeProcesses } from './probe-process.mjs'

const exec = promisify(execFile), repository = resolve(import.meta.dirname, '../../..')
const root = await mkdtemp('/tmp/amx-main-qualification-')
const require = createRequire(join(repository, 'packages/core/package.json'))
const { build } = await import(require.resolve('esbuild'))
const coreRelative = 'Contents/Resources/app/node_modules/@agentmux/core'
const previous = join(canonicalInstallPath(homedir()), coreRelative, 'vendor/ctxmux/darwin-arm64')
const sourceRepository = resolve(homedir(), 'proj/priv/bagaking/ctxmux')
const candidate = join(repository, 'packages/core/vendor/ctxmux/darwin-arm64')
const envBefore = { runtime: process.env.AGENTMUX_RUNTIME_DIRECTORY, state: process.env.AGENTMUX_STATE_DIRECTORY }
const runtime = join(root, 'runtime'), state = join(root, 'state')
process.env.AGENTMUX_RUNTIME_DIRECTORY = runtime
process.env.AGENTMUX_STATE_DIRECTORY = state
const receipt = { schema: 'agentmux.ctxmux-main-qualification.v1', passed: false, userRuntimeTouched: false }
let child, client, run, failure
async function wait(read, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(done => setTimeout(done, 25))
  }
  throw new Error(`Private qualification timed out: ${label}`)
}
async function app(path, artifact) {
  const core = join(path, coreRelative)
  await mkdir(join(core, 'dist'), { recursive: true })
  await cp(artifact, join(core, 'vendor/ctxmux/darwin-arm64'), { recursive: true })
  await writeFile(join(core, 'package.json'), '{"type":"module"}\n')
  await cp(join(repository, 'packages/core/dist/runtime-paths.js'), join(core, 'dist/runtime-paths.js'))
  return core
}
try {
  // Bundle the actual installer helper, including its normal TypeScript observation contracts.
  const helper = join(root, 'package-runtime-upgrade.mjs')
  await build({ entryPoints: [join(repository, 'apps/desktop/scripts/package-runtime-upgrade.mjs')],
    outfile: helper, bundle: true, platform: 'node', format: 'esm', target: 'node24' })
  const { prepareRuntimeUpgrade } = await import(pathToFileURL(helper).href)
  const current = join(root, 'current.app'), next = join(root, 'candidate.app')
  const oldCore = await app(current, previous)
  await app(next, candidate)
  const oldVendor = join(oldCore, 'vendor/ctxmux/darwin-arm64')
  const oldManifest = JSON.parse(await readFile(join(oldVendor, 'manifest.json')))
  const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json')))
  const source = (await exec('git', ['-C', sourceRepository, 'rev-parse', 'refs/heads/main'])).stdout.trim()
  assert.equal(manifest.source.commit, source)
  assert.ok(manifest.product.protocol > oldManifest.product.protocol)
  const sdkRoot = join(root, 'old-sdk')
  await mkdir(sdkRoot)
  await exec('/usr/bin/tar', ['-xzf', join(oldVendor, oldManifest.sdk.archive.path), '-C', sdkRoot])
  const sdk = await import(pathToFileURL(join(sdkRoot, 'package/dist/index.js')).href)
  await mkdir(runtime)
  await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
  const socket = join(runtime, 'ctxmux.sock')
  child = spawn(join(oldVendor, 'bin/ctxmuxd'), ['--socket', socket, '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-16384) })
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Private readiness failed: ${diagnostics}`)), 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Private daemon exited ${code}: ${diagnostics}`)) })
    child.stdio[3].once('data', () => { clearTimeout(timer); done() })
  })
  client = new sdk.CtxmuxClient({ socketPath: socket })
  const before = await client.runtimeInfo()
  run = await client.start(sdk.defineRun('/bin/sh', { args: ['-c', "printf 'READY\\n'; while IFS= read -r line; do printf 'ACK:%s\\n' \"$line\"; done", join(root, 'shell-owner')],
    cwd: root, env: {}, initialSize: { cols: 80, rows: 24 } }))
  const ready = await wait(async () => { const row = await client.status(run.id); return row.latest_output_bytes > 0 ? row : null }, 'original nonempty output')
  await assert.rejects(prepareRuntimeUpgrade(current, next), /Runtime handoff is unsupported:/)
  const after = await client.runtimeInfo(), kept = await client.status(run.id)
  assert.equal(after.runtimeId, before.runtimeId)
  assert.equal(after.daemonInstanceId, before.daemonInstanceId)
  assert.equal(kept.pid, ready.pid)
  assert.equal(kept.state.type, 'running')
  const marker = 'kept-after-refused-upgrade\n'
  const accepted = await client.input(run.id, marker)
  assert.equal(accepted.run.applied_input_bytes, Buffer.byteLength(marker))
  const output = await wait(async () => {
    const attachment = await client.attach(run.id, 0)
    try {
      const bytes = Buffer.concat(attachment.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data)))
      return bytes.includes(Buffer.from('ACK:kept-after-refused-upgrade')) ? bytes : null
    } finally { attachment.close() }
  }, 'original input and ordered output after refusal')
  assert.ok(output.length > 0)
  receipt.candidate = { source: manifest.source.commit, protocol: manifest.product.protocol }
  receipt.original = { protocol: sdk.PROTOCOL_VERSION, daemonPid: child.pid, runId: run.id, childPid: run.pid,
    runtimeId: before.runtimeId, daemonInstanceId: before.daemonInstanceId, inputBytes: accepted.run.applied_input_bytes,
    outputBytes: output.length, outputBase64: output.toString('base64') }
  receipt.refusedBeforeCutover = true
  receipt.passed = true
} catch (error) { failure = error; receipt.error = error.stack ?? error.message }
finally {
  if (client && run) await client.prepareStop(run.id).then(operation => client.stop(operation))
    .catch(error => { failure ??= error; receipt.error ??= error.stack ?? error.message })
  let cleaned = false
  try {
    if (child?.pid) await stopProbeProcesses(child.pid, root)
    cleaned = true
    await rm(root, { recursive: true, force: true })
  } catch (error) { failure ??= error; receipt.error ??= error.stack ?? error.message }
  for (const [name, value] of [['AGENTMUX_RUNTIME_DIRECTORY', envBefore.runtime], ['AGENTMUX_STATE_DIRECTORY', envBefore.state]]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  receipt.cleanup = { privateRootRemoved: cleaned, daemonStopped: !child || child.exitCode !== null || child.signalCode !== null }
  receipt.passed &&= !failure
  const output = join(repository, '.tmp/ctxmux-main-qualification-last.json')
  await mkdir(join(repository, '.tmp'), { recursive: true })
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: output, error: receipt.error }) + '\n')
}
if (failure) throw failure
