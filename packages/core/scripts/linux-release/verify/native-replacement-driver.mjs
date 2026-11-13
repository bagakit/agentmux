// Drives the App's own RemoteCoreUpgradeManager through a reviewed Native replacement against
// a real older release running in this container. It starts real Native Runs through the old
// Native's own SDK, checks, confirms, upgrades and then reads the result back.
//   node native-replacement-driver.mjs STATE RUNTIME OLD_DIGEST CANDIDATE_RELEASE_DIR
// Rosetta shim (test harness only): under Docker Desktop's Rosetta, /proc/<pid>/exe is the
// emulator and Node's cmdline gains "--no-opt -r /proc/.reset"; only those facts are mapped back.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [state, runtime, oldDigest, candidateRelease] = process.argv.slice(2)
const fail = message => { console.log(`FAIL: ${message}`); process.exit(1) }
const step = message => console.log(`== ${message}`)
const oldRoot = join(state, 'core-releases', oldDigest)

// The candidate release is installed exactly as install.sh stages it, beside the old one.
const staged = join(await mkdtemp('/tmp/candidate-'), 'core')
await mkdir(staged, { recursive: true })
execFileSync('tar', ['-xzf', join(candidateRelease, 'core', 'core.tar.gz'), '-C', staged])
const { RemoteCoreUpgradeManager, LocalExecutionHost, createPortableCoreArtifact } = await import(pathToFileURL(join(staged, 'dist/index.js')).href)

// The old Native's own SDK, from the old release's own artifact.
const sdkScratch = await mkdtemp('/tmp/old-sdk-')
execFileSync('tar', ['-xzf', join(oldRoot, 'vendor/ctxmux/linux-x64/ctxmux-sdk-0.0.0.tgz'), '-C', sdkScratch])
const { CtxmuxClient } = await import(pathToFileURL(join(sdkScratch, 'package/dist/index.js')).href)
const nativeSocket = join(runtime, 'ctxmux.sock')
const oldNative = new CtxmuxClient({ socketPath: nativeSocket })
const hello = await oldNative.runtimeInfo()
if (hello.protocolGeneration >= 25) fail(`expected an older Native, found protocol ${hello.protocolGeneration}`)
step(`old Native protocol ${hello.protocolGeneration}, runtime ${hello.runtimeId.slice(0, 8)}`)

step('start one running and one finished Native Run')
const pinned = new CtxmuxClient({ socketPath: nativeSocket, expectedRuntimeIdentity: hello })
const spec = (program, args) => ({ program, args, cwd: process.env.HOME, env: {}, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] })
const running = await pinned.start(spec('/bin/sh', ['-c', 'echo running-output; exec sleep 600']))
const finished = await pinned.start(spec('/bin/sh', ['-c', 'echo finished-output']))
for (let attempt = 0; attempt < 50; attempt++) {
  const [a, b] = [await pinned.status(running.id), await pinned.status(finished.id)]
  if (a.durable_output_bytes > 0 && b.state.type === 'exited' && b.durable_output_bytes > 0) break
  await new Promise(resolve => setTimeout(resolve, 200))
}
const before = { running: await pinned.status(running.id), finished: await pinned.status(finished.id) }
if (before.running.state.type !== 'running' || before.finished.state.type !== 'exited') fail('the Runs did not reach their starting states')

const socket = join(runtime, 'control.sock')
// A current client does not read an older owner protocol; the saved Host names the durable
// Runtime ID the old Core recorded, which the maintenance check verifies independently.
const owner = JSON.parse(await readFile(join(state, 'semantic-runtime.json'), 'utf8'))

const shim = String.raw`
def _argv(base):
 parts=_raw_cmdline(base)
 if parts[1:4]==['--no-opt','-r','/proc/.reset']: parts=[parts[0]]+parts[4:]
 return parts
def _exe(base): return os.path.realpath(_argv(base)[0])
`
const translate = program => {
  let text = program
  for (const base of ['worker_base', 'base', 'native_base']) {
    text = text.replaceAll(`open(${base}+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))`, `_argv(${base})`)
      .replaceAll(`os.readlink(${base}+'/exe')`, `_exe(${base})`).replaceAll(`sha(${base}+'/exe')`, `sha(_exe(${base}))`)
  }
  text = text.replace("open(base+'/environ','rb').read().split(bytes([0]))", "[item for item in open(base+'/environ','rb').read().split(bytes([0])) if not item.startswith(b'UV_USE_IO_URING=')]")
  return text.replace('import json,os,sys,hashlib,platform,stat\n', 'import json,os,sys,hashlib,platform,stat\n' +
    "def _raw_cmdline(base): return open(base+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))\n" + shim)
}
const translateNode = program => program
  .replaceAll("fs.readFileSync(base+'/exe')", "fs.readFileSync(fs.realpathSync(fs.readFileSync(base+'/cmdline','utf8').split(String.fromCharCode(0))[0]))")
  .replaceAll("hash(fs.readFileSync(base+'/exe'))", "hash(fs.readFileSync(fs.realpathSync(fs.readFileSync(base+'/cmdline','utf8').split(String.fromCharCode(0))[0])))")
const local = new LocalExecutionHost({ id: 'container' })
const executionHost = () => ({ id: 'container', kind: 'ssh', label: 'container', dispose: async () => {},
  run: (command, args, options) => local.run(command, command === '/usr/bin/python3' && args[0] === '-c' ? ['-c', translate(args[1])]
    : args[0] === '-e' ? ['-e', translateNode(args[1])] : args, options) })
