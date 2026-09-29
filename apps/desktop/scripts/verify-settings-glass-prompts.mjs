import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const fixture = path.join(root, 'apps/desktop/scripts/fixtures/settings-prompts')
const defaultOutput = '.bagakit/design/settings-glass-prompts/evidence'
const outputIndex = args.indexOf('--output')
const evidence = path.resolve(root, outputIndex >= 0 ? args[outputIndex + 1] : defaultOutput)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const owned = /(?:\/App\.tsx|\/SettingsPanel\.tsx|\/settings\/[^/]+\.(?:tsx|ts)|\/settings\/modules\/[^/]+\.tsx|\/styles\/[^/]+\.css|\/fixtures\/settings-(?:prompts|liquid-motion|keyboard-shortcuts)\/[^/]+)$/

async function files(directory, prefix = '') {
  const result = []
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const file = path.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await files(directory, file))
    else { const bytes = await fs.readFile(path.join(directory, file)); result.push({ file, bytes: bytes.length, sha256: hash(bytes) }) }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file))
}

// Independent review consumes the immutable capture. A later formal gate may
// reuse it only while every consumed source, asset, compiled file and raw proof
// still matches; a changed input requires a fresh actual Renderer run.
async function reviewedProof(directory) {
  try {
    await fs.access(path.join(directory, 'independent-visual-review.md'))
    const receipt = JSON.parse(await fs.readFile(path.join(directory, 'receipt.json'), 'utf8'))
    assert.equal(receipt.completed, true)
    assert.deepEqual(receipt.processes.map(process => process.mode), ['control', 'reread', 'reread-empty'])
    assert.equal(new Set(receipt.processes.map(process => process.pid)).size, 3)
    assert.ok(Object.keys(receipt.source).length > 0 && receipt.png.length > 0 && receipt.raw.length === 6)
    for (const [file, record] of Object.entries(receipt.source)) assert.equal(hash(await fs.readFile(path.join(root, file))), record.sha256)
    for (const record of receipt.assets) assert.equal(hash(await fs.readFile(path.join(root, record.file))), record.sha256)
    assert.deepEqual(await files(path.join(directory, 'compiled')), receipt.compiled)
    assert.equal(hash(await fs.readFile(path.join(directory, 'owner.mjs'))), receipt.ownerCompiled.sha256)
    for (const record of [...receipt.png, ...receipt.raw]) assert.equal(hash(await fs.readFile(path.join(directory, record.file))), record.sha256)
    return receipt
  } catch { return null }
}

