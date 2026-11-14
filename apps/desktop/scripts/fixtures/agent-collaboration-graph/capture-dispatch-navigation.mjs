import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, extname } from 'node:path'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from '../../probe-process.mjs'

const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..'), desktop = join(root, 'apps/desktop')
assert.equal(process.argv.length, 3, 'Use capture-dispatch-navigation.mjs <empty-evidence-directory>')
assert.equal(process.env.COLLABORATION_CAPTURE_SOURCE_REF, undefined, 'Public navigation joins the actual candidate source, not a baseline overlay')
const evidence = resolve(process.argv[2]), privateRoot = await mkdtemp(join(tmpdir(), 'amux-collaboration-capture-')), compiled = join(privateRoot, 'compiled')
await mkdir(evidence, { recursive: true }); assert.equal((await readdir(evidence)).length, 0)
const require = createRequire(join(desktop, 'package.json')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
Object.assign(env, { COLLABORATION_CAPTURE_NODE: process.execPath, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') })
const receipt = { schema: 'agentmux.dispatch-navigation-capture.v1', captureOnly: true, aestheticReview: 'not-performed',
  boundary: 'Original App/Store and isolated source Core public server/source CLI app.focus/app.inspect via existing server-host and App admission callback. No installed App, user focus, live Provider, Run lifecycle or restart.' }
let server
try {
  receipt.harness = Object.fromEntries(await Promise.all(['capture-dispatch-navigation.mjs', 'dispatch-navigation-main.cjs', 'entry.tsx', 'server-host.mjs'].map(async file => [file, hash(await readFile(join(fixture, file)))])))
  receipt.compilationProcess = await runProbeProcess(process.execPath, [join(desktop, 'scripts/capture-agent-collaboration-graph.mjs'), '--compile', privateRoot, evidence, '--scenario', 'dispatch-motion'], { temporaryRoot: privateRoot, env, cwd: root, timeoutMs: 120000 })
  receipt.compilation = JSON.parse(await readFile(join(evidence, 'compilation.json')))
  assert.equal(receipt.compilation.phase, 'complete'); assert.equal(receipt.compilationProcess.exitCode, 0); assert.equal(receipt.compilationProcess.exitConfirmed, true)
  receipt.outputs = {}
  async function outputs(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = join(directory, entry.name); if (entry.isDirectory()) await outputs(file); else receipt.outputs[relative(compiled, file)] = hash(await readFile(file)) } }
  await outputs(compiled)
  server = createServer(async (request, response) => { try { const file = resolve(compiled, '.' + new URL(request.url, 'http://fixture.test').pathname); assert.ok(file.startsWith(compiled + '/')); response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file)) } catch { response.writeHead(404); response.end() } })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'dispatch-navigation-main.cjs'), `http://127.0.0.1:${server.address().port}/index.html?scenario=dispatch-motion`, privateRoot, evidence], { temporaryRoot: privateRoot, env, cwd: root, timeoutMs: 90000 })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json')))
  receipt.controlInputs = (await readFile(join(evidence, 'control-loaded.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const name of ['packages/core/src/public-rpc-server.ts', 'packages/core/src/agentmux-cli-commands.ts']) assert.ok(receipt.controlInputs.some(input => input.path === name))
  for (const input of receipt.controlInputs) assert.equal(input.originalSHA256, input.effectiveSHA256)
  receipt.changedInputs = []
  for (const [file, digest] of Object.entries(receipt.compilation.inputs)) if (hash(await readFile(join(root, file))) !== digest) receipt.changedInputs.push(file)
  receipt.changedHarness = []
  for (const [file, digest] of Object.entries(receipt.harness)) if (hash(await readFile(join(fixture, file))) !== digest) receipt.changedHarness.push(file)
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.actual.failure)); assert.equal(receipt.process.exitConfirmed, true); assert.equal(receipt.process.timedOut, false); assert.equal(receipt.actual.passed, true)
  assert.deepEqual(receipt.changedInputs, []); assert.deepEqual(receipt.changedHarness, [])
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await new Promise(done => server ? server.close(done) : done())
  let remaining = await listProbeProcesses(-1, privateRoot)
  if (remaining.length) { await stopProbeProcesses(-1, privateRoot); remaining = await listProbeProcesses(-1, privateRoot) }
  receipt.cleanup = { remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed ?? false, failure: receipt.failure?.message, evidence }))
}