const host = { id: 'container', kind: 'ssh', label: 'container', hostname: 'container.invalid',
  remoteCommand: join(oldRoot, 'launcher/amux'), remoteSocketPath: socket, runtimeId: owner.runtimeId }
const artifact = await createPortableCoreArtifact(await mkdtemp('/tmp/candidate-artifact-'), staged)
const manager = new RemoteCoreUpgradeManager({ stateDirectory: join(process.env.HOME, '.client-upgrades'), executionHost, artifact: async () => artifact })

if (process.env.FAIL_COPY === '1') {
  step('a copy that cannot be written brings the original Core back on the original Native')
  // An existing directory at the copy target makes the copy fail after the stop.
  const blocked = join(state, 'core-releases', 'container-copy-fails.native-state')
  await mkdir(join(blocked, 'occupied'), { recursive: true })
  const check = await manager.check(host)
  if (check.reason !== 'native-replacement') fail('the check did not offer a Native replacement')
  const receipt = await manager.upgrade(host, check.expected, 'container-copy-fails')
  console.log(JSON.stringify({ status: receipt.status, stage: receipt.stage, detail: receipt.detail }))
  if (receipt.status !== 'failed' || !receipt.detail.includes('原 Core 已用原发行恢复服务')) fail('the original Core was not restored')
  const restored = await new CtxmuxClient({ socketPath: nativeSocket }).runtimeInfo()
  if (restored.protocolGeneration !== hello.protocolGeneration || restored.runtimeId !== hello.runtimeId) fail('the original Native was not restored')
  // The original release serves again, its Native still the original generation, and the same
  // Native replacement is offered again.
  const back = await manager.check(host)
  if (back.current.state !== 'available' || back.current.deploymentDigest !== check.current.deploymentDigest ||
      back.current.native.protocolVersion !== hello.protocolGeneration || back.reason !== 'native-replacement') fail('the original Core is not serving')
  console.log('PASS')
  process.exit(0)
}

step('check reviews a Native replacement')
const check = await manager.check(host)
console.log(JSON.stringify({ reason: check.reason, eligible: check.eligible, detail: check.detail, nativeReplacement: check.nativeReplacement }, null, 1))
if (check.reason !== 'native-replacement' || !check.eligible) fail('the check did not offer a Native replacement')
const ending = check.nativeReplacement.ending.map(run => run.runId)
if (!ending.includes(running.id) || ending.includes(finished.id)) fail('the review does not list exactly the running Run')

step('upgrade with the reviewed admission')
const receipt = await manager.upgrade(host, check.expected, 'container-replacement')
console.log(JSON.stringify({ status: receipt.status, stage: receipt.stage, detail: receipt.detail, nativeReplacement: receipt.nativeReplacement }, null, 1))
if (receipt.status !== 'completed') fail('the replacement did not complete')
if (!receipt.nativeReplacement.endedRunIds.includes(running.id)) fail('the receipt does not name the ended Run')

step('the new Native keeps the durable Runtime, the Runs and their history')
// The old SDK speaks only the old protocol; read the new Native through the candidate's own SDK.
const newSdk = await mkdtemp('/tmp/new-sdk-')
execFileSync('tar', ['-xzf', join(staged, 'vendor/ctxmux/linux-x64/ctxmux-sdk-0.0.0.tgz'), '-C', newSdk])
const { CtxmuxClient: NewClient } = await import(pathToFileURL(join(newSdk, 'package/dist/index.js')).href)
const next = await new NewClient({ socketPath: nativeSocket }).runtimeInfo()
if (next.runtimeId !== hello.runtimeId) fail('the Runtime ID changed')
if (next.daemonInstanceId === hello.daemonInstanceId) fail('the Native instance did not change')
if (next.protocolGeneration <= hello.protocolGeneration) fail(`the Native protocol is still ${next.protocolGeneration}`)
console.log(JSON.stringify({ before: { protocol: hello.protocolGeneration, instance: hello.daemonInstanceId.slice(0, 8) }, after: { protocol: next.protocolGeneration, instance: next.daemonInstanceId.slice(0, 8) }, runtimeKept: next.runtimeId === hello.runtimeId }))
const reader = new NewClient({ socketPath: nativeSocket, expectedRuntimeIdentity: next })
const ended = await reader.status(running.id), kept = await reader.status(finished.id)
console.log(JSON.stringify({ ended: { state: ended.state, pid: ended.pid, latest: ended.latest_output_bytes }, kept: { state: kept.state, latest: kept.latest_output_bytes } }))
if (ended.state.type !== 'interrupted' || ended.pid !== null) fail('the running Run was not ended by the replacement')
if (ended.latest_output_bytes < before.running.durable_output_bytes) fail('the running Run lost durable history')
if (kept.state.type !== 'exited' || kept.latest_output_bytes < before.finished.durable_output_bytes) fail('the finished Run changed')

step('the state copy and the current release')
const copy = receipt.nativeReplacement.stateCopy
const copied = await readdir(copy)
if (!copied.includes('state.sqlite3')) fail('the state copy has no database')
const pointer = execFileSync('readlink', [join(state, 'core-releases', 'current')], { encoding: 'utf8' }).trim()
if (pointer !== check.expected.candidateDigest) fail(`current names ${pointer}`)
step('inspecting the original operation does not repeat it')
const inspected = await manager.inspect({ ...host, remoteCommand: receipt.remoteCommand }, 'container-replacement')
if (inspected?.status !== 'completed') fail('inspection did not read the completed operation')
console.log('PASS')
process.exit(0)
