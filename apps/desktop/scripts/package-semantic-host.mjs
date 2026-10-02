import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { observeApplicationProcesses } from './package-process-scope.mjs'

const exec = promisify(execFile)
const script = fileURLToPath(import.meta.url)
const fail = (condition, message) => { if (!condition) throw new Error(message) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const core = app => join(app, 'Contents/Resources/app/node_modules/@agentmux/core/dist/public-rpc-client.js')
const scope = app => ({ executable: join(app, 'Contents/MacOS/AgentMux'), helperRoot: join(app, 'Contents/Frameworks') + '/' })

async function packageSource(app) {
  const identity = JSON.parse(await readFile(join(app, 'Contents/Resources/app/package-identity.json'), 'utf8'))
  fail(/^[a-f0-9]{40}$/.test(identity.sourceCommit), 'The App Source identity is unconfirmed; the original service is retained.')
  return identity.sourceCommit
}

async function bootstrap(app) {
  const result = await exec(process.execPath, [script, '--bootstrap', core(app)], {
    timeout: 10000, maxBuffer: 64 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  return JSON.parse(result.stdout)
}

async function processRow(pid) {
  let output
  try { output = (await exec('/bin/ps', ['-p', String(pid), '-o', 'uid=,pid=,ppid=,lstart=,command='], { env: { ...process.env, LC_ALL: 'C' } })).stdout }
  catch (error) { if (error.code === 1) return null; throw error }
  const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(output)
  fail(row, 'The Semantic Host OS identity is unconfirmed; no process was signalled.')
  return { uid: Number(row[1]), pid: Number(row[2]), ppid: Number(row[3]), birth: row[4].replace(/\s+/g, ' '), command: row[5] }
}

async function bundleImage(app) {
  const image = await lstat(scope(app).executable, { bigint: true })
  fail(image.isFile(), 'The candidate App executable identity is unconfirmed.')
  return { device: image.dev.toString(), inode: image.ino.toString() }
}

async function processImage(pid, expected) {
  const result = await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-d', 'txt', '-FfDin'],
    { timeout: 5000, maxBuffer: 256 * 1024 })
  let file
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('f')) file = {}
    else if (file && ['D', 'i', 'n'].includes(line[0])) {
      file[line[0]] = line.slice(1)
      if (file.n === expected && /^0x[0-9a-f]+$/i.test(file.D ?? '') && /^\d+$/.test(file.i ?? '')) {
        return { device: BigInt(file.D).toString(), inode: file.i }
      }
    }
  }
  throw new Error('The new Semantic Host mapped App image is unconfirmed; its Runs are retained.')
}

/** Public identity plus OS identity selects one Host; other Node workers stay untouched. */
export function assertSemanticHostOwner(app, identity, row, mode) {
  fail(identity && Number.isSafeInteger(identity.hostProcessId) && identity.hostProcessId > 1 &&
    typeof identity.storePath === 'string' && isAbsolute(identity.storePath), 'The original Semantic Host namespace is unconfirmed; retry this installation when its public endpoint responds.')
  const expected = `${scope(app).executable} ${join(app, 'Contents/Resources/app/out/main/agentmux-host.js')} --store ${identity.storePath}`
  const suffix = row?.command?.slice(expected.length)
  const argvMatches = row?.command === expected || row?.command?.startsWith(expected + ' --private-access ') && isAbsolute(suffix.slice(' --private-access '.length))
  fail(row && row.pid === identity.hostProcessId && row.uid === process.getuid() && argvMatches,
    'The public Semantic Host does not match the original installed namespace; no process was signalled.')
  fail(mode && mode.pid === row.pid && mode.uid === row.uid && mode.birth === row.birth && mode.ppid === row.ppid &&
    mode.mode === 'node' && mode.executable === scope(app).executable,
    'The Semantic Host OS mode or birth is unconfirmed; no process was signalled.')
  return row
}

const operations = { bootstrap, processRow, processes: observeApplicationProcesses,
  source: packageSource, bundleImage, processImage,
  signal: (pid, signal) => process.kill(pid, signal), wait, now: () => Date.now() }

export async function prepareSemanticHostReload(currentApp, candidateApp, ops = operations) {
  const originalSource = await ops.source(currentApp), candidateSource = await ops.source(candidateApp)
  if (originalSource === candidateSource) return null
  const processes = await ops.processes(scope(currentApp))
  const entry = join(currentApp, 'Contents/Resources/app/out/main/agentmux-host.js')
  // No semantic worker from this bundle means ordinary new App startup owns the cold path.
  const selectedPids = [...new Set([...processes.serving, ...processes.externalNode])]
  const rows = await Promise.all(selectedPids.map(pid => ops.processRow(pid)))
  if (!rows.some(row => row?.command?.startsWith(`${scope(currentApp).executable} ${entry} --store `))) return null
  const identity = await ops.bootstrap(currentApp)
  const row = assertSemanticHostOwner(currentApp, identity, await ops.processRow(identity.hostProcessId), processes.nodeModes.find(mode => mode.pid === identity.hostProcessId))
  return { currentApp, originalSource, candidateSource, candidateImage: await ops.bundleImage(candidateApp), identity, owner: row }
}