export async function qualify(directory, materialsOnly = false, preview = false, options = {}) {
  await fs.mkdir(directory, { recursive: true })
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-settings-prompts-'))
  const receipt = { captureOnly: true, aestheticReview: 'not-performed', boundary: 'Actual App Renderer; private IPC ConfigOwner/ConfigStore seam; no user config, Runtime, Run, native activation or installation. CSS reduced preferences are emulated known signals, not OS bridge facts.', source: {}, assets: [], compiled: [], processes: [], privateRoot }
  const inputs = new Map()
  const originalInputs = new Map()
  const consumedSource = async (filename, code) => {
    const override = options.sourceOverrides?.[path.relative(root, filename)]
    if (!override) return code
    assert.equal(hash(code), override.originalSha256, 'Private Source mutation consumes its exact original: ' + filename)
    originalInputs.set(path.relative(root, filename), { sha256: hash(code), bytes: Buffer.byteLength(code) })
    const changed = await fs.readFile(override.file, 'utf8')
    assert.notEqual(hash(changed), hash(code), 'Private Source mutation is nonempty')
    assert.equal(hash(changed), override.sha256, 'Private Source mutation bytes are qualified')
    return changed
  }
  const bind = async (filename, bytes) => {
    if (!filename.startsWith(root + '/') || filename.includes('/node_modules/')) return
    const relative = path.relative(root, filename), record = { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }
    if (inputs.has(relative)) assert.equal(inputs.get(relative).sha256, record.sha256, 'Input drift while building: ' + relative)
    inputs.set(relative, record)
    if (options.preserveAllSources || owned.test(filename)) {
      const target = path.join(directory, 'source', relative)
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes)
    }
  }
  try {
    const viteFile = require.resolve('vite')
    const { build, loadConfigFromFile } = await import(pathToFileURL(viteFile).href)
    const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(fixture, 'vitest.config.mts'), root)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'warn', resolve: config.resolve, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
      plugins: [{ name: 'bind-proof-source', enforce: 'pre', async transform(code, id) {
        const filename = id.split('?')[0]
        if (/\.(png|svg|jpe?g|webp|woff2?|ttf)$/.test(filename)) {
          if (filename.startsWith(root + '/')) { const bytes = await fs.readFile(filename); receipt.assets.push({ file: path.relative(root, filename), bytes: bytes.length, sha256: hash(bytes) }) }
        } else {
          const consumed = await consumedSource(filename, code)
          await bind(filename, consumed)
          if (consumed !== code) return { code: consumed, map: null }
        }
      } }],
      css: { postcss: { plugins: [{ postcssPlugin: 'bind-proof-css', async OnceExit(tree) {
        const sources = new Map(); tree.walk(node => { if (node.source?.input?.file) sources.set(node.source.input.file, node.source.input.css) })
        for (const [filename, source] of sources) await bind(filename, source)
      } }] } }, build: { target: 'esnext', outDir: path.join(directory, 'compiled'), emptyOutDir: true, minify: false, rollupOptions: { onwarn(warning, report) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') report(warning) } } } })
    const viteRequire = createRequire(viteFile)
    const { build: bundle } = await import(pathToFileURL(viteRequire.resolve('esbuild')).href)
    const exports = JSON.parse(await fs.readFile(path.join(root, 'packages/core/package.json'), 'utf8')).exports
    const core = Object.fromEntries(Object.entries(exports).map(([key, value]) => ['@agentmux/core' + (key === '.' ? '' : key.slice(1)), path.join(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))]))
    await bundle({ entryPoints: [path.join(fixture, 'owner-entry.ts')], outfile: path.join(directory, 'owner.mjs'), platform: 'node', format: 'esm', banner: { js: "import { createRequire as proofCreateRequire } from 'node:module'; const require = proofCreateRequire(import.meta.url);" }, bundle: true, external: ['electron'], alias: core, plugins: [{ name: 'bind-main-owner-source', setup(api) {
      api.onLoad({ filter: /\.[cm]?[jt]s$/ }, async event => {
        if (!event.path.startsWith(root + '/') || event.path.includes('/node_modules/')) return
        const contents = await fs.readFile(event.path, 'utf8'); await bind(event.path, contents)
        return { contents, loader: event.path.endsWith('.ts') ? 'ts' : 'js' }
      })
    } }] })
    for (const filename of ['main.cjs', 'preload.cjs', 'index.html', 'vitest.config.mts']) await bind(path.join(fixture, filename), await fs.readFile(path.join(fixture, filename)))
    await bind(fileURLToPath(import.meta.url), await fs.readFile(fileURLToPath(import.meta.url)))
    for (const filename of options.sources ?? []) await bind(path.resolve(root, filename), await fs.readFile(path.resolve(root, filename)))
    receipt.source = Object.fromEntries([...inputs].sort((a, b) => a[0].localeCompare(b[0])))
    receipt.originalInputs = Object.fromEntries(originalInputs)
    assert.ok(Object.keys(receipt.source).length > 0, 'Source binding must not be empty')
    receipt.sourceIdentity = hash(JSON.stringify(receipt.source))
    receipt.compiled = await files(path.join(directory, 'compiled'))
    receipt.ownerCompiled = { sha256: hash(await fs.readFile(path.join(directory, 'owner.mjs'))) }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    for (const mode of options.modes ?? (materialsOnly ? ['materials'] : preview ? ['preview'] : ['control', 'reread', 'reread-empty'])) {
      const lines = []
      const processResult = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(directory, 'compiled/index.html'), path.join(directory, 'owner.mjs'), privateRoot, directory, mode],
        { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90000, onLine: line => lines.push(line) })
      await fs.writeFile(path.join(directory, `${mode}.log`), lines.join('\n'))
      const result = JSON.parse(await fs.readFile(path.join(directory, `${mode}.json`), 'utf8'))
      receipt.processes.push({ ...processResult, mode, pid: result.pid, completed: result.completed, failure: result.failure, frames: result.frames.map(frame => frame.file) })
      assert.equal(processResult.exitCode, 0, JSON.stringify(result.failure || processResult))
      assert.equal(result.completed, true)
    }
    if (!options.modes && !materialsOnly && !preview) assert.equal(new Set(receipt.processes.map(p => p.pid)).size, 3, 'Three ordinary processes must read the same private durable store')
    receipt.originalInputs = Object.fromEntries(originalInputs)
    for (const [relative, consumed] of inputs) assert.equal(hash(await fs.readFile(path.join(root, relative))), (originalInputs.get(relative) ?? consumed).sha256, 'Proof input changed: ' + relative)
    receipt.png = (await files(directory)).filter(record => record.file.endsWith('.png') && !record.file.startsWith('compiled/'))
    const modes = new Set(receipt.processes.map(process => process.mode))
    receipt.raw = (await files(directory)).filter(record => modes.has(record.file.replace(/\.(json|log)$/, '')) && /\.(json|log)$/.test(record.file))
    receipt.completed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    receipt.remainingPrivateProcesses = await listProbeProcesses(-1, privateRoot)
    await fs.rm(privateRoot, { recursive: true, force: true }); receipt.privateRootRemoved = true
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2))
  }
  return receipt
}

