import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), fixture = join(root, 'apps/desktop/scripts/fixtures/spatial-continuity')
const evidence = resolve(process.argv[2] ?? join(root, '.tmp/ui-design-cohesion/spatial-continuity'))
const require = createRequire(import.meta.url), owner = 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'
const original = await readFile(join(root, owner), 'utf8')
const currentGuard = 'sameSpatialValue(graph, this.pending?.graph ?? this.state!.graph)', oldGuard = 'sameSpatialValue(graph, this.state!.graph)'
assert.equal(original.split(currentGuard).length - 1, 1, 'The actual latest-intent fix must be present')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
const report = { schema: 'agentmux.spatial-continuity.v1', passed: false, runs: [], source: owner, sourceSHA256: hash(original),
  boundary: 'Original App/store/Region pointer handler/DesktopSpatialPersistence and real private Core spatial file. Only the first B commit IPC response is delayed; the original Core event order remains. Old predicate is an actual loaded-source mutation, current predicate is compiled unchanged. File metadata transport is controlled. Only first process seeds; fixed candidate must restore A in a second real Electron process. No Session/Run or Agent recovery claim.' }
await mkdir(evidence, { recursive: true })
try {
  for (const variant of ['old-predicate', 'current']) {
    const temporary = await mkdtemp(join(tmpdir(), 'amx-spatial-continuity-')), compiled = join(temporary, 'renderer'), output = join(evidence, variant)
    const inputs = {}, loadedOwner = variant === 'old-predicate' ? original.replace(currentGuard, oldGuard) : original
    const receipt = { variant, passed: false, sourceOverride: variant === 'old-predicate' ? { file: owner, originalSHA256: hash(original), loadedSHA256: hash(loadedOwner), before: currentGuard, after: oldGuard } : null, inputs, phases: [] }
    const record = async id => {
      const file = id.split('?')[0]
      if (file.startsWith(root + '/') && !file.includes('/node_modules/') && /\.(?:[cm]?[jt]sx?|css|html)$/.test(file)) inputs[relative(root, file)] = file === join(root, owner) ? hash(loadedOwner) : hash(await readFile(file))
    }
    await mkdir(output, { recursive: true })
    try {
      await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
        define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
        plugins: [{ name: 'original-spatial-continuity-inputs', enforce: 'pre', async transform(code, id) {
          await record(id)
          if (id === join(root, owner)) {
            assert.equal(code, original, 'Owner changed during compilation')
            receipt.loadedOwner = { file: owner, sha256: hash(loadedOwner) }
            return { code: loadedOwner, map: null }
          }
        }, async generateBundle() { await Promise.all(this.getWatchFiles().map(record)) } }],
        build: { target: 'esnext', outDir: compiled, emptyOutDir: true, rollupOptions: { input: join(fixture, 'index.html') } } })
      await Promise.all([new URL(import.meta.url).pathname, join(fixture, 'main.cjs'), join(fixture, '../topics-navigation-quality/restart-preload.cjs'), join(root, 'packages/core/dist/spatial-state.js')].map(record))
      receipt.compiled = Object.fromEntries(await Promise.all((await files(compiled)).map(async file => [relative(compiled, file), hash(await readFile(file))])))
      for (const file of ['App.tsx', 'store.ts', 'WorkspaceWorkbench.tsx', 'desktop-spatial-state.ts']) assert.ok(Object.keys(inputs).some(input => input.endsWith('/' + file)), 'Original product input: ' + file)
      assert.equal(receipt.loadedOwner.sha256, hash(loadedOwner))
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      for (const phase of variant === 'current' ? ['seed', 'restore'] : ['seed']) {
        const log = []
        const process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(compiled, 'index.html'), temporary, output, phase, variant],
          { temporaryRoot: temporary, cwd: root, env, timeoutMs: 45000, onLine: line => log.push(line) })
        await writeFile(join(output, phase + '.log'), log.join('\n'))
        const actual = JSON.parse(await readFile(join(output, phase + '.json'), 'utf8'))
        receipt.phases.push({ phase, process, actual })
        if (variant === 'old-predicate') {
          assert.equal(process.exitCode, 1); assert.equal(process.timedOut, false)
          assert.equal(actual.failure?.name, 'AssertionError')
          assert.ok(actual.failure.message.startsWith('The latest pointer choice A survives the older B acknowledgement'))
          assert.equal(actual.after.tabs['topic-tab-0'].layout.activeRegionId, 'original-decisions-region')
          assert.ok(actual.trace.slice(actual.returnTraceIndex).some(item => item.active === 'original-decisions-region'))
        } else { assert.equal(process.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true) }
      }
      if (variant === 'current') assert.notEqual(receipt.phases[0].actual.pid, receipt.phases[1].actual.pid)
      receipt.frames = await Promise.all(receipt.phases.flatMap(phase => phase.actual.frames).map(async file => ({ path: file, sha256: hash(await readFile(join(output, file))) })))
      receipt.passed = true
    } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
    finally {
      receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
      if (!receipt.cleanup.remaining.length) { await rm(temporary, { recursive: true, force: true }); receipt.cleanup.removed = true }
      await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
    }
    report.runs.push({ variant, receipt: relative(root, join(output, 'receipt.json')), passed: receipt.passed })
    assert.equal(receipt.passed, true, receipt.failure?.message)
  }
  assert.equal(hash(await readFile(join(root, owner))), report.sourceSHA256, 'Shared product owner remained unchanged')
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure?.message })) }
