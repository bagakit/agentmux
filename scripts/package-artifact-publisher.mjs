// Packaging owns only the archives it published. Runtime and user data have no role here.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const schema = 'agentmux.package-artifact.v1'
const writer = 'agentmux-package-artifact-publisher'
const identity = info => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(info[key])]))
const equalIdentity = (info, expected) => info.isFile() && !info.isSymbolicLink() &&
  Object.entries(identity(info)).every(([key, value]) => expected?.[key] === value)
const sameDirectory = (info, expected) => info.isDirectory() && !info.isSymbolicLink() && info.dev === expected.dev && info.ino === expected.ino
const fileInfo = path => lstat(path, { bigint: true })
const message = error => error instanceof Error ? error.message : String(error)

async function digest(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(bytes)
  return hash.digest('hex')
}

/** Keep exit status and diagnostics separate: an observation failure is never an idle file. */
export async function runArtifactCommand(command, args, input, { timeoutMs = 0 } = {}) {
  return await new Promise(resolvePromise => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', error, timedOut = false, forceKill
    const exited = () => child.exitCode !== null || child.signalCode !== null
    const releasePipes = () => { child.stdout.destroy(); child.stderr.destroy() }
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      if (exited()) { releasePipes(); return }
      child.kill('SIGTERM')
      forceKill = setTimeout(() => { if (exited()) releasePipes(); else child.kill('SIGKILL') }, 250)
      forceKill.unref()
    }, timeoutMs) : undefined
    timer?.unref()
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', cause => { error = message(cause) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.once('exit', () => {
      // Release our capture pipes after the owned child exits, even if a descendant inherited them.
      if (timedOut) releasePipes()
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(forceKill)
      resolvePromise({ code, signal, stdout, stderr, error, timedOut })
    })
  })
}

/** Only these exact archive paths are queried, and only when retention could remove them. */
export async function observeArtifactOccupancy(path, { platform = process.platform, run = runArtifactCommand } = {}) {
  try {
    const dmg = path.endsWith('.dmg'), tar = path.endsWith('.tar.gz')
    if (!(platform === 'darwin' && (dmg || tar) || platform === 'linux' && tar))
      return { state: 'unknown', reason: 'Archive occupancy is unavailable for this file on this platform.' }
    // These disposable read-only queries inspect one file/current mount inventory. A hung query
    // ends only its own child, waits for close, then keeps the archive. Build/install lifetimes are unchanged.
    const guard = { timeoutMs: 5000 }
    const unknown = (reason, result) => ({ state: 'unknown', reason, timedOut: Boolean(result.timedOut), signal: result.signal ?? null })
    if (platform === 'darwin' && dmg) {
      const plist = await run('hdiutil', ['info', '-plist'], undefined, guard)
      if (plist.timedOut || plist.error || plist.code !== 0 || plist.signal || plist.stderr) return unknown('Disk image observation failed or warned.', plist)
      const json = await run('plutil', ['-convert', 'json', '-o', '-', '-'], plist.stdout, guard)
      if (json.timedOut || json.error || json.code !== 0 || json.signal || json.stderr) return unknown('Disk image observation could not be decoded.', json)
      const images = JSON.parse(json.stdout).images
      if (!Array.isArray(images)) return { state: 'unknown', reason: 'Disk image observation has no image inventory.' }
      const canonical = await realpath(path)
      for (const image of images) {
        if (typeof image['image-path'] !== 'string') return { state: 'unknown', reason: 'An image path is unconfirmed.' }
        // A stale unrelated image path cannot invalidate this exact target's open-file observation.
        if (resolve(image['image-path']) === canonical || await realpath(image['image-path']).then(value => value === canonical, () => false))
          return { state: 'in-use', reason: 'Disk image is attached.' }
      }
    }
    const result = await run('lsof', ['-nP', '-F', 'p', '--', path], undefined, guard)
    if (result.timedOut || result.error || result.signal || result.stderr) return unknown('Open-file observation failed or warned.', result)
    if (result.code === 1 && result.stdout === '') return { state: 'free' }
    if (result.code === 0 && /^p\d+$/m.test(result.stdout)) return { state: 'in-use', reason: 'Archive is open.' }
    return { state: 'unknown', reason: 'Open-file observation did not confirm idle or open.' }
  } catch (error) { return { state: 'unknown', reason: message(error) } }
}