async function main() {
if (args.includes('--materials-mutant')) {
  const sourcePath = path.join(root, 'apps/desktop/src/renderer/src/styles/settings-materials.css')
  const original = await fs.readFile(sourcePath, 'utf8')
  const footerPath = path.join(root, 'apps/desktop/src/renderer/src/styles/settings-prompts.css')
  const originalFooter = await fs.readFile(footerPath, 'utf8')
  const directory = path.join(evidence, 'material-mutations'), results = []
  const control = await qualify(path.join(directory, 'control'), true); assert.ok(control.completed, JSON.stringify(control.failure))
  const variants = [
    ['remove-functional-material', sourcePath, original, original.replaceAll('blur(var(--material-control-blur)) saturate(1.12)', 'none')],
    ['ignore-reduced-transparency', sourcePath, original, original.replace('(prefers-reduced-transparency: reduce), (prefers-contrast: more)', '(width: 0px), (prefers-contrast: more)')],
    ['detach-library-save-facts', footerPath, originalFooter, originalFooter.replace('.prompt-save-footer { position: sticky;', '.prompt-save-footer { position: static;')]
  ]
  try {
    for (const [name, file, pristine, mutated] of variants) {
      assert.notEqual(mutated, pristine, 'Nonempty actual owning Source mutation')
      assert.equal(hash(await fs.readFile(file)), hash(pristine), 'Only pristine owned Source enters mutation')
      await fs.writeFile(file, mutated)
      const result = await qualify(path.join(directory, name), true)
      const raw = JSON.parse(await fs.readFile(path.join(directory, name, 'materials.json'), 'utf8'))
      assert.equal(result.completed, undefined); assert.equal(raw.failure?.name, 'AssertionError', 'Source mutant must hit actual Chromium assertion, not compilation/setup failure')
      results.push({ name, sha256: hash(mutated), result: 'AssertionRED', failure: raw.failure })
      assert.equal(hash(await fs.readFile(file)), hash(mutated), 'Never overwrite an unexpected concurrent edit')
      await fs.writeFile(file, pristine)
    }
  } finally {
    for (const [, file, pristine, mutated] of variants) {
      if (hash(await fs.readFile(file)) === hash(mutated)) await fs.writeFile(file, pristine)
    }
  }
  const restored = await qualify(path.join(directory, 'restored'), true); assert.ok(restored.completed, JSON.stringify(restored.failure))
  await fs.writeFile(path.join(directory, 'mutation-receipt.json'), JSON.stringify({ sourcePath: path.relative(root, sourcePath), originalSha256: hash(original), control: control.sourceIdentity, mutations: results, restored: restored.sourceIdentity, exactRestore: hash(await fs.readFile(sourcePath)) === hash(original) }, null, 2))
  console.log(JSON.stringify({ materials: 'PASS', owningMutants: results.length, directory }))
} else {
  const existing = !args.includes('--materials-only') && !args.includes('--preview') ? await reviewedProof(evidence) : null
  const receipt = existing ?? await qualify(evidence, args.includes('--materials-only'), args.includes('--preview'))
  console.log(JSON.stringify({ evidence, completed: receipt.completed, sourceIdentity: receipt.sourceIdentity, frames: receipt.png?.length, reusedSourceBoundProof: !!existing, failure: receipt.failure }))
  if (!receipt.completed) process.exitCode = 1
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
