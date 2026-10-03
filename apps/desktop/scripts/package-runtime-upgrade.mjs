import { parseDesktopClientObservation } from '../src/shared/client-observation.ts'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { probeSocketLiveness } from '../../../packages/core/src/socket-liveness.ts'

const exec = promisify(execFile)
const script = fileURLToPath(import.meta.url)
const coreRelative = 'Contents/Resources/app/node_modules/@agentmux/core'
const capability = 'services.planned_exec_upgrade_continuity'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (condition, message) => { if (!condition) throw new Error(message) }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function artifact(app) {
  const core = join(app, coreRelative)
  const root = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`)
  const bytes = await readFile(join(root, 'manifest.json'))
  const manifest = JSON.parse(bytes)
  fail(manifest.schema === 'ctxmux.local-artifacts.v1', 'Unsupported Runtime artifact manifest.')
  const daemon = manifest.binaries.find((entry) => entry.name === 'ctxmuxd')
  fail(daemon && manifest.support.platform === process.platform && manifest.support.architecture === process.arch,
    'Runtime artifact does not match this host.')
  const daemonPath = join(root, daemon.path)
  fail(hash(await readFile(daemonPath)) === daemon.sha256, 'Runtime executable digest does not match its artifact.')
  const archivePath = join(root, manifest.sdk.archive.path)
  fail(hash(await readFile(archivePath)) === manifest.sdk.archive.sha256, 'Runtime SDK archive digest does not match its artifact.')
  // Read the address from the actual App, not the packaging checkout's artifact.
  const paths = await import(pathToFileURL(join(core, 'dist/runtime-paths.js')).href)
  return { root, manifest, manifestSha256: hash(bytes), daemonPath, daemonSha256: daemon.sha256, daemonVersion: daemon.version,
    daemonCdHash: await artifactCodeIdentity(daemonPath, daemon.sha256), archivePath, corePath: join(core, 'dist/index.js'), socketPath: paths.defaultCtxmuxSocketPath(), stateDirectory: paths.defaultCtxmuxStateDirectory() }
}

// The full artifact digest binds its static CodeDirectory. The kernel retains
// this code identity after unlink; it is not a hash of a missing mapped file.
async function artifactCodeIdentity(path, expectedSHA) {
  const before = await lstat(path, { bigint: true })
  const result = await exec('/usr/bin/codesign', ['--display', '--verbose=4', '--arch',
    process.arch === 'x64' ? 'x86_64' : process.arch, path], { timeout: 5_000, maxBuffer: 16384 })
  const cdHash = /^CDHash=([a-f0-9]{40})$/m.exec(result.stderr)?.[1]
  const image = await open(path, 'r')
  try {
    const metadata = await image.stat({ bigint: true })
    const after = await lstat(path, { bigint: true })
    fail(before.isFile() && metadata.dev === before.dev && metadata.ino === before.ino &&
      after.dev === before.dev && after.ino === before.ino && hash(await image.readFile()) === expectedSHA && cdHash,
      'The Runtime artifact changed while its code identity was being read.')
  } finally { await image.close() }
  return cdHash
}

// Reuse the installer's bounded Python/libSystem bridge. csops STATUS and
// CDHASH are read-only kernel queries; no process memory, argv or env leaves.
const CODE_IDENTITY_SOURCE = String.raw`
import ctypes,json,sys
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
lib.csops.argtypes=[ctypes.c_int,ctypes.c_uint,ctypes.c_void_p,ctypes.c_size_t]
lib.csops.restype=ctypes.c_int
pid=int(sys.argv[1]); status=ctypes.c_uint32(); digest=ctypes.create_string_buffer(20)
def read(op,value):
 if lib.csops(pid,op,ctypes.byref(value),ctypes.sizeof(value))!=0:raise OSError(ctypes.get_errno(),'kernel code identity unavailable')
read(0,status)
if not status.value&1:raise RuntimeError('Runtime code signature is invalid')
read(5,digest)
read(0,status)
if not status.value&1:raise RuntimeError('Runtime code signature became invalid')
print(json.dumps({'cdHash':digest.raw.hex(),'valid':True}))
`
async function kernelCodeIdentity(pid, selected) {
  const result = await exec('/usr/bin/python3', ['-c', CODE_IDENTITY_SOURCE, String(pid)],
    { timeout: 5_000, maxBuffer: 4096 })
  const identity = JSON.parse(result.stdout)
  fail(identity.valid === true && /^[a-f0-9]{40}$/.test(identity.cdHash) && identity.cdHash === selected.daemonCdHash,
    'The socket owner executing code is not the selected Runtime artifact.')
  return { kind: 'kernel-code-directory', cdHash: identity.cdHash, artifactSha256: selected.daemonSha256 }
}

async function daemonDeclaration(selected) {
  const image = await lstat(selected.daemonPath, { bigint: true })
  fail(image.isFile(), 'The selected Runtime candidate is not a regular executable file.')
  const response = await exec(selected.daemonPath, ['--version'], { timeout: 10_000, maxBuffer: 4096 })
  const declared = /^ctxmuxd (\S+) \(protocol (\d+), handoff ([^\s(),]+)\)\s*$/.exec(response.stdout)
  fail(declared && declared[1] === selected.daemonVersion && Number(declared[2]) === selected.manifest.product.protocol,
    'The selected Runtime candidate did not declare its selected version, protocol and handoff.')
  const opened = await open(selected.daemonPath, 'r')
  try {
    const metadata = await opened.stat({ bigint: true })
    fail(metadata.isFile() && metadata.dev === image.dev && metadata.ino === image.ino &&
      hash(await opened.readFile()) === selected.daemonSha256,
    'The selected Runtime candidate changed while its version response was being checked.')
    const final = await lstat(selected.daemonPath, { bigint: true })
    fail(final.isFile() && final.dev === image.dev && final.ino === image.ino,
      'The selected Runtime candidate changed while its version response was being checked.')
  } finally { await opened.close() }
  return { declaration: { version: declared[1], protocol: Number(declared[2]), handoff: declared[3] }, image }
}

async function extractSdk(artifact, directory) {
  await mkdir(directory)
  await exec('/usr/bin/tar', ['-xzf', artifact.archivePath, '-C', directory], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  return join(directory, 'package/dist/index.js')
}

// Match the public SDK's disposable foreground-observation wait. This is a
// per-request read budget, not a Run lifetime or a shared inventory deadline.
const OBSERVATION_REQUEST_WAIT_MS = 30_000
async function inspectRead(stage, socketPath, target, read) {
  const started = Date.now()
  let timer
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The read response did not arrive within this request wait.')),
        OBSERVATION_REQUEST_WAIT_MS)
    })])
  } catch (cause) {
    const detail = { stage, socketPath, ...target, elapsedMs: Date.now() - started,
      requestWaitMs: OBSERVATION_REQUEST_WAIT_MS }
    throw Object.assign(new Error(`Runtime inspection is unconfirmed: ${JSON.stringify(detail)}. ${cause.message}. ` +
      'Existing processes remain under their original owners; retry this observation.', { cause }),
      { code: 'RUNTIME_INSPECTION_UNCONFIRMED', detail })
  } finally { clearTimeout(timer) }
}

async function inspect(sdk, socket, core, runIds) {
  const { stdout } = await exec(process.execPath, [script, '--inspect', sdk, socket,
    ...(core ? [core] : []), ...(runIds ? [JSON.stringify(runIds)] : [])], {
    maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  return JSON.parse(stdout)
}

// Only metadata leaves this private helper. A failed per-request observation
// exits this process and releases its own wires; it cannot signal any Run.
async function inspectPublicRuntime(sdkPath, socketPath, corePath, runIds) {
  const sdk = await import(pathToFileURL(sdkPath).href)
  const client = new sdk.CtxmuxClient({ socketPath })
  const runtime = await inspectRead('runtimeInfo', socketPath, {}, () => client.runtimeInfo())
  const identity = { runtimeId: runtime.runtimeId, daemonInstanceId: runtime.daemonInstanceId }
  if (corePath) {
    await inspectRead('compatibility', socketPath, identity, async () => {
      const { assertAgentMuxRuntimeCompatibility } = await import(pathToFileURL(corePath).href)
      assertAgentMuxRuntimeCompatibility(runtime)
    })
  }
  // Each status request is fenced to the identity established above.
  const scopedClient = new sdk.CtxmuxClient({ socketPath, expectedRuntimeIdentity: runtime })
  const running = []
  const readRun = async (id, allowMissing) => {
    const run = await inspectRead('status', socketPath, { ...identity, runId: id }, async () => {
      try { return await scopedClient.status(id) }
      catch (error) {
        if (allowMissing && error instanceof sdk.CtxmuxProtocolError && error.code === 'run_not_found') return null
        throw error
      }
    })
    if (run === null) return
    await inspectRead('status identity', socketPath, { ...identity, runId: id }, () => {
      fail(run.id === id, 'The Runtime returned another Run instead of the requested identity.')
    })
    if (run.state.type === 'running') running.push({ id: run.id, pid: run.pid, backend: run.backend,
      acceptedInputBytes: run.applied_input_bytes, outputBytes: run.latest_output_bytes,
      currentSize: run.current_size })
  }
  if (runIds !== undefined) {
    for (const id of new Set(runIds)) await readRun(id, true)
  } else {
    // Native exec preflight has no outgoing Region scope and must retain its
    // whole running inventory. Ordinary UI installation never enters this path.
    let cursor = null
    do {
      const page = await inspectRead('listPage', socketPath, { ...identity, cursor }, () => scopedClient.listPage(cursor, 128))
      for (const summary of page.runs) if (summary.state.type === 'running') await readRun(summary.id, false)
      await inspectRead('inventory cursor', socketPath, { ...identity, cursor }, () => {
        fail(page.nextCursor === null || page.nextCursor !== cursor, 'Runtime inventory cursor did not advance.')
      })
      cursor = page.nextCursor
    } while (cursor !== null)
  }
  process.stdout.write(JSON.stringify({ protocol: sdk.PROTOCOL_VERSION, runtime, running }))
}

function socketOwners(output, socket) {
  const owners = []
  let pid, uid, type
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); uid = undefined; type = undefined }
    else if (line.startsWith('u')) uid = Number(line.slice(1))
    else if (line.startsWith('f')) type = undefined
    else if (line.startsWith('t')) type = line.slice(1)
    else if (line === `n${socket}` && type === 'unix') owners.push({ pid, uid })
  }
  return [...new Map(owners.map((entry) => [entry.pid, entry])).values()]
}

function processFiles(output, expectedPid) {
  const files = []
  let pid, file
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); file = undefined }
    else if (line.startsWith('f')) { file = { pid, fd: line.slice(1) }; files.push(file) }
    else if (file && ['t', 'D', 'i', 'n', 'l'].includes(line[0])) file[line[0]] = line.slice(1)
  }
  return files.filter(entry => entry.pid === expectedPid)
}

function mappedIdentity(file) {
  fail(file.t === 'REG' && /^0x[0-9a-f]+$/i.test(file.D ?? '') && /^\d+$/.test(file.i ?? '') && file.n?.startsWith('/'),
    'The Runtime file has no regular OS device/inode identity.')
  return { device: BigInt(file.D).toString(), inode: BigInt(file.i).toString() }
}

async function fileIdentity(file) {
  mappedIdentity(file)
  const metadata = await lstat(file.n, { bigint: true })
  fail(metadata.isFile() && metadata.dev === BigInt(file.D) && metadata.ino === BigInt(file.i),
    'The Runtime OS mapping and its path do not identify the same regular file.')
  return { device: metadata.dev.toString(), inode: metadata.ino.toString() }
}

async function processOwner(socket, selected) {
  // lsof's file operands must come last. Field output avoids truncating names or
  // interpreting a socket name embedded in some other process's argv.
  const sockets = await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-U', '-Fpuftn', socket],
    { timeout: 5_000, maxBuffer: 1024 * 1024 })
  const owners = socketOwners(sockets.stdout, socket)
  fail(owners.length === 1 && Number.isSafeInteger(owners[0].pid) && owners[0].pid > 0 && owners[0].uid === process.getuid(),
    'The selected Runtime socket has no unique process owned by this user.')
  const { pid, uid } = owners[0]
  const birth = (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,uid=,lstart='], { timeout: 5_000 })).stdout.trim()
  fail(new RegExp(`^${pid}\\s+${uid}\\s+\\S`).test(birth), 'The Runtime process birth identity is unavailable.')
  const mapped = await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-FpuftDinl'],
    { timeout: 5_000, maxBuffer: 1024 * 1024 })
  const files = processFiles(mapped.stdout, pid)
  const executables = files.filter(file => file.fd === 'txt' && basename(file.n ?? '') === 'ctxmuxd')
  fail(executables.length === 1, 'The Runtime process has no unique ctxmuxd executable mapping.')
  const executable = executables[0].n
  const executableIdentity = mappedIdentity(executables[0])
  const imageIdentity = await kernelCodeIdentity(pid, selected)
  const locks = files.filter(file => /^\d+[a-z]*$/i.test(file.fd) && basename(file.n ?? '') === 'state.lock')
  fail(locks.length === 1, 'The Runtime process has no unique state.lock descriptor.')
  const stateIdentity = await fileIdentity(locks[0])
  // An open FD alone does not prove an OS lock. The exact qualified Native's
  // StateLockGuard owns this descriptor for its persistent Runtime lifetime.
  const state = { directory: dirname(locks[0].n), path: locks[0].n, ...stateIdentity,
    fd: locks[0].fd, osLock: locks[0].l ?? null }
  // Planned exec intentionally keeps PID, birth and socket. Re-read the file
  // set too: those process facts alone cannot fence an exec during this read.
  const finalFiles = processFiles((await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-FpuftDinl'],
    { timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout, pid)
  const finalImages = finalFiles.filter(file => file.fd === 'txt' && basename(file.n ?? '') === 'ctxmuxd')
  const finalLocks = finalFiles.filter(file => /^\d+[a-z]*$/i.test(file.fd) && basename(file.n ?? '') === 'state.lock')
  fail(finalImages.length === 1 && finalLocks.length === 1 && finalImages[0].n === executable && finalLocks[0].n === state.path,
    'The Runtime files changed while its serving authority was being observed.')
  const finalImageIdentity = mappedIdentity(finalImages[0]), finalStateIdentity = await fileIdentity(finalLocks[0])
  const finalCodeIdentity = await kernelCodeIdentity(pid, selected)
  fail(finalCodeIdentity.cdHash === imageIdentity.cdHash, 'The Runtime executing code changed during owner observation.')
  fail(finalImageIdentity.device === executableIdentity.device && finalImageIdentity.inode === executableIdentity.inode &&
    finalStateIdentity.device === state.device && finalStateIdentity.inode === state.inode,
    'The Runtime file identities changed while its serving authority was being observed.')
  const finalBirth = (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,uid=,lstart='], { timeout: 5_000 })).stdout.trim()
  const finalSockets = await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-U', '-Fpuftn', socket],
    { timeout: 5_000, maxBuffer: 1024 * 1024 })
  const finalOwners = socketOwners(finalSockets.stdout, socket)
  fail(finalBirth === birth && finalOwners.length === 1 && finalOwners[0].pid === pid && finalOwners[0].uid === uid,
    'The Runtime process changed while its serving authority was being observed.')
  return { pid, uid, birth, executable, executableIdentity, imageIdentity, state }
}

function assertServingOwner(original, current) {
  fail(current.pid === original.pid && current.birth === original.birth && current.uid === original.uid,
    'The Runtime process identity changed during handoff.')
  fail(current.state.directory === original.state.directory && current.state.device === original.state.device &&
    current.state.inode === original.state.inode, 'The Runtime state authority changed during handoff.')
}

async function ownerReceiptDiagnostic(path, old, before, owner) {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 65536)
      return { status: 'unreadable', path, error: 'Owner receipt is not a bounded private regular file.' }
    const receipt = JSON.parse(await readFile(path, 'utf8'))
    const matches = metadata.isFile() && metadata.uid === process.getuid() && (metadata.mode & 0o777) === 0o600 &&
      receipt.schema === 'agentmux.ctxmux-owner.v1' && receipt.socketPath === old.socketPath &&
      receipt.stateDirectory === owner.state.directory && receipt.daemonSha256 === old.daemonSha256 &&
      receipt.manifestSha256 === old.manifestSha256 && receipt.runtimeId === before.runtime.runtimeId &&
      receipt.daemonInstanceId === before.runtime.daemonInstanceId && receipt.runtimeBuildId === before.runtime.buildId
    return { status: matches ? 'matching' : 'mismatch', path,
      recorded: { schema: receipt.schema, daemonSha256: receipt.daemonSha256, stateDirectory: receipt.stateDirectory,
        runtimeId: receipt.runtimeId, daemonInstanceId: receipt.daemonInstanceId } }
  } catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'unreadable', path, error: error.message } }
}

function sameRuntime(before, after) {
  return before.runtimeId === after.runtimeId && before.daemonInstanceId === after.daemonInstanceId &&
    before.runtimeIdPersistence === after.runtimeIdPersistence
}

async function assertRunsKept(plan, inspection, sdk) {
  fail(sameRuntime(plan.before.runtime, inspection.runtime), 'Runtime/daemon identity changed during installation.')
  // Status the exact original IDs, including Runs that naturally exited while the
  // GUI was closing. A natural exit is not an installation-induced interruption.
  const { stdout } = await exec(process.execPath, [script, '--status', sdk, plan.old.socketPath,
    JSON.stringify(plan.before.running.map((entry) => entry.id)), JSON.stringify(inspection.runtime)], {
    maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const statuses = JSON.parse(stdout)
  fail(statuses.length === plan.before.running.length, 'Original Run inventory is incomplete after handoff.')
  for (const original of plan.before.running) {
    const current = statuses.find((entry) => entry.id === original.id)
    fail(current && (current.state.type === 'exited' || (current.state.type === 'running' && current.pid === original.pid)),
      'An original Run was interrupted, lost or assigned another child during handoff.')
    fail(current.acceptedInputBytes >= original.acceptedInputBytes && current.outputBytes >= original.outputBytes,
      'Original Run byte cursors moved backwards during handoff.')
  }
  return statuses
}

/** Bind a serving socket to the installed artifact's actual mapped image and state lock. */
export async function observeInstalledRuntimeOwner(appPath) {
  const selected = await artifact(appPath)
  const owner = await processOwner(selected.socketPath, selected)
  return { ...owner, socketPath: selected.socketPath, stateDirectory: selected.stateDirectory, sourceCommit: selected.manifest.source.commit,
    sourceTree: selected.manifest.source.tree, manifestSha256: selected.manifestSha256 }
}

/** One bounded public RPC read; no Renderer injection or lifecycle action. */
export async function observeUiClient(appPath) {
  const { stdout } = await exec(process.execPath, [script, '--inspect-ui', join(appPath, coreRelative, 'dist/index.js')], {
    timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  return parseDesktopClientObservation(JSON.parse(stdout))
}

/** UI-only preflight: no owner receipt, mapped-image claim, signal or spawn authority. */
export async function prepareUiRuntime(currentApp, candidateApp, observation) {
  const candidate = await artifact(candidateApp)
  // A first cold installation selects its address from the actual candidate.
  // This does not claim that a previous GUI or Native image was loaded.
  const old = currentApp ? await artifact(currentApp) : candidate
  fail(old.socketPath === candidate.socketPath && old.stateDirectory === candidate.stateDirectory,
    'UI update changes the durable Runtime address. No application was changed.')
  const liveness = await probeSocketLiveness(old.socketPath)
  if (liveness === 'dead' && observation === null) return null
  fail(liveness === 'alive', 'The existing Runtime listener is unavailable or unknown; no UI was changed.')
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-install-sdk-'))
  try {
    const newSdk = await extractSdk(candidate, join(temporary, 'candidate'))
    const observed = observation === null ? null : parseDesktopClientObservation(observation)
    const ids = observed ? [...new Set(observed.workbench.tabs.flatMap(tab => tab.regions.flatMap(region =>
      (region.kind === 'agent' || region.kind === 'terminal') && region.control?.hostId === 'local' ? [region.control.run.runId] : [])))] : []
    // Durable history references remain in the full observation. Only current
    // Native running summaries in this exact workface are preservation pins.
    const before = await inspect(newSdk, old.socketPath, candidate.corePath, ids)
    if (observed) {
      const local = observed.main.runtimes.find(entry => entry.hostId === 'local')?.identity
      fail(local && local.instanceId === before.runtime.daemonInstanceId && local.buildIdentity === before.runtime.buildId &&
        local.protocolVersion === before.runtime.protocolGeneration, 'The GUI and selected listener do not report the same serving Runtime.')
    }
    // Cold observation has no outgoing Region -> Run baseline. The helper's
    // empty inventory must not be reported as proof that original Runs survived.

    return { old, candidate, newSdk, before, temporary, corePath: candidate.corePath }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

/** Re-read the exact original service and Runs without Native mutation. */
export async function confirmUiRuntime(plan) {
  const { stdout } = await exec(process.execPath, [script, '--identity', plan.newSdk, plan.old.socketPath], {
    maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const after = JSON.parse(stdout)
  const originalRuns = await assertRunsKept(plan, after, plan.newSdk)
  return { runtime: after.runtime, originalRuns }
}

/** Match this GUI observation to the already-confirmed exact listener and Run facts. */
export function assertUiRuntimeObservation(observation, confirmation, originalObservation) {
  const observed = parseDesktopClientObservation(observation)
  const local = observed.main.runtimes.find(entry => entry.hostId === 'local')?.identity
  const runtime = confirmation.runtime
  fail(local && local.instanceId === runtime.daemonInstanceId && local.buildIdentity === runtime.buildId &&
    local.protocolVersion === runtime.protocolGeneration, 'The activated GUI is not connected to the confirmed serving Runtime.')
  // No outgoing GUI means no original Region baseline. Native preservation is
  // independently confirmed above this caller; it cannot be inferred from UI.
  if (originalObservation === null) return
  const original = parseDesktopClientObservation(originalObservation)
  for (const tab of original.workbench.tabs) for (const region of tab.regions) {
    if ((region.kind !== 'agent' && region.kind !== 'terminal') || region.control?.hostId !== 'local') continue
    const run = confirmation.originalRuns.find(entry => entry.id === region.control.run.runId)
    if (!run) continue
    const current = observed.workbench.tabs.find(entry => entry.id === tab.id)?.regions.find(entry => entry.regionId === region.regionId)
    fail(current && current.kind === region.kind && current.control?.hostId === 'local' &&
      current.control.run.runId === run.id && current.processState === run.state.type,
    'The activated GUI has not observed the confirmed original Run state.')
  }
}

/** Preflight before closing the GUI. Never signals or starts a Runtime. */
export async function prepareRuntimeUpgrade(currentApp, candidateApp) {
  const old = await artifact(currentApp), candidate = await artifact(candidateApp)
  fail(old.socketPath === candidate.socketPath,
    'Runtime upgrade changes the host socket address. No application was changed.')
  const liveness = await probeSocketLiveness(old.socketPath)
  if (liveness === 'dead') return null
  fail(liveness === 'alive', 'Runtime listener liveness is unknown; no application was changed.')
  fail(old.stateDirectory === candidate.stateDirectory,
    'Runtime upgrade changes the durable host address. No application was changed.')
  const declarations = await Promise.allSettled([daemonDeclaration(old), daemonDeclaration(candidate)])
  const [outgoing, incoming] = declarations.map(result => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  fail(outgoing.declaration.handoff === incoming.declaration.handoff,
    `Runtime handoff is unsupported: ${outgoing.declaration.handoff} -> ${incoming.declaration.handoff}. ` +
    'The existing application, healthy Runs and durable state were kept. Review a cold restart before switching formats.')
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-install-sdk-'))
  try {
    const oldSdk = await extractSdk(old, join(temporary, 'old'))
    const newSdk = await extractSdk(candidate, join(temporary, 'candidate'))
    const before = await inspect(oldSdk, old.socketPath)
    fail(before.protocol === old.manifest.product.protocol && before.runtime.protocolGeneration === before.protocol &&
      before.runtime.runtimeIdPersistence === 'state_dir' && before.runtime.capabilities[capability] >= 1,
    'The existing Runtime does not declare persistent planned-exec continuity.')
    const owner = await processOwner(old.socketPath, old)
    const receiptPath = join(dirname(old.socketPath), 'owner.json')
    const ownerReceipt = await ownerReceiptDiagnostic(receiptPath, old, before, owner)
    return { old, candidate, oldSdk, newSdk, before, owner, ownerReceipt, receiptPath, temporary }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function writeUpgradedReceipt(plan, owner, runtime) {
  const temporary = join(dirname(plan.receiptPath), `.owner-install-${randomUUID()}.json`)
  const receipt = { schema: 'agentmux.ctxmux-owner.v1', sourceCommit: plan.candidate.manifest.source.commit,
    sourceTree: plan.candidate.manifest.source.tree, manifestSha256: plan.candidate.manifestSha256,
    daemonSha256: plan.candidate.daemonSha256, daemonPath: owner.executable, socketPath: plan.old.socketPath,
    stateDirectory: owner.state.directory, daemonInstanceId: runtime.daemonInstanceId,
    runtimeId: runtime.runtimeId, runtimeBuildId: runtime.buildId }
  try {
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, plan.receiptPath)
    await chmod(plan.receiptPath, 0o600)
  } finally { await rm(temporary, { force: true }) }
}

/** Call only after the candidate occupies the canonical App path, before GUI launch. */
export async function finishRuntimeUpgrade(plan, currentApp) {
  let sent = false, lastError, candidateVersion
  try {
    const owner = await processOwner(plan.old.socketPath, plan.old)
    assertServingOwner(plan.owner, owner)
    const before = await inspect(plan.oldSdk, plan.old.socketPath)
    await assertRunsKept(plan, before, plan.oldSdk)
    const current = await artifact(currentApp)
    fail(current.daemonSha256 === plan.candidate.daemonSha256 && current.manifestSha256 === plan.candidate.manifestSha256,
      'The canonical application is not the preflighted Runtime candidate.')
    const declared = await daemonDeclaration(current)
    const candidateImage = declared.image
    candidateVersion = declared.declaration
    const signalOwner = await processOwner(plan.old.socketPath, plan.old)
    assertServingOwner(plan.owner, signalOwner)
    process.kill(signalOwner.pid, 'SIGHUP')
    sent = true
    const deadline = Date.now() + 15_000
    do {
      try {
        const after = await inspect(plan.newSdk, plan.old.socketPath)
        fail(after.protocol === plan.candidate.manifest.product.protocol && after.runtime.protocolGeneration === after.protocol,
          'The Runtime did not adopt the candidate protocol.')
        const upgradedOwner = await processOwner(plan.old.socketPath, plan.candidate)
        assertServingOwner(plan.owner, upgradedOwner)
        fail(upgradedOwner.executableIdentity.device === candidateImage.dev.toString() &&
          upgradedOwner.executableIdentity.inode === candidateImage.ino.toString(),
          'The Runtime has not mapped the preflighted canonical candidate file.')
        const statuses = await assertRunsKept(plan, after, plan.newSdk)
        // Once the new protocol is confirmed it is unsafe to restore a client
        // for the old protocol, even if receipt writing or GUI launch fails.
        const confirmed = { status: 'upgraded', daemonPid: upgradedOwner.pid,
          runtimeId: after.runtime.runtimeId, daemonInstanceId: after.runtime.daemonInstanceId,
          protocol: after.protocol, originalRuns: statuses.length, stateDirectory: upgradedOwner.state.directory,
          daemonPath: upgradedOwner.executable, candidateVersion, previousOwnerReceipt: plan.ownerReceipt }
        try { await writeUpgradedReceipt(plan, upgradedOwner, after.runtime) }
        catch (error) { return { ...confirmed, ownerReceiptError: error.message } }
        return confirmed
      } catch (error) { lastError = error }
      await sleep(100)
    } while (Date.now() < deadline)
    throw lastError
  } catch (error) {
    lastError = error
    // Old SDK success, old executable and exact process/Run facts are an
    // independent positive proof. Timeout alone is never a rollback oracle.
    try {
      const oldOwner = await processOwner(plan.old.socketPath, plan.old)
      assertServingOwner(plan.owner, oldOwner)
      const old = await inspect(plan.oldSdk, plan.old.socketPath)
      await assertRunsKept(plan, old, plan.oldSdk)
      return { status: 'old-confirmed', signalSent: sent, protocol: old.protocol, daemonPid: oldOwner.pid, candidateVersion, error: lastError.message }
    } catch (confirmationError) {
      return { status: 'unknown', signalSent: sent, candidateVersion, error: lastError.message, confirmationError: confirmationError.message }
    }
  }
}

export async function closeRuntimeUpgrade(plan) {
  if (plan) await rm(plan.temporary, { recursive: true, force: true })
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--inspect-ui') {
  const { connectAgentMuxRpc } = await import(pathToFileURL(process.argv[3]).href)
  const client = await connectAgentMuxRpc()
  try {
    const result = await client.call('app.inspect', {})
    process.stdout.write(JSON.stringify(parseDesktopClientObservation(result.observation)))
  } finally { await client.dispose() }
} else if (process.argv[2] === '--identity') {
  const sdk = await import(pathToFileURL(process.argv[3]).href)
  const runtime = await inspectRead('runtimeInfo', process.argv[4], {}, () =>
    new sdk.CtxmuxClient({ socketPath: process.argv[4] }).runtimeInfo())
  process.stdout.write(JSON.stringify({ protocol: sdk.PROTOCOL_VERSION, runtime }))
} else if (process.argv[2] === '--inspect') await inspectPublicRuntime(process.argv[3], process.argv[4], process.argv[5],
  process.argv[6] === undefined ? undefined : JSON.parse(process.argv[6]))
  else if (process.argv[2] === '--status') {
    const { CtxmuxClient } = await import(pathToFileURL(process.argv[3]).href)
    const client = new CtxmuxClient({ socketPath: process.argv[4],
      expectedRuntimeIdentity: JSON.parse(process.argv[6]) })
    const statuses = []
    for (const id of JSON.parse(process.argv[5])) {
      const run = await inspectRead('status', process.argv[4], { runId: id }, () => client.status(id))
      await inspectRead('status identity', process.argv[4], { runId: id }, () => {
        fail(run.id === id, 'The Runtime returned another Run instead of the requested identity.')
      })
      statuses.push({ id: run.id, pid: run.pid, state: run.state, acceptedInputBytes: run.applied_input_bytes,
        outputBytes: run.latest_output_bytes, currentSize: run.current_size })
    }
    process.stdout.write(JSON.stringify(statuses))
  } else throw new Error('Unknown installer Runtime inspection operation.')
}

/** Unknown storage refuses this update before GUI exit; it does not interrupt the serving Agent. */
export function requireOutgoingWorkbenchStorage(observation) {
  fail(observation.main.storage?.localStorage === 'present',
    'The original workbench storage owner is unconfirmed. The existing interface and Runs were kept; restore storage access and retry the update.')
}
