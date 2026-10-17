import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { runProbeProcess, stopProbeProcesses } from '../../probe-process.mjs'
import { candidateExport } from './candidate-export.mjs'
const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build, loadConfigFromFile } = require('vite'), hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function captureReadingDensity(evidence) {
  const temporary = await mkdtemp(join(tmpdir(), 'amux-conversation-reading-')), compiled = join(temporary, 'compiled')
  const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', sources: {}, frames: [],
    boundary: 'Actual Desktop ActivityView and MobileConversationSurface using shared ConversationView/CSS in private Electron. Nonempty original frames and changes produced by actual Core/Codex/FileStore reader; transport observations controlled. Host draft is a controlled textarea. No model, live Run, physical phone, installed App, input, delivery or recovery claim.' }
  let server
  try {
    await mkdir(evidence, { recursive: true })
    await new Promise((yes, no) => {
      const child = spawn(process.execPath, [join(fixture, 'generate.mjs'), temporary], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AGENTMUX_MESSAGE_QUEUE_PATH: join(temporary, 'messages.sqlite'), AGENTMUX_RUNTIME_DIRECTORY: join(temporary, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(temporary, 'state') } })
      let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
      child.on('error', no); child.on('close', code => code === 0 ? yes() : no(Error('Public sample failed: ' + output)))
    })
    const config = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(fixture, 'vitest.owning.config.mts'))
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
      resolve: { ...config.config.resolve, conditions: ['browser', 'module', 'production', 'import', 'default'] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      build: { outDir: compiled, emptyOutDir: true, target: 'esnext' },
      plugins: [{ name: 'actual-reading-inputs', enforce: 'pre', resolveId(specifier) {
        if (!specifier.startsWith('@agentmux/')) return
        const { file, manifest } = candidateExport(root, specifier, true)
        receipt.sources[relative(root, manifest)] = hash(readFileSync(manifest))
        return file
      }, transform(code, id) {
        assert.ok(id.startsWith(root + sep) || id.includes('/node_modules/') || !/\/(?:packages|apps)\/[^/]+\/(?:src|dist)\//u.test(id), 'First-party browser source is outside this exact candidate: ' + id)
        if (id.startsWith(root + sep) && !id.includes('/node_modules/') && !id.includes('?') && /\.([cm]?[jt]sx?|css)$/.test(id)) receipt.sources[relative(root, id)] = hash(readFileSync(id))
      }, async generateBundle() {
        for (const file of this.getWatchFiles()) if (file.startsWith(root + sep) && !file.includes('/node_modules/') && file.endsWith('.css')) receipt.sources[relative(root, file)] = hash(await readFile(file))
      } }] })
    const sample = JSON.parse(await readFile(join(temporary, 'reading.json'), 'utf8'))
    assert.ok(Object.keys(sample.coreBuildInputs).length > 0, 'Actual Node Core build inputs')
    Object.assign(receipt.sources, sample.coreBuildInputs)
    for (const file of ['packages/client-ui/src/components/ConversationView.tsx', 'apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/mobile/src/conversation/MobileConversationSurface.tsx']) assert.ok(receipt.sources[file], 'The actual candidate product consumer must be loaded: ' + file)
    await cp(join(temporary, 'reading.json'), join(compiled, 'reading.json')); await cp(join(temporary, 'reading.json'), join(evidence, 'public-reading.json'))
    for (const name of ['capture.mjs', 'candidate-export.mjs', 'generate.mjs', 'main.cjs', 'scene.mjs', 'desktop.tsx', 'index.html', 'preview.css', 'vitest.owning.config.mts']) receipt.sources[relative(root, join(fixture, name))] = hash(await readFile(join(fixture, name)))
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
    server = createServer(async (request, response) => {
      try {
        const name = new URL(request.url, 'http://private.test').pathname, file = resolve(compiled, name === '/' ? 'index.html' : name.slice(1))
        assert.ok(file.startsWith(compiled + sep)); const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); response.end(bytes)
      } catch { response.writeHead(404); response.end() }
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), `http://127.0.0.1:${server.address().port}/`, temporary, evidence],
      { temporaryRoot: temporary, cwd: root, env, timeoutMs: 60000 })
    assert.equal(receipt.process.exitConfirmed, true); assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.process.timedOut, false)
    const actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
    assert.equal(actual.passed, true, JSON.stringify(actual.failure))
    receipt.operations = actual.operations
    for (const image of actual.frames) receipt.frames.push({ ...image, sha256: hash(await readFile(join(evidence, image.file))) })
    for (const [file, sha] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), sha, 'Capture source changed: ' + file)
    receipt.passed = true
  } catch (error) { if (error.probe) receipt.process = error.probe; receipt.failure = { message: error.message, stack: error.stack } }
  finally {
    if (server) await new Promise(done => server.close(done))
    if (receipt.process?.exitConfirmed === false) receipt.retainedNamespace = temporary
    else {
      if (receipt.process?.originalPid) await stopProbeProcesses(receipt.process.originalPid, temporary)
      await rm(temporary, { recursive: true, force: true })
    }
    await writeFile(join(evidence, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.passed, true, receipt.failure?.message)
  return receipt
}
if (process.argv[1] === import.meta.filename) await captureReadingDensity(resolve(process.argv[2] ?? join(root, '.local/conversation-duplication/capture')))
