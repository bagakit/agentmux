import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { readPackageIdentity, assertPackageIdentity } from '../package-identity.mjs'
import { copyDirectoryContents } from '../runtime-application-payload.mjs'
import { PRODUCT_NAME } from '../macos-application-brand.mjs'

const exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const assertFixedGitSource = ({ commit, tree }) => {
  assert.ok(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree) && commit.length === tree.length,
    'Prepared sources require immutable full Git objects')
}

/** Closed, finite bytes of one selected artifact; links may not borrow another installation. */
export async function a2aArtifactInventory(root) {
  root = await realpath(root)
  const files = {}
  async function visit(path) {
    const info = await lstat(path), name = relative(root, path), mode = info.mode & 0o777
    if (info.isSymbolicLink()) {
      const target = await readlink(path), destination = resolve(dirname(path), target)
      assert.ok(!isAbsolute(target) && inside(root, destination), 'Prepared artifact has an external link: ' + name)
      assert.ok(inside(root, await realpath(path)), 'Prepared artifact link must resolve inside its sealed graph: ' + name)
      files[name] = { kind: 'link', target, mode }
    } else if (info.isDirectory()) {
      files[name] = { kind: 'directory', mode }
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else {
      assert.ok(info.isFile(), 'Unsupported prepared artifact entry: ' + name)
      files[name] = { kind: 'file', mode, bytes: info.size, sha256: sha(await readFile(path)) }
    }
  }
  await visit(root)
  assert.ok(Object.keys(files).length > 0)
  return { files, sha256: sha(JSON.stringify(files)) }
}

async function reference(root, value) {
  assert.equal(typeof value?.path, 'string'); assert.match(value.sha256, /^[a-f0-9]{64}$/u)
  const path = resolve(root, value.path), bytes = await readFile(path)
  assert.equal(sha(bytes), value.sha256, 'Prepared provenance changed: ' + value.path)
  return { path, sha256: value.sha256, bytes }
}

export function a2aPreparedExecution(applicationBundle) {
  const desktopRoot = join(applicationBundle, 'Contents/Resources/app'), coreRoot = join(desktopRoot, 'node_modules/@agentmux/core')
  return { kind: 'prepared-artifact', applicationBundle, desktopRoot, coreRoot,
    mainEntry: join(desktopRoot, 'out/main/index.js'), executable: join(applicationBundle, 'Contents/MacOS', PRODUCT_NAME),
    argv: [], cli: { executable: join(coreRoot, 'bin/amux'), argv: [] } }
}

/** The input references the original clone/build/review owners; it never upgrades their outcomes. */
export async function prepareA2aArtifact({ root, input, privateRoot, sourcePaths }) {
  root = await realpath(root); privateRoot = await realpath(privateRoot)
  const inputBytes = await readFile(input), descriptor = JSON.parse(inputBytes)
  assert.equal(descriptor.schema, 'agentmux.a2a-prepared-input.v1')
  const originRecord = await reference(root, descriptor.origin)
  const origin = JSON.parse(originRecord.bytes)
  assert.equal(origin.schema, 'agentmux.prepared-product-input.v1')
  const originBundle = await realpath(origin.applicationBundle)
  const identity = await readPackageIdentity(originBundle)
  assertPackageIdentity(identity, origin.sourceIdentity)
  assertFixedGitSource({ commit: identity.sourceCommit, tree: identity.sourceTree })
  assert.equal(identity.platform, process.platform); assert.equal(identity.arch, process.arch)
  const sourceTree = (await exec('git', ['show', '-s', '--format=%T', identity.sourceCommit], { cwd: root })).stdout.trim()
  assert.equal(sourceTree, identity.sourceTree, 'Selected artifact must name an exact retained Git source tree')
  const records = {}
  for (const name of ['buildRecord', 'sourceReview']) {
    const entry = await reference(root, descriptor[name]); records[name] = { path: entry.path, sha256: entry.sha256 }
  }
  assert.equal(descriptor.buildDisposition?.compilation, 'completed')
  assert.ok(['passed', 'unknown'].includes(descriptor.buildDisposition.installation))
  assert.ok(['confirmed', 'not-reached'].includes(descriptor.buildDisposition.sourceFinalization))
  assert.ok(Array.isArray(sourcePaths) && sourcePaths.length > 0 && new Set(sourcePaths).size === sourcePaths.length)
  const sourceSnapshot = { commit: identity.sourceCommit, tree: identity.sourceTree, files: {} }
  for (const path of sourcePaths) {
    const bytes = (await exec('git', ['show', identity.sourceCommit + ':' + path], { cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout
    sourceSnapshot.files[path] = sha(bytes)
  }
  assert.equal(Object.keys(sourceSnapshot.files).length, sourcePaths.length)
  const originRelease = JSON.parse(await readFile(join(originBundle, 'Contents/Resources/app/node_modules/@agentmux/core/release.json'), 'utf8'))
  assert.deepEqual(originRelease, { sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree })
  const before = await a2aArtifactInventory(originBundle)
  const applicationBundle = join(privateRoot, 'application', PRODUCT_NAME + '.app')
  await mkdir(applicationBundle, { recursive: true })
  await copyDirectoryContents(originBundle, applicationBundle)
  const inventory = await a2aArtifactInventory(applicationBundle)
  assert.deepEqual(inventory, before, 'The private executable artifact must be an exact clone')
  assertPackageIdentity(await readPackageIdentity(originBundle), identity)
  const application = join(applicationBundle, 'Contents', 'Resources', 'app')
  const coreRoot = join(application, 'node_modules', '@agentmux', 'core')
  const release = JSON.parse(await readFile(join(coreRoot, 'release.json'), 'utf8'))
  assert.deepEqual(release, { sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree })
  const corePrefix = relative(applicationBundle, join(coreRoot, 'dist')) + sep
  const coreGraph = Object.fromEntries(Object.entries(inventory.files).filter(([path, value]) =>
    path.startsWith(corePrefix) && path.endsWith('.js') && value.kind === 'file').map(([path, value]) => ['dist/' + path.slice(corePrefix.length), value.sha256]))
  assert.ok(Object.keys(coreGraph).length > 100, 'Full prepared Core JS graph is nonempty')
  const execution = a2aPreparedExecution(applicationBundle)
  for (const path of [execution.executable, execution.mainEntry, execution.cli.executable, coreRoot]) {
    assert.ok(inside(applicationBundle, await realpath(path)), 'Actual execution must stay within the frozen artifact')
  }
  return { kind: 'prepared-artifact', input: { path: resolve(input), sha256: sha(inputBytes) },
    origin: { record: { path: originRecord.path, sha256: originRecord.sha256 }, applicationBundle: originBundle },
    identity, sourceSnapshot, records, buildDisposition: descriptor.buildDisposition,
    artifact: { applicationBundle, inventory }, coreGraph, execution }
}

/** Read the declared product source, independent of later checkout edits. */
export async function readA2aPreparedSource(preparation, { root, path }) {
  assert.equal(preparation.kind, 'prepared-artifact')
  assertFixedGitSource(preparation.sourceSnapshot)
  assert.ok(typeof path === 'string' && !isAbsolute(path) && !path.split('/').includes('..'))
  assert.ok(Object.hasOwn(preparation.sourceSnapshot.files, path), 'Prepared source was not declared: ' + path)
  assert.equal(preparation.sourceSnapshot.commit, preparation.identity.sourceCommit)
  assert.equal(preparation.sourceSnapshot.tree, preparation.identity.sourceTree)
  const bytes = (await exec('git', ['show', preparation.sourceSnapshot.commit + ':' + path],
    { cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })).stdout
  assert.equal(sha(bytes), preparation.sourceSnapshot.files[path], 'Fixed prepared source snapshot: ' + path)
  return bytes
}

export async function verifyA2aPreparedArtifact(preparation, { root, artifact = 'execution' }) {
  root = await realpath(root)
  assert.ok(['execution', 'origin'].includes(artifact), 'Choose the exact artifact being observed; never silently fall back')
  assert.equal(preparation.kind, 'prepared-artifact')
  assertFixedGitSource(preparation.sourceSnapshot)
  assert.ok(Object.keys(preparation.sourceSnapshot.files).length > 0, 'The fixed source snapshot must be nonempty')
  const descriptor = JSON.parse((await reference(root, preparation.input)).bytes)
  assert.equal(descriptor.schema, 'agentmux.a2a-prepared-input.v1')
  assert.deepEqual(preparation.buildDisposition, descriptor.buildDisposition)
  assert.deepEqual(preparation.origin.record, { path: resolve(root, descriptor.origin.path), sha256: descriptor.origin.sha256 })
  for (const name of ['buildRecord', 'sourceReview']) assert.deepEqual(preparation.records[name],
    { path: resolve(root, descriptor[name].path), sha256: descriptor[name].sha256 })
  const origin = JSON.parse((await reference(root, preparation.origin.record)).bytes)
  assertPackageIdentity(origin.sourceIdentity, preparation.identity)
  assert.equal(preparation.sourceSnapshot.commit, preparation.identity.sourceCommit)
  assert.equal(preparation.sourceSnapshot.tree, preparation.identity.sourceTree)
  assert.equal((await exec('git', ['show', '-s', '--format=%T', preparation.sourceSnapshot.commit], { cwd: root })).stdout.trim(), preparation.sourceSnapshot.tree)
  for (const record of Object.values(preparation.records)) await reference(root, record)
  assert.deepEqual(preparation.execution, a2aPreparedExecution(preparation.artifact.applicationBundle))
  const observedBundle = artifact === 'origin' ? preparation.origin.applicationBundle : preparation.artifact.applicationBundle
  const execution = a2aPreparedExecution(observedBundle)
  for (const path of [execution.executable, execution.mainEntry, execution.cli.executable, execution.coreRoot])
    assert.ok(inside(observedBundle, await realpath(path)), 'Selected execution stays inside the sealed artifact')
  assertPackageIdentity(await readPackageIdentity(observedBundle), preparation.identity)
  assert.deepEqual(await a2aArtifactInventory(observedBundle), preparation.artifact.inventory,
    'The selected prepared artifact graph stayed unchanged')
  for (const path of Object.keys(preparation.sourceSnapshot.files)) await readA2aPreparedSource(preparation, { root, path })
  const prefix = relative(preparation.artifact.applicationBundle, join(preparation.execution.coreRoot, 'dist')) + sep
  const graph = Object.fromEntries(Object.entries(preparation.artifact.inventory.files).filter(([path, value]) =>
    path.startsWith(prefix) && path.endsWith('.js') && value.kind === 'file').map(([path, value]) => ['dist/' + path.slice(prefix.length), value.sha256]))
  assert.deepEqual(graph, preparation.coreGraph, 'The product and later model join retain the full same-Core graph')
  return execution
}
