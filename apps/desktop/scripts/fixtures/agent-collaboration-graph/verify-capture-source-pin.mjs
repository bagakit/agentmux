import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCaptureSourcePin, pinnedSourceAfter } from './capture-source-pin.mjs'
import { createCssSourceOverlay } from './css-source-overlay.mjs'

const root = resolve(import.meta.dirname, '../../../../..'), revision = process.argv[2]
assert.ok(revision && (process.argv.length === 3 || process.argv.length === 4), 'Use verify-capture-source-pin.mjs <baseline-ref> [<project-stylesheet-path>] with different physical CSS')
const require = createRequire(join(root, 'apps/desktop/package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp', 'amux-source-pin-check-'))
const moduleFile = join(root, 'packages/core/src/object-id.ts'), cssFile = resolve(root, process.argv[3] ?? 'apps/desktop/src/renderer/src/styles/collaboration.css')
assert.ok(cssFile.startsWith(root + sep) && cssFile.endsWith('.css'), 'Select one stylesheet in the original project namespace')
const physicalBefore = digest(await readFile(cssFile)), mutations = []
let result
try {
  await writeFile(join(temporary, 'entry.js'), `import * as original from ${JSON.stringify(moduleFile)}; import './entry.css'; globalThis.originalFixtureKeys=Object.keys(original);`)
  await writeFile(join(temporary, 'entry.css'), `@import ${JSON.stringify(cssFile)};`)
  async function compile(mode) {
    const pin = createCaptureSourcePin({ root, revision }), inputs = {}, cssBytes = await pin.read(cssFile)
    assert.notEqual(digest(cssBytes), digest(await readFile(cssFile)), 'CSS bypass control needs actually different Git and physical bytes')
    const css = await createCssSourceOverlay({ root, privateRoot: join(temporary, mode), overlays: new Map([[cssFile, cssBytes]]), sourcePin: pin, inputs, vitePackage: require.resolve('vite/package.json') })
    const nested = Object.keys(pin.files).filter(file => file.endsWith('.css') && file !== relative(root, cssFile))
    if (mode === 'broken-nested') {
      assert.ok(nested.length, 'The nested reader control needs a real selected import dependency')
      const source = nested[0], file = join(temporary, mode, 'css-source-overlay', source), original = await pin.read(join(root, source))
      const wrong = Buffer.concat([original, Buffer.from('\n:root { --private-wrong-nested-source: 1; }\n')])
      await writeFile(file, wrong); mutations.push({ file, source, original, wrongSHA256: digest(wrong) })
    }
    const product = { name: 'actual-pinned-input', enforce: 'pre', async load(id) { if (pin.owns(id) && mode !== 'broken-js') return (await pin.read(id)).toString('utf8') }, async transform(source, id) {
      if (!pin.owns(id)) return
      assert.equal(digest(source), digest(await pin.read(id)), 'Actual Vite product input is not the pinned Git bytes')
      inputs[id.slice(root.length + 1)] = digest(source)
    } }
    const lateReader = { name: 'private-adversarial-reader', enforce: 'pre', async load(id) { if (id === moduleFile) return (await pin.read(id)).toString('utf8') + '\nexport const privateWrongSource = true;' } }
    await build({ configFile: false, root: temporary, logLevel: 'silent', resolve: { alias: [{ find: '@agentmux/identity', replacement: join(root, 'packages/identity/src/index.ts') }] },
      plugins: [product, lateReader, ...(mode === 'broken-css' ? [] : [css.plugin])], css: { postcss: { plugins: [css.observer] } },
      build: { write: false, minify: false, rollupOptions: { input: join(temporary, 'entry.js') } } })
    const proof = css.verify(), after = pinnedSourceAfter(root, pin, inputs)
    for (const [file, sha] of Object.entries(after)) assert.equal(sha, inputs[file])
    assert.equal(proof.loaded[cssFile.slice(root.length + 1)].origin, 'git-blob')
    for (const file of [...proof.mirroredImports.roots, ...proof.mirroredImports.edges.map(edge => edge.target)]) {
      const record = proof.loaded[file]
      assert.ok(record && pin.owns(join(root, file))); assert.equal(record.origin, 'git-blob')
      assert.equal(record.sourceSHA256, digest(await pin.read(join(root, file))))
      assert.ok(record.reads.every(read => read.mirror && read.namespace === 'private-original-byte-mirror' && read.actualSHA256 === record.sourceSHA256 && !read.rewrittenImports))
    }
    return { revision: pin.revision, inputs, products: pin.files, css: proof }
  }
  const original = await compile('original'), rejected = {}
  for (const mode of ['broken-js', 'broken-css', ...(original.css.mirroredImports.edges.length ? ['broken-nested'] : [])]) {
    try { await compile(mode) } catch (error) {
      const chain = []; for (let cause = error; cause && chain.length < 4; cause = cause.cause) chain.push({ name: cause.name, code: cause.code, message: cause.message })
      rejected[mode] = { message: error.message, chain }
    }
    const failure = rejected[mode], expected = mode === 'broken-js' ? ['Actual Vite product input is not the pinned Git bytes'] : mode === 'broken-css'
      ? ['Actual PostCSS input is not the declared source bytes', 'Baseline stylesheet bypassed its private original-byte mirror'] : ['Actual PostCSS input is not the declared source bytes']
    assert.ok(failure && expected.some(message => failure.message.includes(message)), 'The actual reader bypass must be rejected: ' + mode)
    assert.ok(failure.chain.some(cause => cause.name === 'AssertionError' || cause.code === 'ERR_ASSERTION'), 'A real reader assertion, not an environment or missing-module failure, must reject ' + mode)
  }
  const restoredMutations = []
  for (const mutation of mutations) { await writeFile(mutation.file, mutation.original); assert.equal(digest(await readFile(mutation.file)), digest(mutation.original)); restoredMutations.push({ source: mutation.source, wrongSHA256: mutation.wrongSHA256, restoredSHA256: digest(mutation.original) }) }
  const restored = await compile('restored')
  assert.deepEqual(restored.inputs, original.inputs); assert.equal(digest(await readFile(cssFile)), physicalBefore)
  result = { passed: true, ...original, rejected, restored: { inputs: restored.inputs, mutations: restoredMutations },
    harness: Object.fromEntries(await Promise.all([import.meta.filename, join(import.meta.dirname, 'css-source-overlay.mjs'), join(import.meta.dirname, 'capture-source-pin.mjs')].map(async file => [relative(root, file), digest(await readFile(file))]))),
    temporary, boundary: 'Tiny actual Vite JS and nested PostCSS FS import pipeline. Every mirrored import retains Git raw bytes/text/namespace; private wrong nested bytes and real reader bypasses must assert RED, then restore GREEN. No shared source edits, Native, cost or aesthetic claim.' }
} finally { await rm(temporary, { recursive: true, force: true }); if (result) result.cleanup = { removed: true } }
console.log(JSON.stringify(result))
