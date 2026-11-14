import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const schema = 'agentmux.qualified-renderer-cache.v1'
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)

export async function rendererOutputHashes(directory) {
  const hashes = {}
  async function walk(folder, prefix = '') {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + item.name, file = join(folder, item.name)
      if (item.isDirectory()) await walk(file, name + '/')
      else { assert.ok(item.isFile(), 'Renderer cache contains only regular compiled files'); hashes[name] = digest(await readFile(file)) }
    }
  }
  await walk(directory)
  return hashes
}

export async function rendererCacheContext({ root, revision, compilerFiles, metadata }) {
  assert.ok(revision, 'Renderer reuse requires an immutable product ref')
  const compiler = Object.fromEntries(await Promise.all(compilerFiles.map(async file => [file, digest(await readFile(file))])))
  return { schema, root: resolve(root), revision, compiler, metadata, node: process.versions.node, platform: process.platform, arch: process.arch,
    boundary: 'One explicit local renderer dist. Exact compiler/loader bytes include defines and aliases; current renderer watch inputs and resolver metadata remain bound. Observer CJS is separately hashed, never a renderer cache key. No hermetic repository or Native/aesthetic qualification.' }
}

async function verifyInputCoverage({ context, compilation, sourcePin }) {
  assert.equal(context.revision, sourcePin.revision, 'Cache context and actual Git reader use the same resolved commit')
  assert.equal(compilation.sourceOverlay.revision, context.revision, 'Original compilation and cache context use the same resolved commit')
  assert.deepEqual(compilation.resolverMetadata, context.metadata, 'Original compilation and cache context use identical declared current resolver metadata')
  const entries = Object.entries(compilation.inputs)
  assert.ok(entries.length && Object.keys(compilation.watchInputs ?? {}).length, 'Every renderer admission declares actual inputs and current watch inputs')
  await Promise.all(entries.filter(([file]) => sourcePin.owns(resolve(context.root, file))).map(async ([file, sha]) => {
    const record = compilation.sourceOverlay.files[file]
    assert.ok(record?.origin === 'git-blob', 'Every consumed product input has an exact Git namespace entry: ' + file)
    assert.equal(record.sha256, sha)
    assert.equal(digest(await sourcePin.read(resolve(context.root, file))), sha, 'Consumed product input matches its exact current reader: ' + file)
    assert.equal(sourcePin.files[file].gitObject, record.gitObject)
  }))
  for (const [file, sha] of entries) {
    const target = resolve(context.root, file)
    assert.ok(target.startsWith(context.root + sep), 'Actual input remains in its declared workspace namespace')
    if (!sourcePin.owns(target)) assert.equal(compilation.watchInputs[target], sha, 'Every consumed current fixture input has an exact watch hash: ' + file)
  }
}

export async function loadRendererCache({ directory, context, sourcePin }) {
  assert.equal(context.revision, sourcePin.revision, 'Cache admission uses the declared Git reader')
  let manifest
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return { reused: false, reason: 'absent' }; throw error }
  assert.equal(manifest.schema, schema); assert.equal(manifest.root, context.root, 'Never reuse or remove another project cache')
  if (canonical(manifest.context) !== canonical(context)) return { reused: false, reason: 'compiler-ref-or-metadata-changed' }
  assert.equal(manifest.compilation.phase, 'complete'); assert.equal(manifest.compilationProcess.exitCode, 0); assert.equal(manifest.compilationProcess.exitConfirmed, true); assert.equal(manifest.compilationProcess.timedOut, false)
  assert.deepEqual(manifest.compilation.foreignWorkspaceSources, {})
  await verifyInputCoverage({ context, compilation: manifest.compilation, sourcePin })
  assert.ok(Object.keys(manifest.compilation.inputs).length && Object.keys(manifest.compilation.cssSourceProof.loaded).length && Object.keys(manifest.compilation.watchInputs).length)
  for (const [file, record] of Object.entries(manifest.compilation.cssSourceProof.loaded)) for (const read of record.reads) assert.ok(read.actualSHA256 === record.sourceSHA256 || read.actualSHA256 === manifest.compilation.cssSourceProof.rewrites[file]?.effectiveSHA256)
  const products = await Promise.all(Object.entries(manifest.compilation.sourceOverlay.files).map(async ([file, item]) => ({ file, expected: item.sha256, actual: digest(await sourcePin.read(join(context.root, file))) })))
  const productChanged = products.find(item => item.expected !== item.actual)
  if (productChanged) return { reused: false, reason: 'declared-product-input-changed', file: productChanged.file }
  for (const [file, sha] of Object.entries(manifest.compilation.watchInputs)) {
    let bytes
    try { bytes = await readFile(file) } catch (error) { if (error.code === 'ENOENT') return { reused: false, reason: 'renderer-watch-input-removed', file }; throw error }
    if (digest(bytes) !== sha) return { reused: false, reason: 'renderer-watch-input-changed', file }
  }
  const outputs = await rendererOutputHashes(join(directory, 'compiled'))
  if (canonical(outputs) !== canonical(manifest.outputs)) return { reused: false, reason: 'compiled-output-changed' }
  return { reused: true, manifest, manifestSHA256: digest(await readFile(join(directory, 'manifest.json'))), compiled: join(directory, 'compiled') }
}

export async function saveRendererCache({ directory, context, compiled, compilation, compilationProcess, outputs, evidence, sourcePin }) {
  await verifyInputCoverage({ context, compilation, sourcePin })
  assert.equal(canonical(await rendererOutputHashes(compiled)), canonical(outputs), 'Only the exact qualified compiled renderer is retained')
  let previous
  try { previous = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous) { assert.equal(previous.schema, schema); assert.equal(previous.root, context.root) }
  else {
    await mkdir(directory)
    await writeFile(join(directory, 'owner.json'), canonical({ schema, root: context.root }))
  }
  assert.equal(compilation.phase, 'complete'); assert.equal(compilationProcess.exitCode, 0); assert.equal(compilationProcess.exitConfirmed, true); assert.equal(compilationProcess.timedOut, false)
  assert.deepEqual(compilation.foreignWorkspaceSources, {})
  await rm(join(directory, 'compiled'), { recursive: true, force: true })
  await rename(compiled, join(directory, 'compiled'))
  const manifest = { schema, root: context.root, context, compilation, compilationProcess, outputs, originEvidence: evidence,
    qualification: 'Original compiler exit and actual JS/PostCSS reader checks only. Native may have failed; no Native success is inherited.' }
  const bytes = canonical(manifest)
  await writeFile(join(directory, 'manifest.next.json'), bytes); await rename(join(directory, 'manifest.next.json'), join(directory, 'manifest.json'))
  return { compiled: join(directory, 'compiled'), manifestSHA256: digest(bytes) }
}

export async function clearRendererCache(directory, root) {
  const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))
  assert.equal(owner.schema, schema); assert.equal(owner.root, resolve(root))
  await rm(directory, { recursive: true })
}