async function artifactTargetRoot(repositoryRoot, target) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) throw new Error('Invalid artifact target.')
  const git = await runArtifactCommand('git', ['-C', repositoryRoot, 'rev-parse', '--git-common-dir'])
  if (git.error || git.code !== 0 || git.signal || git.stderr) throw new Error('Shared repository identity could not be confirmed.')
  const commonRoot = dirname(await realpath(resolve(repositoryRoot, git.stdout.trim())))
  let directory = commonRoot
  for (const name of ['.local', 'package-delivery', 'artifacts', target]) {
    directory = join(directory, name)
    await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await fileInfo(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Artifact directory is not an owned ordinary directory: ${directory}`)
  }
  return directory
}

async function readGeneration(directory, target, generation) {
  if (!/^\d{13}-[a-f0-9-]{36}$/.test(generation)) return null
  const root = join(directory, generation), rootInfo = await fileInfo(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null
  const receiptPath = join(root, 'receipt.json'), receiptInfo = await fileInfo(receiptPath)
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > 65536n) return null
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.schema !== schema || receipt.writer !== writer || receipt.target !== target || receipt.generation !== generation ||
    typeof receipt.archive !== 'string' || basename(receipt.archive) !== receipt.archive || ['.', '..', 'receipt.json'].includes(receipt.archive) ||
    !Number.isFinite(receipt.completedAt) || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return null
  const payload = join(root, receipt.archive), info = await fileInfo(payload)
  if (!equalIdentity(info, receipt.payload)) return null
  return { root, rootInfo, receiptPath, receiptInfo, receipt, payload }
}

async function retainArchives(directory, target, current, observeOccupancy) {
  const cleanup = { status: 'complete', removed: [], retained: [], errors: [] }
  const owner = await fileInfo(directory)
  const complete = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    try {
      const generation = await readGeneration(directory, target, entry.name)
      if (generation) complete.push(generation)
    } catch { /* Missing, malformed or replaced objects do not authorize deletion. */ }
  }
  complete.sort((left, right) => right.receipt.completedAt - left.receipt.completedAt || right.receipt.generation.localeCompare(left.receipt.generation))
  for (const generation of complete.slice(2)) {
    if (generation.receipt.generation === current) continue
    try {
      const occupied = await observeOccupancy(generation.payload)
      if (occupied.state !== 'free') { cleanup.retained.push({ path: generation.payload, ...occupied }); continue }
      // Reconfirm the exact writer receipt and payload after the OS observation.
      if (!sameDirectory(await fileInfo(directory), owner) || await realpath(directory) !== directory) {
        cleanup.retained.push({ path: generation.payload, state: 'unknown', reason: 'Artifact directory changed before cleanup.' }); continue
      }
      const fresh = await readGeneration(directory, target, generation.receipt.generation)
      if (!fresh || !sameDirectory(fresh.rootInfo, generation.rootInfo) ||
        !equalIdentity(fresh.receiptInfo, identity(generation.receiptInfo)) ||
        JSON.stringify(fresh.receipt) !== JSON.stringify(generation.receipt)) {
        cleanup.retained.push({ path: generation.payload, state: 'unknown', reason: 'Generation changed before cleanup.' }); continue
      }
      await unlink(generation.payload)
      cleanup.removed.push(generation.payload)
    } catch (error) { cleanup.errors.push({ path: generation.payload, error: message(error) }) }
  }
  if (cleanup.errors.length) cleanup.status = 'partial'
  return cleanup
}

/** A qualified source survives publication/retention failures; callers never replay the build. */
export async function publishPackageArtifact({ repositoryRoot, target, archive, sha256 }, { observeOccupancy = observeArtifactOccupancy } = {}) {
  let pending, pendingIdentity, publication
  let cleanup = { status: 'not-run', removed: [], retained: [], errors: [] }
  try {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('A qualified archive SHA-256 is required.')
    const before = await fileInfo(archive)
    if (!before.isFile() || before.isSymbolicLink() || before.size === 0n) throw new Error('Qualified archive is not a nonempty ordinary file.')
    const directory = await artifactTargetRoot(repositoryRoot, target), directoryOwner = await fileInfo(directory)
    pending = await mkdtemp(join(directory, '.pending-')); pendingIdentity = await fileInfo(pending)
    const name = basename(archive), copied = join(pending, name)
    if (name === 'receipt.json') throw new Error('Archive name conflicts with its receipt.')
    await copyFile(archive, copied, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    const copyBefore = await fileInfo(copied)
    if (await digest(copied) !== sha256 || !equalIdentity(await fileInfo(copied), identity(copyBefore)) ||
      !equalIdentity(await fileInfo(archive), identity(before))) throw new Error('Archive identity changed or its copy does not match the qualified digest.')
    const completedAt = Date.now(), generation = `${completedAt}-${randomUUID()}`
    const receipt = { schema, writer, target, generation, completedAt, archive: name, sha256, payload: identity(copyBefore) }
    await writeFile(join(pending, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    const published = join(directory, generation)
    if (!sameDirectory(await fileInfo(directory), directoryOwner) || await realpath(directory) !== directory ||
      !sameDirectory(await fileInfo(pending), pendingIdentity)) throw new Error('Publication directory identity changed.')
    await rename(pending, published); pending = undefined
    publication = { status: 'published', path: join(published, name), sha256, receiptPath: join(published, 'receipt.json') }
    try { cleanup = await retainArchives(directory, target, generation, observeOccupancy) }
    catch (error) { cleanup = { ...cleanup, status: 'partial', errors: [{ path: directory, error: message(error) }] } }
  } catch (error) { publication = { status: 'failed', source: archive, error: message(error) } }
  finally {
    if (pending) {
      try {
        if (!sameDirectory(await fileInfo(pending), pendingIdentity)) throw new Error('Partial publication identity changed; retained for inspection.')
        await rm(pending, { recursive: true })
      } catch (error) { cleanup = { ...cleanup, status: 'partial', errors: [...cleanup.errors, { path: pending, error: message(error) }] } }
    }
  }
  return { publication, cleanup }
}
