import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { before, test } from 'node:test'
import { createServer } from 'vite'
import { readViteSourceMapLoader, verifyViteModuleSource } from './vite-loaded-source.mjs'

const root = resolve(import.meta.dirname, '../../..'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
let actual, loaderBytes
before(async () => {
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-vite-source-'))
  const path = 'packages/core/dist/errors.js', file = resolve(root, path), received = []
  let server
  try {
    const raw = await readFile(file), sourceMapBytes = await readFile(file + '.map')
    server = await createServer({ root, configFile: false, envFile: false, logLevel: 'silent',
      cacheDir: resolve(privateRoot, 'cache'), optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false, preTransformRequests: false },
      plugins: [{ name: 'observe-real-vite-map-input', enforce: 'pre', transform(source, id) {
        if (id === file) received.push(source)
      } }] })
    // Transform only: no import/evaluation of the Core module or its Runtime.
    await server.transformRequest('/' + path, { ssr: true })
    assert.equal(received.length, 1)
    assert.deepEqual(await readFile(file), raw); assert.deepEqual(await readFile(file + '.map'), sourceMapBytes)
    const sourceMap = { path: path + '.map', sha256: hash(sourceMapBytes) }
    actual = { raw, sourceMapBytes, expectedFileSHA256: hash(raw), expectedMapSHA256: hash(sourceMapBytes),
      module: { path, query: '', kind: 'module', fileSHA256: hash(raw), originalSHA256: hash(received[0]),
        loadedSHA256: hash(received[0]), mutation: null, sourceMap } }
    const loader = await readViteSourceMapLoader(root)
    loaderBytes = await readFile(resolve(root, loader.path))
  } finally { await server?.close(); await rm(privateRoot, { recursive: true, force: true }) }
})

test('the actual installed Vite reads a current compiled module and its same-name map', async () => {
  assert.notEqual(actual.module.originalSHA256, actual.module.fileSHA256)
  assert.deepEqual(verifyViteModuleSource(actual), actual.module.sourceMap)
  const loader = await readViteSourceMapLoader(root)
  assert.equal(loader.inputs.length, 3)
  for (const input of loader.inputs) assert.equal(hash(await readFile(resolve(root, input.path))), input.sha256)
})

test('another received or returned transformation cannot borrow map blanking', () => {
  assert.throws(() => verifyViteModuleSource({ ...actual, module: { ...actual.module, originalSHA256: hash('different received code') } }), /exact bound Vite blankReplacer/u)
  assert.throws(() => verifyViteModuleSource({ ...actual, module: { ...actual.module, loadedSHA256: hash('different returned code') } }), /another returned transformation/u)
})

test('ordinary source bytes and mutation owners cannot claim the compiled loader difference', async () => {
  const path = 'packages/core/src/errors.ts', raw = await readFile(resolve(root, path)), sha256 = hash(raw)
  const module = { ...actual.module, path, sourceMap: null, fileSHA256: sha256, originalSHA256: sha256, loadedSHA256: sha256 }
  assert.equal(verifyViteModuleSource({ module, raw, expectedFileSHA256: sha256 }), null)
  assert.throws(() => verifyViteModuleSource({ ...actual, module: { ...actual.module, path: module.path } }), /unmutated compiled module/u)
  assert.throws(() => verifyViteModuleSource({ ...actual, module: { ...actual.module, mutation: 'changed-owner' } }), /unmutated compiled module/u)
  assert.throws(() => verifyViteModuleSource({ module: { ...module, sourceMap: actual.module.sourceMap }, raw, expectedFileSHA256: sha256 }), /cannot borrow another source-map/u)
})

test('pre-load and post-load raw and map hashes all remain necessary', () => {
  assert.throws(() => verifyViteModuleSource({ ...actual, expectedFileSHA256: hash('another raw input') }), /pre-load input/u)
  assert.throws(() => verifyViteModuleSource({ ...actual, raw: Buffer.concat([actual.raw, Buffer.from(' ')]) }), /changed after loading/u)
  assert.throws(() => verifyViteModuleSource({ ...actual, expectedMapSHA256: hash('another map input') }), /pre-load input/u)
  assert.throws(() => verifyViteModuleSource({ ...actual, sourceMapBytes: Buffer.from('{}') }), /map changed after loading/u)
})

