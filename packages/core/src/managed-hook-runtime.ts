import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { AgentMuxError } from './errors.js'
import { resolveCoreBinPath } from './runtime-paths.js'

export type ManagedHookRuntime = { nodePath: string; runnerPath: string }
/** Native local publication inputs, never a wire option or a Session routing source. */
export type ManagedHookRuntimeSource = { executablePath: string; workerPath: string; electron?: boolean }
type Entry = { path: string; mode: number; kind: 'file'; bytes: number; sha256: string } |
  { path: string; mode: number; kind: 'directory' } | { path: string; mode: number; kind: 'symlink'; target: string }
type Interpreter = { identity: string; entries: Entry[]; roots: { from: string; to: string }[]; executable: string }
type Description = { interpreter: Interpreter; worker: Buffer; workerIdentity: string; workerMode: number }
const execFileAsync = promisify(execFile)
const descriptions = new WeakMap<ManagedHookRuntimeSource, Promise<Description>>()
const publications = new Map<string, Promise<ManagedHookRuntime>>()
let nativeSource: ManagedHookRuntimeSource | undefined
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

function unavailable(message: string): never { throw new AgentMuxError(message, 'HOOK_RUNTIME_UNAVAILABLE') }
function isAbsent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
async function fileSha(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}

/** Describe the actual executable closure once; normal Runs and callbacks never scan it. */
async function describe(source: ManagedHookRuntimeSource): Promise<Description> {
  const worker = await readFile(source.workerPath), workerInfo = await lstat(source.workerPath)
  if (!workerInfo.isFile() || workerInfo.isSymbolicLink()) return unavailable('The built Hook worker is not a regular self-contained artifact.')
  const executable = await realpath(source.executablePath)
  const roots: Interpreter['roots'] = []
  let nativeRoot = dirname(executable), destinationExecutable = 'node'
  if (source.electron) {
    if (process.platform !== 'darwin') return unavailable('This Electron runtime has no qualified portable Hook closure on this platform.')
    nativeRoot = dirname(dirname(executable))
    if (basename(nativeRoot) !== 'Contents') return unavailable('The original Electron executable has no application Contents owner.')
    destinationExecutable = join('Contents', 'MacOS', basename(executable))
    // The native runtime, not Resources/app or the user's workspace. Framework symlinks and
    // helpers retain their original relative geometry and signatures.
    for (const name of ['MacOS', 'Frameworks', 'Info.plist', 'PkgInfo']) {
      const from = join(nativeRoot, name)
      try { await lstat(from) } catch (error) { if (name === 'PkgInfo' && isAbsent(error)) continue; throw error }
      roots.push({ from, to: join('Contents', name) })
    }
  } else roots.push({ from: executable, to: destinationExecutable })

  // Probe with no AgentMux credentials. A standalone Node requiring libraries from an
  // unrelated package tree is not silently certified as a one-file closure.
  const probe = await execFileAsync(executable, ['-e', 'console.log(JSON.stringify({node:process.versions.node,sharedObjects:process.report.getReport().sharedObjects}))'], {
    env: { ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 1024 * 1024
  })
  const native = JSON.parse(probe.stdout.trim()) as { node?: string; sharedObjects?: unknown }
  if (!native.node || Number(native.node.split('.')[0]) < 24 || !Array.isArray(native.sharedObjects)) {
    return unavailable('The original interpreter did not confirm a supported Node Hook runtime.')
  }
  for (const path of native.sharedObjects) {
    // Linux maps this virtual object into each process. It has no file to retain.
    if (process.platform === 'linux' && path === 'linux-vdso.so.1') continue
    if (typeof path !== 'string' || !isAbsolute(path)) return unavailable('The interpreter reported an unqualified library location.')
    const system = process.platform === 'darwin' ? path.startsWith('/usr/lib/') || path.startsWith('/System/Library/')
      : ['/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/'].some(prefix => path.startsWith(prefix))
    const retained = path === executable || source.electron && (path === nativeRoot || path.startsWith(nativeRoot + sep))
    if (!system && !retained) return unavailable(`The interpreter depends on a library outside its retained native closure: ${path}`)
  }

  const entries: Entry[] = []
  async function walk(from: string, to: string): Promise<void> {
    const info = await lstat(from), mode = info.mode & 0o777
    if (info.isSymbolicLink()) {
      const target = await readlink(from), resolved = resolve(dirname(from), target)
      if (isAbsolute(target) || !(resolved === nativeRoot || resolved.startsWith(nativeRoot + sep))) {
        return unavailable(`The native Hook closure contains an external link at ${from}.`)
      }
      entries.push({ path: to, mode, kind: 'symlink', target }); return
    }
    if (info.isDirectory()) {
      entries.push({ path: to, mode, kind: 'directory' })
      for (const name of (await readdir(from)).sort()) await walk(join(from, name), join(to, name))
      return
    }
    if (!info.isFile()) return unavailable(`The native Hook closure contains a non-file at ${from}.`)
    entries.push({ path: to, mode, kind: 'file', bytes: info.size, sha256: await fileSha(from) })
  }
  for (const root of roots) await walk(root.from, root.to)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const identity = sha(JSON.stringify({ executable: destinationExecutable, entries }))
  const workerMode = workerInfo.mode & 0o777
  return { interpreter: { identity, entries, roots, executable: destinationExecutable }, worker,
    workerIdentity: sha(Buffer.concat([Buffer.from(workerMode.toString(8) + '\0'), worker])), workerMode }
}

async function validateInterpreter(directory: string, interpreter: Interpreter, durable = false): Promise<void> {
  const manifest = JSON.stringify({ executable: interpreter.executable, entries: interpreter.entries })
  if ((await readFile(join(directory, 'manifest.json'), 'utf8')) !== manifest) return unavailable('The retained Hook interpreter manifest does not match its content identity.')
  for (const entry of interpreter.entries) {
    const path = join(directory, entry.path), info = await lstat(path)
    if ((info.mode & 0o777) !== entry.mode) return unavailable(`The retained Hook interpreter mode changed at ${entry.path}.`)
    if (entry.kind === 'symlink') {
      if (!info.isSymbolicLink() || await readlink(path) !== entry.target) return unavailable(`The retained Hook interpreter link changed at ${entry.path}.`)
    } else if (entry.kind === 'directory') {
      if (!info.isDirectory() || info.isSymbolicLink()) return unavailable(`The retained Hook interpreter directory changed at ${entry.path}.`)
    } else {
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes || await fileSha(path) !== entry.sha256) {
        return unavailable(`The retained Hook interpreter file changed at ${entry.path}.`)
      }
      if (durable) { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
    }
  }
  if (durable) {
    // Child directory entries must reach disk before the complete artifact is published.
    const directories = new Set(interpreter.entries.filter(entry => entry.kind === 'directory').map(entry => entry.path))
    for (const entry of interpreter.entries) {
      let parent = dirname(entry.path)
      while (parent !== '.') { directories.add(parent); parent = dirname(parent) }
    }
    for (const path of [...directories].sort((a, b) => b.split(sep).length - a.split(sep).length)) await syncDirectory(join(directory, path))
    await syncDirectory(directory)
  }
}

async function publishInterpreter(parent: string, interpreter: Interpreter): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const destination = join(parent, interpreter.identity)
  try { await lstat(destination); await validateInterpreter(destination, interpreter); return join(destination, interpreter.executable) }
  catch (error) { if (!isAbsent(error)) throw error }
  const temporary = await mkdtemp(join(parent, '.prepare-'))
  try {
    for (const root of interpreter.roots) {
      await mkdir(dirname(join(temporary, root.to)), { recursive: true, mode: 0o700 })
      if (process.platform === 'darwin') {
        // The system copier preserves native bundle metadata and uses clonefile.
        // The existing Desktop package copier uses this same native operation.
        await execFileAsync('/bin/cp', ['-cR', root.from, join(temporary, root.to)])
      } else {
        await cp(root.from, join(temporary, root.to), { recursive: true, dereference: false,
          verbatimSymlinks: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE })
      }
    }
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify({ executable: interpreter.executable, entries: interpreter.entries }), { mode: 0o600 })
    await validateInterpreter(temporary, interpreter, true)
    const manifest = await open(join(temporary, 'manifest.json'), 'r')
    try { await manifest.sync() } finally { await manifest.close() }
    try { await rename(temporary, destination) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await validateInterpreter(destination, interpreter)
    }
    await syncDirectory(parent)
    return join(destination, interpreter.executable)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function publishWorker(parent: string, description: Description): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const destination = join(parent, description.workerIdentity + '.mjs')
  try {
    const info = await lstat(destination)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== description.workerMode ||
        !(await readFile(destination)).equals(description.worker)) return unavailable('The retained Hook worker does not match its immutable identity.')
    return destination
  } catch (error) { if (!isAbsent(error)) throw error }
  const temporary = await mkdtemp(join(parent, '.prepare-'))
  try {
    const path = join(temporary, 'worker.mjs')
    await writeFile(path, description.worker, { mode: description.workerMode })
    const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() }
    // Equal content has an equal name; replacing it with the same complete bytes is safe
    // across independent Core publishers, and never overwrites another revision.
    await rename(path, destination); await syncDirectory(parent)
    return destination
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** One immutable interpreter closure shared by worker revisions, and one built worker per
 * content identity. Nothing here owns Sessions, routes, credentials or automatic deletion. */
export async function prepareManagedHookRuntime(stateDirectory: string, source?: ManagedHookRuntimeSource): Promise<ManagedHookRuntime> {
  source ??= nativeSource ??= { executablePath: process.execPath,
    workerPath: resolve(dirname(resolveCoreBinPath('agentmux-hook.js')), '../dist/agentmux-hook.mjs'),
    electron: typeof process.versions.electron === 'string' }
  let description = descriptions.get(source)
  if (!description) {
    description = describe(source)
    descriptions.set(source, description)
    void description.catch(() => descriptions.delete(source!))
  }
  const value = await description
  const root = join(resolve(stateDirectory), 'hook-runtime')
  const key = JSON.stringify([root, value.interpreter.identity, value.workerIdentity])
  const existing = publications.get(key)
  if (existing) return existing
  const pending = (async () => {
    const nodePath = await publishInterpreter(join(root, 'interpreters'), value.interpreter)
    const runnerPath = await publishWorker(join(root, 'workers'), value)
    return { nodePath, runnerPath }
  })()
  publications.set(key, pending)
  try { return await pending } finally { if (publications.get(key) === pending) publications.delete(key) }
}
