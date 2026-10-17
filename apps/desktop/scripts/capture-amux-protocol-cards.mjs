import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..')
const fixture = join(root, 'apps/desktop/scripts/fixtures/amux-protocol-cards')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { createServer, loadConfigFromFile } = require('vite')
const hash = value => createHash('sha256').update(value).digest('hex')
assert.equal(process.env.AMUX_PROTOCOL_MUTATION ?? '', '', 'Visual capture requires the original candidate; unset AMUX_PROTOCOL_MUTATION.')
await mkdir(join(root, '.tmp/amux-protocol-cards'), { recursive: true })
const evidence = await mkdtemp(join(root, '.tmp/amux-protocol-cards/visual-'))
const temporary = await mkdtemp(join(tmpdir(), 'amux-protocol-source-'))
const receipt = { schema: 'agentmux.amux-protocol-capture.v1', passed: false, captureOnly: true,
  aestheticReview: 'not-performed', buildPerformed: false, distWritten: false, sources: {}, images: [],
  boundary: 'Vite development transforms of current source, private Electron, actual SettingsPanel, ActivityView and MobileConversationSurface. Source Core/Claude/FileStore originals; controlled read transport and outer reply draft. No Native process, model, user App/Run, physical phone, installation or recovery qualification.' }
let server
function bind(file) {
  const key = relative(root, file), digest = hash(readFileSync(file))
  if (receipt.sources[key]) assert.equal(receipt.sources[key], digest, 'Source changed during capture: ' + key)
  receipt.sources[key] = digest
}
try {
  for (const file of ['apps/desktop/scripts/capture-amux-protocol-cards.mjs', 'apps/desktop/vite.web.config.ts', 'test/vitest.amux-protocol-cards.config.mts',
    ...['entry.tsx', 'generate.test.ts', 'vitest.config.mts', 'main.cjs', 'index.html', 'preview.css'].map(name => 'apps/desktop/scripts/fixtures/amux-protocol-cards/' + name)]) bind(join(root, file))
  const generatorLog = []
  receipt.generator = await runProbeProcess(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(fixture, 'vitest.config.mts'),
    '--reporter=json', '--outputFile=' + join(evidence, 'generator.json')], { cwd: root, temporaryRoot: temporary, timeoutMs: 90000,
    env: { ...process.env, AMUX_PROTOCOL_CAPTURE_DATA: join(evidence, 'reading.json'), AMUX_PROTOCOL_LOADED: join(evidence, 'generator.loaded.jsonl') },
    onLine: line => generatorLog.push(line) })
  await writeFile(join(evidence, 'generator.log'), generatorLog.join('\n'))
  assert.equal(receipt.generator.exitCode, 0)
  const report = JSON.parse(await readFile(join(evidence, 'generator.json'), 'utf8'))
  assert.ok(report.numPassedTests > 0 && report.numFailedTests === 0)
  const loaded = (await readFile(join(evidence, 'generator.loaded.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(loaded.length > 0)
  for (const input of loaded) {
    assert.equal(input.sourceSHA256, input.compilerInputSHA256, 'Generator loaded a mutated source: ' + input.file)
    assert.equal(hash(readFileSync(join(root, input.file))), input.sourceSHA256); bind(join(root, input.file))
  }
  const data = await readFile(join(evidence, 'reading.json'))
  receipt.readingSHA256 = hash(data)
  const definition = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(fixture, 'vitest.config.mts'))
  const web = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(root, 'apps/desktop/vite.web.config.ts'))
  process.env.AMUX_PROTOCOL_LOADED = join(evidence, 'renderer.loaded.jsonl')
  server = await createServer({ configFile: false, root: fixture, base: '/', cacheDir: join(temporary, 'vite-cache'),
    ...{ define: web.config.define, esbuild: { jsx: 'automatic' }, worker: { format: 'es' } },
    resolve: { ...web.config.resolve, ...definition.config.resolve, conditions: ['browser', 'module', 'development', 'import', 'default'] },
    css: { postcss: { plugins: [{ postcssPlugin: 'bind-actual-protocol-css', OnceExit(styles) {
      const files = new Set(); styles.walk(node => { if (node.source?.input?.file) files.add(node.source.input.file) })
      for (const file of files) if (file.startsWith(root + '/') && !file.includes('/node_modules/')) bind(file)
    } }] } },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, fs: { allow: [root] } },
    plugins: [...web.config.plugins, ...definition.config.plugins, { name: 'source-only-protocol-capture', enforce: 'pre',
      configureServer(current) { current.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/reading.json') return next()
        response.setHeader('Content-Type', 'application/json'); response.end(data)
      }) },
      transform(_code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/') && /\.(?:[cm]?[jt]sx?|css)$/u.test(file)) bind(file) }
    }] })
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const log = [], env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), `http://127.0.0.1:${address.port}/`, temporary, evidence],
    { cwd: root, temporaryRoot: temporary, env, timeoutMs: 150000, onLine: line => log.push(line) })
  await writeFile(join(evidence, 'electron.log'), log.join('\n'))
  const actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0, actual.failure?.message)
  assert.equal(actual.passed, true, actual.failure?.message)
  const rendererInputs = (await readFile(join(evidence, 'renderer.loaded.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(rendererInputs.length > 0)
  for (const input of rendererInputs) assert.equal(input.sourceSHA256, input.compilerInputSHA256, 'Renderer loaded a mutated source: ' + input.file)
  receipt.operations = actual.operations
  for (const image of actual.frames) receipt.images.push({ ...image, sha256: hash(await readFile(join(evidence, image.file))) })
  assert.ok(receipt.images.length > 0)
  for (const file of ['packages/client-ui/src/styles/conversation-protocol.css', 'packages/client-ui/src/styles/conversation-message.css',
    'apps/desktop/src/renderer/src/styles/surfaces.css', 'apps/desktop/src/renderer/src/styles/settings-amux-protocols.css']) assert.ok(receipt.sources[file], 'Actual CSS was not observed: ' + file)
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), digest, 'Capture candidate changed: ' + file)
  receipt.passed = true
} catch (error) {
  if (error.probe) receipt.process = error.probe
  receipt.failure = { message: error.message, stack: error.stack }
} finally {
  await server?.close()
  if (receipt.process?.exitConfirmed === false) receipt.retainedNamespace = temporary
  else { if (receipt.process?.originalPid) await stopProbeProcesses(receipt.process.originalPid, temporary); await rm(temporary, { recursive: true, force: true }) }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(evidence, 'review.md'), '# Independent visual review pending\n\n' + receipt.boundary + '\n\n' + receipt.images.map(image => `- [${image.file}](${image.file})`).join('\n') + '\n\nOpen each full image. Capture success does not certify aesthetic quality.\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ captureOnly: true, aestheticReview: 'not-performed', buildPerformed: false, evidence: relative(root, evidence), images: receipt.images.length }))