/** Read the prepared namespace again; preparation is not permanent exit authority. */
export async function inspectSemanticHostForInstall(plan, ops = operations) {
  fail(await ops.source(plan.currentApp) === plan.originalSource, 'Another installation changed the App; its current Host is retained.')
  const identity = await ops.bootstrap(plan.currentApp)
  fail(identity.hostProcessId === plan.identity.hostProcessId && identity.storePath === plan.identity.storePath,
    'The original Semantic Host owner changed before activation; retry without replacing the original namespace.')
  const processes = await ops.processes(scope(plan.currentApp))
  const row = assertSemanticHostOwner(plan.currentApp, identity, await ops.processRow(identity.hostProcessId), processes.nodeModes.find(mode => mode.pid === identity.hostProcessId))
  fail(row.birth === plan.owner.birth && row.command === plan.owner.command && row.uid === plan.owner.uid,
    'The original Semantic Host process changed before activation; no process was signalled.')
  return { processes, row }
}

/** Called only after normal GUI quit. Never signals a daemon or a Run. */
export async function stopSemanticHostForInstall(plan, ops = operations) {
  if (!plan) return null
  const { processes, row } = await inspectSemanticHostForInstall(plan, ops)
  fail(processes.serving.filter(pid => pid !== row.pid).length === 0 && processes.externalNode.includes(row.pid),
    'The original GUI has not exited normally; its Semantic Host and Runs are retained.')
  ops.signal(row.pid, 'SIGTERM')
  const deadline = ops.now() + 10000
  while (await ops.processRow(row.pid)) {
    fail(ops.now() < deadline, 'The Semantic Host has not completed normal shutdown. No force kill or Native signal was attempted.')
    await ops.wait(100)
  }
  return { ...plan, stopped: true }
}

export async function confirmSemanticHostReload(plan, app, ops = operations) {
  if (!plan) return
  fail(await ops.source(app) === plan.candidateSource, 'The activated App Source does not match this installation.')
  const identity = await ops.bootstrap(app)
  fail(identity.hostProcessId !== plan.identity.hostProcessId && identity.storePath === plan.identity.storePath,
    'The new App has not activated its original Semantic Host namespace; the original Runs are retained.')
  const processes = await ops.processes(scope(app))
  const row = assertSemanticHostOwner(app, identity, await ops.processRow(identity.hostProcessId), processes.nodeModes.find(mode => mode.pid === identity.hostProcessId))
  const current = await ops.bundleImage(app), mapped = await ops.processImage(identity.hostProcessId, scope(app).executable)
  const after = await ops.processRow(identity.hostProcessId), finalImage = await ops.bundleImage(app)
  fail(current.device === plan.candidateImage.device && current.inode === plan.candidateImage.inode &&
    mapped.device === current.device && mapped.inode === current.inode &&
    finalImage.device === current.device && finalImage.inode === current.inode &&
    after?.pid === row.pid && after.uid === row.uid && after.birth === row.birth && after.command === row.command,
    'The Semantic Host is not serving this installed App image; the original Runs are retained.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--bootstrap') {
  const { connectAgentMuxRpc } = await import(pathToFileURL(process.argv[3]).href)
  // Observe the installed App through the public contract it actually ships. A new owner
  // requires its exact semantic fence; observing the outgoing App cannot upgrade its API.
  const { AGENTMUX_RPC_NATIVE_METHODS } = await import(new URL('./public-rpc.js', pathToFileURL(process.argv[3])))
  const rpc = await connectAgentMuxRpc(), consumerId = `package-host-${randomUUID()}`
  let fence
  try {
    if (Object.hasOwn(AGENTMUX_RPC_NATIVE_METHODS, 'runtime.owner.identity')) {
      const { owner } = await rpc.call('runtime.owner.identity', {})
      fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
    }
    const value = await rpc.call('runtime.bootstrap', { consumerId, ...(fence ? { fence } : {}) })
    process.stdout.write(JSON.stringify({ hostProcessId: value.hostProcessId, storePath: value.storePath }))
  } finally {
    try { await rpc.call('runtime.release-consumer', { consumerId, ...(fence ? { fence } : {}) }) } finally { await rpc.dispose() }
  }
}
