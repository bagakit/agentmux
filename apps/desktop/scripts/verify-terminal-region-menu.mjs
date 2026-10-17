import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { build } from 'vite'
import { fixturePath } from './lib/fixture-values.mjs'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(import.meta.url), fixture = join(desktop, 'scripts/fixtures/terminal-region-menu')
const temporaryRoot = await mkdtemp(fixturePath('tmp/amx-terminal-menu-'))
const evidence = join(repository, '.tmp/terminal-region-menu', 'attempt-' + globalThis.crypto.randomUUID())
const hash = data => createHash('sha256').update(data).digest('hex')
const owners = ['RegionContextMenu', 'AgentRegionHeader', 'AgentRegionMenuContent', 'TerminalContextMenu', 'TerminalMenuTools', 'TerminalView']
  .map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`).concat('apps/desktop/src/renderer/src/styles/terminal.css')
const sources = async () => Object.fromEntries(await Promise.all(owners.map(async name => [name, hash(await readFile(join(repository, name)))])))
const result = { schema: 'agentmux.terminal-region-menu-delivery.v1', passed: false, userRunTouched: false,
  aestheticReview: 'not-performed', sourceBefore: await sources(), mutation: null, cleanup: {} }
async function renderer(label, mutation = false) {
  const directory = join(evidence, label), outDir = join(temporaryRoot, label)
  await mkdir(directory, { recursive: true })
  const wrapper = join(temporaryRoot, 'record-xterm.mjs')
  await writeFile(wrapper, `import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};
    export class Terminal extends xterm.Terminal { constructor(...args){super(...args);const records=globalThis.identityTerminals??=[];this.probeIdentity={id:records.length,terminal:this,disposed:false};records.push(this.probeIdentity)}
      dispose(){this.probeIdentity.disposed=true;return super.dispose()} }
  `)
  const loadedSourceInputs = {}, importedStyleInputs = {}, sourceMutations = []
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: wrapper }] },
    plugins: [{ name: 'terminal-menu-consumer-inputs', enforce: 'pre', transform(source, id) {
      if ((id.startsWith(join(desktop, 'src') + '/') || id.startsWith(join(repository, 'packages/client-ui/src') + '/') || id.startsWith(fixture + '/')) && !id.includes('?')) loadedSourceInputs[id.slice(repository.length + 1)] = hash(source)
      if (mutation && id === join(desktop, 'src/renderer/src/components/TerminalContextMenu.tsx')) {
        const anchor = 'if (setContextSource) return <div'
        assert.equal(source.split(anchor).length, 2, 'The actual integrated Terminal consumer branch is unique')
        const altered = source.replace(anchor, 'if (false && setContextSource) return <div')
        sourceMutations.push({ file: id.slice(repository.length + 1), originalSHA256: hash(source), mutatedSHA256: hash(altered), productionWritten: false })
        return altered
      }
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.endsWith('.css') && (file.startsWith(join(desktop, 'src') + '/') || file.startsWith(join(repository, 'packages/client-ui/src') + '/'))) importedStyleInputs[file.slice(repository.length + 1)] = hash(await readFile(file))
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  assert.equal(sourceMutations.length, mutation ? 1 : 0)
  for (const owner of owners) assert.equal((owner.endsWith('.css') ? importedStyleInputs : loadedSourceInputs)[owner], result.sourceBefore[owner], 'Actual compiled owner: ' + owner)
  const compiledFiles = {}
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name); compiledFiles[file.slice(outDir.length + 1)] = hash(await readFile(file))
  }
  assert.ok(Object.keys(compiledFiles).length > 0, 'The actual Renderer compilation is nonempty')
  const harnessInputs = {}
  for (const name of ['entry.tsx', 'main.cjs']) { const data = await readFile(join(fixture, name)); harnessInputs[name] = hash(data); await writeFile(join(directory, 'driver-' + name), data) }
  await writeFile(join(directory, 'compiled.json'), JSON.stringify({ loadedSourceInputs, importedStyleInputs, compiledFiles, sourceMutations, harnessInputs, terminalWrapperSHA256: hash(await readFile(wrapper)) }, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const log = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), temporaryRoot, directory], {
    cwd: repository, env, timeoutMs: 90000, onLine: line => log.push(line)
  })
  await writeFile(join(directory, 'process.log'), log.join('\n'))
  const rendered = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
  assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
  await rm(outDir, { recursive: true })
  return { outcome, rendered, directory }
}
try {
  await mkdir(evidence, { recursive: true })
  result.fixed = await renderer('fixed')
  assert.equal(result.fixed.outcome.exitCode, 0, JSON.stringify(result.fixed.rendered.failure)); assert.equal(result.fixed.rendered.passed, true)
  const red = await renderer('inner-root-red', true)
  assert.equal(red.outcome.exitCode, 1); assert.equal(red.rendered.failure.name, 'AssertionError')
  assert.match(red.rendered.failure.message, /The actual terminal body reaches the shared Agent menu/)
  const restored = await renderer('inner-root-restored')
  assert.equal(restored.outcome.exitCode, 0, JSON.stringify(restored.rendered.failure)); assert.equal(restored.rendered.passed, true)
  result.mutation = { label: 'actual-integrated-terminal-consumer-removed', red, restored, productionWritten: false }
  result.sourceAfter = await sources(); assert.deepEqual(result.sourceAfter, result.sourceBefore)
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await stopProbeProcesses(process.pid + 1000000000, temporaryRoot)
  result.cleanup.remaining = await listProbeProcesses(process.pid + 1000000000, temporaryRoot); assert.deepEqual(result.cleanup.remaining, [])
  await rm(temporaryRoot, { recursive: true }); result.cleanup.temporaryRootRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, frames: result.fixed?.rendered.frames.length, receipt: join(evidence, 'receipt.json'), aestheticReview: result.aestheticReview, failure: result.failure }))
if (!result.passed) process.exitCode = 1
