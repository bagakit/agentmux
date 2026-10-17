import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, extname, sep, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/agent-collaboration-graph')
assert.ok(process.argv[2] === '--evidence' && process.argv[3] && process.argv.length === 4, 'Use --evidence <new private evidence directory>')
const evidence = resolve(process.argv[3]); await mkdir(evidence, { recursive: true })
assert.equal((await readdir(evidence)).length, 0, 'Keep prior captures; use an empty evidence directory')
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-collaboration-capture-')), compiled = join(privateRoot, 'compiled')
const require = createRequire(join(desktop, 'package.json')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}, isolated = [], logs = []
const receipt = { schema: 'agentmux.collaboration-graph-capture.v1', capturedPass: false, captureOnly: true, aestheticReview: 'not-performed',
  boundary: 'Current source App, actual initialization/Store, Focus entry, Graph, shared Focus cards and sole AgentInformationPreviewHost/Reader. Only platform API facts and unrelated PTY/Monaco painting are controlled. Private synthetic identities, events and content; no Core/Provider/Runtime, real messages, restart or installed-product claim.' }
let server
try {
  const harnessFiles = ['index.html', 'entry.tsx', 'main.cjs'].map(name => join(fixture, name)).concat([new URL(import.meta.url).pathname, join(desktop, 'scripts/probe-process.mjs')])
  receipt.harness = Object.fromEntries(await Promise.all(harnessFiles.map(async file => [relative(root, file), hash(await readFile(file))])))
  const core = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(core.exports).map(([key, entry]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: resolve(root, 'packages/core', entry.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', root: fixture, worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
    resolve: { alias: aliases, conditions: ['browser', 'import', 'production', 'default'], dedupe: ['react', 'react-dom'] },
    build: { outDir: compiled, emptyOutDir: true, target: 'esnext', minify: false },
    plugins: [{ name: 'collaboration-source-and-unrelated-paint', enforce: 'pre', async transform(source, id) {
      if (!id.startsWith(root + sep) || id.includes('/node_modules/') || id.includes('?') || !/\.(tsx?|css|mjs)$/.test(id)) return
      sources[relative(root, id)] = hash(source)
      const component = id.slice(id.lastIndexOf('/') + 1)
      if (component === 'SessionPane.tsx') {
        isolated.push({ file: relative(root, id), boundary: 'Unrelated PTY/Agent painting only; original Store draft' })
        return `import{useAppStore}from${JSON.stringify(join(desktop, 'src/renderer/src/store.ts'))};export function SessionPane({sessionId}){const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return <section data-fixture-session={sessionId} style={{height:'100%',display:'flex',flexDirection:'column',gap:16,padding:24,color:'var(--text-2)'}}><small>Original Agent workface</small><strong style={{color:'var(--text)'}}>{sessionId}</strong><textarea aria-label="Original unsent reply" readOnly value={draft} style={{flex:1,minHeight:80,resize:'none',color:'var(--text)',background:'var(--surface-1)',border:'1px solid var(--line)',padding:16,borderRadius:8}}/></section>}`
      }
      if (component === 'EditorPane.tsx' || component === 'GitBranchDiffPane.tsx') {
        isolated.push({ file: relative(root, id), boundary: 'Unused Monaco painting; no file Region in scene' })
        return `export function ${component.slice(0, -4)}(){return null}`
      }
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + sep) && !file.includes('/node_modules/') && file.endsWith('.css')) sources[relative(root, file)] = hash(await readFile(file))
    } }] })
  receipt.inputs = sources; receipt.isolated = isolated
  for (const owner of ['App.tsx', 'GlobalFocusSurface.tsx', 'FocusToolbar.tsx', 'AgentCollaborationDialog.tsx', 'AgentCollaborationGraph.tsx', 'FocusContextCardBody.tsx', 'FocusContextRow.tsx', 'AgentInformationPreview.tsx', 'AgentInformationReader.tsx', 'store.ts', 'collaboration.css']) {
    assert.ok(Object.keys(sources).some(file => file.endsWith('/' + owner)), 'Actual owning module must compile: ' + owner)
  }
  receipt.outputs = {}
  async function recordOutputs(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await recordOutputs(file)
      else receipt.outputs[relative(compiled, file)] = hash(await readFile(file))
    }
  }
  await recordOutputs(compiled)
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' }
  server = createServer(async (request, response) => {
    try { const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.test').pathname)
      const file = resolve(compiled, pathname === '/' ? 'index.html' : pathname.slice(1)); assert.ok(file.startsWith(compiled + sep))
      const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); response.end(bytes)
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !/^(AGENTMUX_|CTXMUX_)/.test(key)))
  Object.assign(env, { AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') })
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), `http://127.0.0.1:${server.address().port}/`, privateRoot, evidence],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 100000, onLine: line => logs.push(line) })
  const actualText = await readFile(join(evidence, 'actual.json'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  if (actualText.trim()) receipt.actual = JSON.parse(actualText)
  assert.equal(receipt.process.timedOut, false, 'The original source capture timed out; retain its partial scene evidence')
  assert.equal(receipt.process.exitConfirmed, true, 'The original capture process exit is unconfirmed')
  assert.ok(receipt.actual, 'The original source capture did not publish scene evidence')
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  receipt.sourceAfter = Object.fromEntries(await Promise.all(Object.keys(sources).map(async file => [file, hash(await readFile(join(root, file)))])))
  receipt.harnessAfter = Object.fromEntries(await Promise.all(harnessFiles.map(async file => [relative(root, file), hash(await readFile(file))])))
  receipt.changedInputs = Object.keys(sources).filter(file => sources[file] !== receipt.sourceAfter[file])
  receipt.changedHarness = Object.keys(receipt.harness).filter(file => receipt.harness[file] !== receipt.harnessAfter[file])
  assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.actual.failures.map(({ name, message }) => ({ name, message })))); assert.equal(receipt.actual.passed, true)
  assert.equal(receipt.changedInputs.length, 0, 'Candidate changed during capture: ' + receipt.changedInputs.join(', '))
  assert.equal(receipt.changedHarness.length, 0, 'Capture harness changed during execution: ' + receipt.changedHarness.join(', '))
  receipt.capturedPass = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await new Promise(done => server ? server.close(done) : done())
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  let remaining = await listProbeProcesses(-1, privateRoot)
  if (remaining.length) { await stopProbeProcesses(-1, privateRoot); remaining = await listProbeProcesses(-1, privateRoot) }
  receipt.cleanup = { remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, pendingIndependentVisualReview: true }))
}
