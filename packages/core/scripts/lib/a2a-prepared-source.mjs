import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fullObjectName = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const identityRecipe = 'packages/identity/scripts/runtime-bundle.mjs'

/** Git's own object id, so each file is compared with its exact tree entry. */
function gitBlobId(bytes, objectNameLength) {
  return createHash(objectNameLength === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** One cat-file process returns the named blobs in order; a missing name or another object type fails. */
async function readGitBlobs(root, names) {
  assert.ok(names.length > 0 && names.every(name => typeof name === 'string' && name.length > 0 && !/[\n\r]/u.test(name)))
  const child = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  const chunks = [], errors = []
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk))
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('git cat-file failed: ' + Buffer.concat(errors).toString().trim())))
  })
  child.stdin.end(names.map(name => name + '\n').join(''))
  await closed
  const output = Buffer.concat(chunks), blobs = []
  let offset = 0
  for (const name of names) {
    const end = output.indexOf(10, offset)
    assert.ok(end >= 0, 'Complete cat-file header: ' + name)
    const [, type, size] = output.subarray(offset, end).toString().split(' ')
    assert.equal(type, 'blob', 'Fixed source object is a readable blob: ' + name)
    const start = end + 1, length = Number(size)
    assert.ok(Number.isSafeInteger(length) && start + length < output.length, 'Complete cat-file body: ' + name)
    blobs.push(output.subarray(start, start + length))
    offset = start + length + 1
  }
  assert.equal(offset, output.length)
  return blobs
}

/** Core and the workspace packages it depends on, read through one manifest source. */
export async function a2aSourceClosure(readManifest) {
  const closure = [], pending = ['core']
  while (pending.length) {
    const name = pending.shift()
    if (closure.includes(name)) continue
    assert.match(name, /^[a-z0-9][a-z0-9-]*$/u)
    closure.push(name)
    const manifest = JSON.parse(await readManifest(`packages/${name}/package.json`))
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {}))
      if (dependency.startsWith('@agentmux/') && String(version).startsWith('workspace:')) pending.push(dependency.slice('@agentmux/'.length))
  }
  return closure.sort()
}

/** Compiler inputs that the module graph never loads: TypeScript configuration and the generated identity export's recipe. */
export function a2aSourceCompileInputs(closure) {
  return ['tsconfig.base.json', ...closure.flatMap(name => [`packages/${name}/package.json`, `packages/${name}/tsconfig.json`]),
    ...(closure.includes('identity') ? [identityRecipe, 'packages/identity/src/runtime-entry.ts'] : [])]
}

/** Product source of the closure; tests, scripts and other harness inputs are not. */
export function isA2aSourcePath(path, closure) {
  if (typeof path !== 'string' || path.split('/').includes('..')) return false
  if (path === 'tsconfig.base.json' || path === identityRecipe && closure.includes('identity')) return true
  const match = /^packages\/([^/]+)\/(?:src\/.+|package\.json|tsconfig\.json)$/u.exec(path)
  return Boolean(match && closure.includes(match[1]))
}

/** The fixed source closure and its tree entries, derived only from the commit. */
export async function a2aFixedSource(root, { commit, tree }) {
  assert.ok(fullObjectName.test(commit) && fullObjectName.test(tree) && commit.length === tree.length, 'A fixed source names full Git objects')
  assert.equal((await exec('git', ['show', '-s', '--format=%T', commit], { cwd: root })).stdout.trim(), tree, 'The commit names its exact tree')
  const closure = await a2aSourceClosure(async path => (await readGitBlobs(root, [commit + ':' + path]))[0].toString())
  const required = a2aSourceCompileInputs(closure)
  const listing = (await exec('git', ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...required,
    ...closure.map(name => `packages/${name}/src`), 'pnpm-lock.yaml'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const [metadata, path] = line.split('\t'), [mode, type, oid] = metadata.split(' ')
    return { mode, type, oid, path }
  })
  for (const entry of entries) assert.ok(entry.type === 'blob' && ['100644', '100755'].includes(entry.mode), 'Fixed source holds regular files only: ' + entry.path)
  const lock = entries.find(entry => entry.path === 'pnpm-lock.yaml')
  assert.ok(lock, 'The fixed commit has its dependency lockfile')
  const files = entries.filter(entry => entry !== lock)
  for (const path of required) assert.ok(files.some(entry => entry.path === path), 'Fixed source compiler input: ' + path)
  for (const name of closure) assert.ok(files.some(entry => entry.path.startsWith(`packages/${name}/src/`)), 'Fixed workspace package source: ' + name)
  const origin = { kind: 'fixed-git', commit, tree, packages: closure,
    inventorySHA256: sha256(JSON.stringify(files.map(entry => [entry.path, entry.mode, entry.oid]))), dependencyLock: lock.oid }
  return { closure, files, lock, origin }
}

/** The fixed closure's bytes, each checked against its tree entry. */
export async function readA2aFixedSourceBlobs(root, fixed) {
  const bytes = await readGitBlobs(root, fixed.files.map(entry => entry.oid))
  const blobs = new Map(), digests = {}
  for (const [index, entry] of fixed.files.entries()) {
    assert.equal(gitBlobId(bytes[index], fixed.origin.commit.length), entry.oid, 'Fixed source blob: ' + entry.path)
    blobs.set(entry.path, bytes[index]); digests[entry.path] = sha256(bytes[index])
  }
  return { blobs, digests }
}

/** Freeze the prepared commit's whole source closure into a caller-owned directory. */
export async function freezeA2aPreparedSource(preparation, { root, destination }) {
  const { commit, tree } = preparation.sourceSnapshot
  assert.equal(preparation.identity.sourceCommit, commit); assert.equal(preparation.identity.sourceTree, tree)
  const declared = Object.entries(preparation.sourceSnapshot.files)
  assert.ok(declared.length > 0, 'The prepared source snapshot is nonempty')
  const fixed = await a2aFixedSource(root, { commit, tree })
  assert.equal(gitBlobId(await readFile(join(root, 'pnpm-lock.yaml')), commit.length), fixed.lock.oid,
    'Third-party packages come from the installed workspace, whose lockfile must equal the fixed commit')
  const { blobs, digests } = await readA2aFixedSourceBlobs(root, fixed)
  for (const [path, digest] of declared)
    if (isA2aSourcePath(path, fixed.closure)) assert.equal(digests[path], digest, 'The prepared snapshot declares the fixed blob: ' + path)
  await mkdir(destination, { mode: 0o700 })
  for (const entry of fixed.files) {
    const target = join(destination, entry.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, blobs.get(entry.path), { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 })
  }
  for (const entry of fixed.files)
    assert.equal(gitBlobId(await readFile(join(destination, entry.path)), commit.length), entry.oid, 'Frozen file holds its fixed blob: ' + entry.path)
  for (const name of fixed.closure) {
    const modules = join(root, 'packages', name, 'node_modules')
    if (await lstat(modules).then(() => true, () => false)) await symlink(modules, join(destination, 'packages', name, 'node_modules'), 'dir')
  }
  return { sourceRoot: destination, closure: fixed.closure, blobs, digests, origin: fixed.origin }
}