test('a wrong map name, version, file or source list is rejected even with matching hashes', () => {
  assert.throws(() => verifyViteModuleSource({ ...actual,
    module: { ...actual.module, sourceMap: { ...actual.module.sourceMap, path: 'packages/core/dist/another.js.map' } } }))
  const original = JSON.parse(actual.sourceMapBytes)
  for (const change of [{ version: 2 }, { file: 'another.js' }, { sources: [] }, { sources: 'not a source list' }]) {
    const sourceMapBytes = Buffer.from(JSON.stringify({ ...original, ...change })), sha256 = hash(sourceMapBytes)
    assert.throws(() => verifyViteModuleSource({ ...actual, sourceMapBytes, expectedMapSHA256: sha256,
      module: { ...actual.module, sourceMap: { ...actual.module.sourceMap, sha256 } } }), assert.AssertionError)
  }
})

test('duplicate directives and a nonfinal directive cannot use the loader exception', () => {
  const directive = '//# sourceMappingURL=errors.js.map'
  for (const suffix of ['\n' + directive, '\nexport const unrelated = true;']) {
    const raw = Buffer.concat([actual.raw, Buffer.from(suffix)]), sha256 = hash(raw)
    assert.throws(() => verifyViteModuleSource({ ...actual, raw, expectedFileSHA256: sha256,
      module: { ...actual.module, fileSHA256: sha256 } }), /must be unique|complete final line/u)
  }
})

async function loaderFixture(run) {
  const directory = await mkdtemp(resolve(tmpdir(), 'amx-vite-loader-'))
  try {
    const vite = resolve(directory, 'apps/desktop/node_modules/vite')
    await mkdir(resolve(directory, 'node_modules/vitest'), { recursive: true })
    await mkdir(resolve(vite, 'dist/node/chunks'), { recursive: true })
    await writeFile(resolve(directory, 'node_modules/vitest/package.json'), await readFile(resolve(root, 'node_modules/vitest/package.json')))
    await writeFile(resolve(vite, 'package.json'), await readFile(resolve(root, 'apps/desktop/node_modules/vite/package.json')))
    await writeFile(resolve(vite, 'dist/node/chunks/config.js'), loaderBytes)
    await symlink(vite, resolve(directory, 'node_modules/vite'), 'dir')
    assert.equal(await realpath(resolve(directory, 'node_modules/vite/package.json')), await realpath(resolve(vite, 'package.json')))
    await run(directory, vite)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('the version manifest and actual Vitest dependency select this exact loader', async () => {
  await loaderFixture(async (directory, vite) => {
    const other = resolve(directory, 'another-vite'); await mkdir(other)
    await writeFile(resolve(other, 'package.json'), await readFile(resolve(vite, 'package.json')))
    await rm(resolve(directory, 'node_modules/vite')); await symlink(other, resolve(directory, 'node_modules/vite'), 'dir')
    await assert.rejects(readViteSourceMapLoader(directory), /actual Vitest dependency/u)
  })
  await loaderFixture(async (directory, vite) => {
    const manifest = JSON.parse(await readFile(resolve(vite, 'package.json'))); delete manifest.version
    await writeFile(resolve(vite, 'package.json'), JSON.stringify(manifest))
    await assert.rejects(readViteSourceMapLoader(directory), /version manifest/u)
  })
})

test('a loader which changes the original blanking operation is rejected', async () => {
  await loaderFixture(async (directory, vite) => {
    await writeFile(resolve(vite, 'dist/node/chunks/config.js'), loaderBytes.toString().replace(
      'const blankReplacer = (match) => " ".repeat(match.length);', 'const blankReplacer = () => "";'))
    await assert.rejects(readViteSourceMapLoader(directory), /exact external source-map comment blanking/u)
  })
})
