import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from '../../probe-process.mjs'
import { createCssSourceOverlay } from './css-source-overlay.mjs'

const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..'), desktop = join(root, 'apps/desktop')
assert.ok(process.argv.length === 3, 'Use capture-shared-motion.mjs <empty-evidence-directory>')
const evidence = resolve(process.argv[2]), privateRoot = await mkdtemp(join(tmpdir(), 'amux-shared-motion-')), compiled = join(privateRoot, 'compiled')
await mkdir(evidence, { recursive: true }); assert.equal((await readdir(evidence)).length, 0)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), require = createRequire(join(desktop, 'package.json'))
const receipt = { schema: 'agentmux.shared-motion-capture.v1', captureOnly: true, aestheticReview: 'not-performed', inputs: {}, outputs: {}, sourceOverlay: {}, frames: [],
  boundary: 'Bounded original shared production components and CSS/theme runtime; controlled typed requests/receipts/clipboard adapter. Not App initialization, real Provider execution, live Run, public CLI, mounted Terminal, durability or installation.' }
let server
try {
  const ref = process.env.COLLABORATION_CAPTURE_SOURCE_REF, overlays = new Map()
  receipt.sourceRevision = ref ? execFileSync('git', ['rev-parse', ref + '^{commit}'], { cwd: root, encoding: 'utf8' }).trim() : null
  if (ref) for (const file of execFileSync('git', ['diff', '--name-only', '--diff-filter=M', receipt.sourceRevision, '--', 'packages/client-ui/src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(file => /\.(?:tsx?|css)$/.test(file))) {
    const bytes = execFileSync('git', ['show', receipt.sourceRevision + ':' + file], { cwd: root }), stored = join('source-overlay', file)
    await mkdir(join(evidence, stored, '..'), { recursive: true }); await writeFile(join(evidence, stored), bytes); overlays.set(join(root, file), bytes)
    receipt.sourceOverlay[file] = { file: stored, sha256: hash(bytes), gitObject: execFileSync('git', ['rev-parse', receipt.sourceRevision + ':' + file], { cwd: root, encoding: 'utf8' }).trim() }
  }
  const aliases = []
  for (const name of ['core', 'client-ui']) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json')))
    for (const [key, entry] of Object.entries(manifest.exports).sort(([first], [second]) => Number(first.includes('*')) - Number(second.includes('*')) || second.length - first.length)) {
      const target = typeof entry === 'string' ? entry : name === 'core' ? entry.import : entry.browser ?? entry.types ?? entry.import
      const source = name === 'core' ? target.replace('./dist/', './src/').replace(/\.js$/, '.ts') : target
      const specifier = '@agentmux/' + name + (key === '.' ? '' : key.slice(1)), pattern = specifier.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
      aliases.push({ find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages', name, source).replace('*', '$1') })
    }
  }
  receipt.harness = Object.fromEntries(await Promise.all(['capture-shared-motion.mjs', 'shared-motion.html', 'shared-motion.tsx', 'shared-motion-main.cjs', 'css-source-overlay.mjs'].map(async file => [file, hash(await readFile(join(fixture, file)))])))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const sourcePlugin = { name: 'shared-motion-source-bytes', enforce: 'pre', load(id) { if (!id.includes('?') && overlays.has(id)) return overlays.get(id).toString('utf8') }, transform(source, id) { if (id.startsWith(root + '/') && !id.includes('/node_modules/') && !id.includes('?') && /\.(?:tsx?|jsx?|css)$/.test(id)) receipt.inputs[relative(root, id)] = hash(source) } }
  const css = await createCssSourceOverlay({ root, privateRoot, overlays, inputs: receipt.inputs, vitePackage: require.resolve('vite/package.json') })
  await build({ configFile: false, root: fixture, logLevel: 'error', worker: { format: 'es', plugins: () => [sourcePlugin, css.plugin] }, css: { postcss: { plugins: [css.observer] } }, esbuild: { jsx: 'automatic' }, resolve: { alias: aliases, conditions: ['browser', 'import', 'production', 'default'], dedupe: ['react', 'react-dom'] },
    build: { outDir: compiled, target: 'esnext', minify: false, rollupOptions: { input: join(fixture, 'shared-motion.html') } },
    plugins: [sourcePlugin, css.plugin] })
  receipt.cssSourceProof = { ...css.verify(), outputs: {} }
  async function outputs(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = join(directory, entry.name); if (entry.isDirectory()) await outputs(file); else { const bytes = await readFile(file); receipt.outputs[relative(compiled, file)] = hash(bytes); if (file.endsWith('.css')) receipt.cssSourceProof.outputs[relative(compiled, file)] = css.emitted(bytes) } } }
  await outputs(compiled)
  server = createServer(async (request, response) => { try { const file = resolve(compiled, '.' + new URL(request.url, 'http://fixture.test').pathname); assert.ok(file.startsWith(compiled + '/')); response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file)) } catch { response.writeHead(404); response.end() } })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'shared-motion-main.cjs'), `http://127.0.0.1:${server.address().port}/shared-motion.html`, privateRoot, evidence], { temporaryRoot: privateRoot, env, cwd: root, timeoutMs: 90000 })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json')))
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  receipt.changedInputs = []
  for (const [file, digest] of Object.entries(receipt.inputs)) if (hash(await readFile(receipt.sourceOverlay[file] ? join(evidence, receipt.sourceOverlay[file].file) : join(root, file))) !== digest) receipt.changedInputs.push(file)
  receipt.changedHarness = []
  for (const [file, digest] of Object.entries(receipt.harness)) if (hash(await readFile(join(fixture, file))) !== digest) receipt.changedHarness.push(file)
  assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.actual.failure)); assert.equal(receipt.process.exitConfirmed, true); assert.equal(receipt.process.timedOut, false)
  assert.deepEqual(receipt.changedInputs, []); assert.deepEqual(receipt.changedHarness, []); assert.equal(receipt.actual.passed, true)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await new Promise(done => server ? server.close(done) : done())
  let remaining = await listProbeProcesses(-1, privateRoot)
  if (remaining.length) { await stopProbeProcesses(-1, privateRoot); remaining = await listProbeProcesses(-1, privateRoot) }
  receipt.cleanup = { remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed ?? false, failure: receipt.failure?.message, evidence, aestheticReview: 'not-performed' }))
}
