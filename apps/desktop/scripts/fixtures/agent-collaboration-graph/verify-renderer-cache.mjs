import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCaptureSourcePin, captureResolverMetadata } from './capture-source-pin.mjs'
import { createCssSourceOverlay } from './css-source-overlay.mjs'
import { rendererCacheContext, loadRendererCache, saveRendererCache, rendererOutputHashes, clearRendererCache } from './renderer-cache.mjs'

const root = resolve(import.meta.dirname, '../../../../..'), revision = process.argv[2]
assert.ok(revision && process.argv.length === 3, 'Use verify-renderer-cache.mjs <immutable-ref>')
const require = createRequire(join(root, 'apps/desktop/package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp', 'amux-renderer-cache-check-')), privateRoot = join(temporary, 'compile'), cacheDirectory = join(temporary, 'cache')
const pin = createCaptureSourcePin({ root, revision }), inputs = {}, watchInputs = {}, source = join(root, 'packages/core/src/object-id.ts'), cssFile = join(root, 'apps/desktop/src/renderer/src/styles/collaboration.css')
try {
  await mkdir(privateRoot)
  const entry = join(temporary, 'entry.js'), entryCSS = join(temporary, 'entry.css')
  await writeFile(entry, `import * as original from ${JSON.stringify(source)}; import './entry.css'; globalThis.originalFixtureKeys=Object.keys(original);`)
  await writeFile(entryCSS, `@import ${JSON.stringify(cssFile)};`)
  const css = await createCssSourceOverlay({ root, privateRoot, overlays: new Map([[cssFile, await pin.read(cssFile)]]), sourcePin: pin, inputs, vitePackage: require.resolve('vite/package.json') })
  const product = { name: 'actual-cache-preflight-inputs', enforce: 'pre', async load(id) { if (pin.owns(id)) return (await pin.read(id)).toString('utf8') }, async transform(code, id) {
    if (!id.startsWith(root + '/') || !/\.(?:tsx?|js|css)$/.test(id)) return
    if (pin.owns(id)) assert.equal(digest(code), digest(await pin.read(id)))
    inputs[relative(root, id)] = digest(code)
  }, async generateBundle() {
    for (const watched of this.getWatchFiles()) {
      if (!isAbsolute(watched)) continue
      const file = await realpath(watched)
      if (file.startsWith(await realpath(privateRoot)) || !(await stat(file)).isFile() || pin.files[relative(root, file)]) continue
      watchInputs[file] = digest(await readFile(file))
    }
  } }
  const compiled = join(privateRoot, 'compiled')
  await build({ configFile: false, root: temporary, logLevel: 'silent', resolve: { alias: [{ find: '@agentmux/identity', replacement: join(root, 'packages/identity/src/index.ts') }] },
    plugins: [product, css.plugin], css: { postcss: { plugins: [css.observer] } }, build: { outDir: compiled, minify: false, rollupOptions: { input: entry } } })
  const metadata = await captureResolverMetadata(root), context = await rendererCacheContext({ root, revision: pin.revision, compilerFiles: [pathToFileURL(import.meta.filename).pathname, join(import.meta.dirname, 'capture-source-pin.mjs'), join(import.meta.dirname, 'css-source-overlay.mjs'), join(import.meta.dirname, 'renderer-cache.mjs')], metadata })
  const compilation = { phase: 'complete', inputs, watchInputs, sourceOverlay: { revision: pin.revision, files: pin.files }, foreignWorkspaceSources: {}, resolverMetadata: metadata, cssSourceProof: css.verify() }
  const outputs = await rendererOutputHashes(compiled)
  await saveRendererCache({ directory: cacheDirectory, context, compiled, compilation, compilationProcess: { exitCode: 0, exitConfirmed: true, timedOut: false, kind: 'actual-inline-vite-build-returned' }, outputs, evidence: relative(root, temporary), sourcePin: pin })
  const load = options => loadRendererCache({ directory: cacheDirectory, context, sourcePin: pin, ...options })
  assert.equal((await load()).reused, true)
  const rejected = {}
  await assert.rejects(load({ context: { ...context, revision: 'not-the-reader' } }), /declared Git reader/); rejected.contextReaderPin = true
  const manifestFile = join(cacheDirectory, 'manifest.json'), originalManifest = await readFile(manifestFile)
  async function badManifest(name, change, expected) {
    const changed = JSON.parse(originalManifest); change(changed)
    try { await writeFile(manifestFile, JSON.stringify(changed)); await assert.rejects(load(), expected); rejected[name] = true }
    finally { await writeFile(manifestFile, originalManifest) }
  }
  await badManifest('originalCompilationPin', manifest => { manifest.compilation.sourceOverlay.revision = 'not-the-compiler' }, /Original compilation/)
  await badManifest('missingFixtureCoverage', manifest => { delete manifest.compilation.watchInputs[entry] }, /Every consumed current fixture input/)
  await badManifest('missingGitCoverage', manifest => { delete manifest.compilation.sourceOverlay.files[relative(root, source)] }, /Every consumed product input/)
  const originalEntry = await readFile(entry)
  try { await writeFile(entry, Buffer.concat([originalEntry, Buffer.from('\n')])); assert.equal((await load()).reason, 'renderer-watch-input-changed'); rejected.fixtureBytes = true }
  finally { await writeFile(entry, originalEntry) }
  const outputFile = Object.keys(outputs).find(file => file.endsWith('.js')), outputPath = join(cacheDirectory, 'compiled', outputFile), originalOutput = await readFile(outputPath)
  try { await writeFile(outputPath, Buffer.concat([originalOutput, Buffer.from('\n')])); assert.equal((await load()).reason, 'compiled-output-changed'); rejected.compiledBytes = true }
  finally { await writeFile(outputPath, originalOutput) }
  assert.equal((await load({ context: { ...context, compiler: { ...context.compiler, observerMustNotPretendCompiler: 'changed' } } })).reason, 'compiler-ref-or-metadata-changed'); rejected.compilerContext = true
  assert.equal((await load()).reused, true)
  console.log(JSON.stringify({ passed: true, revision: pin.revision, actualViteBuilds: 1, inputs, watchInputs, outputs, rejected, restoredReuse: true, boundary: 'Tiny actual Vite JS/PostCSS renderer and local cache admission only. No App, Native interaction, cost or aesthetic claim. One transient cache is removed in finally.' }))
} finally {
  if ((await readdir(temporary)).includes('cache')) await clearRendererCache(cacheDirectory, root)
  await rm(temporary, { recursive: true, force: true })
}
