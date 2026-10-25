import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { runProbeProcess } from './probe-process.mjs'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'
import { radixOverlayAliases } from './radix-overlay-aliases.ts'

const root = resolve(import.meta.dirname, '../../..'), fixture = join(import.meta.dirname, 'fixtures/form-dialog-craft')
const evidence = process.env.AGENTMUX_EVIDENCE_ROOT ?? join(root, '.tmp/form-dialog-native', randomUUID())
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), require = createRequire(import.meta.url)
const owning = (await loadConfigFromFile({ command: 'build', mode: 'production' }, join(root, 'apps/desktop/test/vitest.ui-controls-owning.config.mts'))).config
const result = { schema: 'agentmux.form-dialog-capture.v1', passed: false, aestheticReview: 'independent-review-pending', userRuntimeTouched: false, rounds: [] }
const mutation = { file: 'apps/desktop/src/renderer/src/styles/project-groups.css', before: '.project-group-dialog { --dialog-width: 480px; }', after: '.project-group-dialog { width: min(480px, calc(100vw - 32px)); }' }
async function compile(label) {
 const directory = join(evidence, label), outDir = join(directory, 'out'), isolated = {}, nodeExternals = [], workerAssets = {}
 await mkdir(outDir, { recursive: true })
 const esbuild = createRequire(require.resolve('vite'))('esbuild')
 const aliases = [...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement })), ...owning.resolve.alias]
 const output = await esbuild.build({ absWorkingDir: root, entryPoints: [join(fixture, 'entry.tsx')], outfile: join(outDir, 'entry.js'), bundle: true,
  format: 'esm', platform: 'browser', jsx: 'automatic', target: 'chrome130', metafile: true, treeShaking: true,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.gif': 'file', '.jpg': 'file', '.jpeg': 'file', '.webp': 'file', '.wasm': 'file', '.html': 'text' }, logLevel: 'silent',
  plugins: [{ name: 'original-form-source-boundaries', setup(builder) {
   builder.onResolve({ filter: /\?(?:worker|url)$/ }, async entry => {
    const kind = entry.path.endsWith('?worker') ? 'worker' : 'url', specifier = entry.path.replace(/\?(?:worker|url)$/, '')
    const target = await builder.resolve(specifier, { resolveDir: entry.resolveDir, kind: entry.kind }); if (target.errors.length) return target
    workerAssets[relative(root, target.path)] = { kind, sha256: sha(await readFile(target.path)) }; return { path: target.path, namespace: kind === 'worker' ? 'unused-worker' : 'recorded-url' }
   })
   builder.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: "export default class UnusedFormWorker { constructor(){throw Error('Worker rendering is outside this form-only proof.')} }", loader: 'js' }))
   builder.onLoad({ filter: /.*/, namespace: 'recorded-url' }, async entry => ({ contents: await readFile(entry.path), loader: 'file' }))
   builder.onResolve({ filter: /^node:/ }, entry => { nodeExternals.push(entry.path); return { path: entry.path, namespace: 'unconsumed-node' } })
   builder.onLoad({ filter: /.*/, namespace: 'unconsumed-node' }, () => ({ contents: 'module.exports = {}', loader: 'js' }))
   builder.onResolve({ filter: /.*/ }, async entry => {
    if (entry.path.startsWith('.') && entry.importer) {
     const file = resolve(dirname(entry.importer), entry.path).replace(/\.tsx$/, ''), name = file.split('/').at(-1)
     if (['DiagramFilePreview', 'DotFilePreview', 'DrawioFilePreview', 'ExcalidrawFilePreview'].includes(name) && file.startsWith(join(root, 'apps/desktop/src/renderer/src/components/file-preview/'))) {
      isolated[relative(root, file + '.tsx')] = sha(await readFile(file + '.tsx')); return { path: name, namespace: 'unused-preview' }
     }
    }
    for (const alias of aliases) {
     const matches = typeof alias.find === 'string' ? entry.path === alias.find || entry.path.startsWith(alias.find + '/') : alias.find.test(entry.path)
     if (!matches) continue
     const target = typeof alias.find === 'string' ? alias.replacement + entry.path.slice(alias.find.length) : entry.path.replace(alias.find, alias.replacement)
     return await builder.resolve(target, { resolveDir: entry.resolveDir, kind: entry.kind })
    }
   })
   builder.onLoad({ filter: /.*/, namespace: 'unused-preview' }, entry => ({ contents: `export function ${entry.path}(){throw Error('This form-only proof does not cover diagram rendering.')}`, loader: 'js' }))
  } }] })
 await writeFile(join(outDir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>')
 const loaded = {}, styles = {}, compiled = {}
 for (const file of Object.keys(output.metafile.inputs)) if (!file.includes(':')) {
  const absolute = resolve(root, file), name = relative(root, absolute)
  if (name.startsWith('node_modules/') || name.includes('/node_modules/')) continue
  const digest = sha(await readFile(absolute)); if (name.endsWith('.css')) styles[name] = digest; else loaded[name] = digest
 }
 for (const file of ['ProjectGroupDialog', 'HostFolderDialog', 'TopicCategoryDialog', 'MoteRenameDialog', 'BrowserViewportControls']) assert.ok(loaded[`apps/desktop/src/renderer/src/components/${file}.tsx`], 'Actual product component compiled: ' + file)
 for (const file of ['overlays', 'project-groups', 'topic-knowledge', 'browser']) assert.ok(styles[`apps/desktop/src/renderer/src/styles/${file}.css`], 'Actual stylesheet imported: ' + file)
 for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const file = join(entry.parentPath, entry.name); compiled[relative(outDir, file)] = sha(await readFile(file)) }
 const identity = { loaded, styles, compiled, isolated, workerAssets, nodeExternals: [...new Set(nodeExternals)],
  isolationBoundary: 'Unused diagram previews and browser-unavailable Node builtin modules are isolated as explicit fixture boundaries. Actual forms, shared Modal/provider, Store and browser Core remain compiled. No Node filesystem, runtime process, diagram renderer or installed application is claimed.' }
 await writeFile(join(directory, 'inputs.json'), JSON.stringify(identity, null, 2)); return { directory, outDir, identity }
}
async function run(candidate, label, expectRed) {
 const directory = join(evidence, label); await mkdir(directory, { recursive: true })
 const paths = { userData: join(directory, 'profile'), runtimeRoot: join(directory, 'runtime'), readyFile: join(directory, 'unused-ready.json') }
 const env = privatePackageSmokeEnvironment(process.env, paths); for (const path of [env.HOME, env.TMPDIR]) await mkdir(path, { recursive: true })
 const lines = [], processReceipt = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(candidate.outDir, 'index.html'), directory, label], { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => lines.push(line) })
 await writeFile(join(directory, 'process.log'), lines.join('\n')); const rendered = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
 assert.equal(processReceipt.timedOut, false); assert.equal(processReceipt.exitCode, expectRed ? 1 : 0, rendered.failure?.message)
 if (expectRed) { assert.equal(rendered.failure?.name, 'AssertionError'); assert.match(rendered.failure.message, /Declared dialog width survives/) } else assert.equal(rendered.passed, true)
 result.rounds.push({ label, directory, inputs: join(candidate.directory, 'inputs.json'), processReceipt, rendered }); return rendered
}
try {
 const reuse = process.argv.indexOf('--reuse-build')
 const directory = reuse >= 0 ? resolve(process.argv[reuse + 1]) : null
 const original = directory ? { directory, outDir: join(directory, 'out'), identity: JSON.parse(await readFile(join(directory, 'inputs.json'), 'utf8')) } : await compile('candidate-build')
 for (const [file, digest] of Object.entries(original.identity.compiled)) assert.equal(sha(await readFile(join(original.outDir, file))), digest, 'Reuse retains exact compiled bytes')
 await run(original, 'candidate', false)
 if (!process.argv.includes('--candidate-only')) {
  // The only mutation is a source-qualified declaration in the actually imported CSS.
  // Reuse the exact JS candidate; remapping the compiled rule avoids rebuilding unrelated code.
  const directory = join(evidence, 'width-regression-build'), outDir = join(directory, 'out')
  await mkdir(directory, { recursive: true }); await cp(original.outDir, outDir, { recursive: true })
  const source = await readFile(join(root, mutation.file), 'utf8'); assert.equal(source.split(mutation.before).length, 2)
  const changedSource = source.replace(mutation.before, mutation.after), postcss = createRequire(require.resolve('vite'))('postcss')
  const replacement = postcss.parse(mutation.after).nodes[0].nodes[0]
  const changes = []
  for (const file of Object.keys(original.identity.compiled).filter(file => file.endsWith('.css'))) {
   const path = join(outDir, file), originalCss = await readFile(path, 'utf8'), ast = postcss.parse(originalCss)
   ast.walkRules('.project-group-dialog', rule => rule.walkDecls('--dialog-width', decl => {
    assert.equal(decl.value, '480px'); decl.prop = replacement.prop; decl.value = replacement.value
    changes.push({ file: mutation.file, sourceSHA256: sha(source), sourceMutationSHA256: sha(changedSource), compiledFile: file, compiledBeforeSHA256: sha(originalCss) })
   }))
   if (changes.some(change => change.compiledFile === file)) { const css = ast.toString(); await writeFile(path, css); changes.at(-1).compiledAfterSHA256 = sha(css) }
  }
  assert.equal(changes.length, 1, 'One original source declaration maps to one actual loaded CSS rule')
  for (const [file, digest] of Object.entries(original.identity.compiled).filter(([file]) => !file.endsWith('.css'))) assert.equal(sha(await readFile(join(outDir, file))), digest, 'The exact compiled JS and assets are reused')
  await writeFile(join(directory, 'inputs.json'), JSON.stringify({ ...original.identity, changes, mutationBoundary: 'Source-qualified compiled CSS declaration only; unchanged original JS and assets.' }, null, 2))
  await run({ directory, outDir }, 'width-regression', true); await run(original, 'restore', false); await rm(outDir, { recursive: true })
 }
 for (const [file, digest] of Object.entries(original.identity.loaded)) assert.equal(sha(await readFile(join(root, file))), digest, 'Original product source unchanged: ' + file)
 await rm(original.outDir, { recursive: true }); result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2)); assert.equal(result.passed, true, result.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json'), screenshots: result.rounds[0].rendered.screenshots.length }))
