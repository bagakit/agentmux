import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Bind the installed loader which reads external maps before transform hooks. */
export async function readViteSourceMapLoader(root) {
  const vitestManifest = 'node_modules/vitest/package.json', viteManifest = 'apps/desktop/node_modules/vite/package.json'
  const inputs = []
  for (const [path, name] of [[vitestManifest, 'vitest'], [viteManifest, 'vite']]) {
    const bytes = await readFile(resolve(root, path)), manifest = JSON.parse(bytes)
    assert.equal(manifest.name, name)
    assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0, 'The actual loader needs its version manifest')
    inputs.push({ path, sha256: hash(bytes) })
  }
  const vitestRequire = createRequire(await realpath(resolve(root, vitestManifest)))
  assert.equal(await realpath(vitestRequire.resolve('vite/package.json')), await realpath(resolve(root, viteManifest)),
    'The bound Vite loader must belong to the actual Vitest dependency')
  const path = 'apps/desktop/node_modules/vite/dist/node/chunks/config.js', bytes = await readFile(resolve(root, path))
  const source = bytes.toString()
  assert.ok(source.includes('const blankReplacer = (match) => " ".repeat(match.length);') &&
    source.includes('code: code.replace(import_convert_source_map$2.default.mapFileCommentRegex, blankReplacer)'),
  'The bound Vite loader must use its exact external source-map comment blanking')
  inputs.push({ path, sha256: hash(bytes) })
  return { path, sha256: hash(bytes), normalization: 'external-source-map-comment-blanking', inputs }
}

/** Check original bytes only; each consumer still owns its exact mutation oracle. */
export function verifyViteModuleSource({ module, raw, expectedFileSHA256, sourceMapBytes, expectedMapSHA256 }) {
  assert.equal(module.kind, 'module'); assert.equal(module.query, '')
  assert.match(expectedFileSHA256, /^[a-f0-9]{64}$/u, 'An original module needs its pre-load file hash')
  assert.equal(module.fileSHA256, expectedFileSHA256, 'The module differs from its pre-load input')
  assert.equal(hash(raw), expectedFileSHA256, 'The original module changed after loading')
  if (module.originalSHA256 === module.fileSHA256) {
    assert.ok(module.sourceMap == null, 'An ordinary raw module cannot borrow another source-map proof')
    return null
  }
  assert.ok(/\/dist\/.*\.js$/u.test(module.path) && module.mutation === null && module.sourceMap,
    'Only an unmutated compiled module can use the exact source-map loader operation')
  const source = raw.toString(), directive = '//# sourceMappingURL=' + basename(module.path) + '.map'
  assert.equal(source.split(directive).length, 2, 'The compiled external map directive must be unique')
  assert.ok(source.endsWith('\n' + directive) || source.endsWith('\n' + directive + '\n'),
    'The original map directive must be the complete final line')
  assert.equal(module.originalSHA256, hash(source.replace(directive, ' '.repeat(directive.length))),
    'The received module must equal the exact bound Vite blankReplacer output')
  assert.equal(module.loadedSHA256, module.originalSHA256, 'Map blanking cannot authorize another returned transformation')
  assert.equal(module.sourceMap.path, module.path + '.map')
  assert.match(expectedMapSHA256, /^[a-f0-9]{64}$/u, 'The original external source map must be preinventoried')
  assert.equal(module.sourceMap.sha256, expectedMapSHA256, 'The loaded map differs from its pre-load input')
  assert.equal(hash(sourceMapBytes), expectedMapSHA256, 'The original external source map changed after loading')
  const map = JSON.parse(sourceMapBytes.toString())
  assert.equal(map.version, 3); assert.equal(map.file, basename(module.path))
  assert.ok(Array.isArray(map.sources) && map.sources.length > 0 && map.sources.every(source => typeof source === 'string'), 'The original map needs its actual source list')
  return { path: module.sourceMap.path, sha256: expectedMapSHA256 }
}
