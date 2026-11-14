import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCaptureSourcePin, pinnedSourceAfter } from './capture-source-pin.mjs'
import { createCssSourceOverlay } from './css-source-overlay.mjs'

const root = resolve(import.meta.dirname, '../../../../..'), revision = process.argv[2]
assert.ok(revision && process.argv.length === 3, 'Use verify-capture-source-pin.mjs <baseline-ref> with different physical CSS')
const require = createRequire(join(root, 'apps/desktop/package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp', 'amux-source-pin-check-'))
const moduleFile = join(root, 'packages/core/src/object-id.ts'), cssFile = join(root, 'apps/desktop/src/renderer/src/styles/collaboration.css')
try {
  await writeFile(join(temporary, 'entry.js'), `import * as original from ${JSON.stringify(moduleFile)}; import './entry.css'; globalThis.originalFixtureKeys=Object.keys(original);`)
  await writeFile(join(temporary, 'entry.css'), `@import ${JSON.stringify(cssFile)};`)
  async function compile(mode) {
    const pin = createCaptureSourcePin({ root, revision }), inputs = {}, cssBytes = await pin.read(cssFile)
    assert.notEqual(digest(cssBytes), digest(await readFile(cssFile)), 'CSS bypass control needs actually different Git and physical bytes')
    const css = await createCssSourceOverlay({ root, privateRoot: join(temporary, mode), overlays: new Map([[cssFile, cssBytes]]), sourcePin: pin, inputs, vitePackage: require.resolve('vite/package.json') })
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
    return { revision: pin.revision, inputs, products: pin.files, css: proof }
  }
  const original = await compile('original'), rejected = {}
  for (const mode of ['broken-js', 'broken-css']) {
    try { await compile(mode) } catch (error) { rejected[mode] = error.message }
    assert.ok(rejected[mode]?.includes(mode === 'broken-js' ? 'Actual Vite product input is not the pinned Git bytes' : 'Actual PostCSS input is not the declared source bytes'), 'The actual reader bypass must be rejected: ' + mode)
  }
  console.log(JSON.stringify({ passed: true, ...original, rejected, boundary: 'Tiny actual Vite JS and PostCSS import pipeline. Private adversarial JS reader and real physical-vs-Git CSS bypass. No shared source edits, Native, cost or aesthetic claim.' }))
} finally { await rm(temporary, { recursive: true, force: true }) }
