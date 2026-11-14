import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const coreSourceRoot = new URL('../../../packages/core/', import.meta.url)
const coreSourceAliases = Object.entries(JSON.parse(readFileSync(new URL('package.json', coreSourceRoot), 'utf8')).exports)
  .filter(([key]) => key !== '.')
  .map(([key, entry]) => ({
    find: '@agentmux/core/' + key.slice(2),
    replacement: fileURLToPath(new URL(entry.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'), coreSourceRoot))
  })).sort((a, b) => b.find.length - a.find.length)

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const output = await mkdtemp(join(await mkdir(join(root, '.tmp/browser-pointer-top-layer'), { recursive: true }).then(() => join(root, '.tmp/browser-pointer-top-layer')), 'attempt-'))
const fixture = join(root, 'apps/desktop/scripts/fixtures/browser-pointer-top-layer/main.ts')
const owner = join(root, 'apps/desktop/src/main/browser-operation-feedback.ts')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}, receipt = { schema: 'agentmux.browser-pointer-top-layer.proof.v1', passed: false, output, sources, runs: [],
  boundary: 'Actual current-source BVM/native page/compositor proof. Does not certify installed App, physical input, OS window composition or Core Session recovery.',
  visual: { captureOnly: true, aestheticReview: 'not-performed' } }
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
const sourceBytes = await readFile(owner)
async function bundle(label, mutation) {
  let changed = false
  await build({ configFile: false, root, logLevel: 'error', ssr: { noExternal: true },
    resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: join(root, 'packages/core/src/index.ts') }, ...coreSourceAliases] },
    plugins: [{ name: 'exact-pointer-inputs', enforce: 'pre', async resolveId(id, importer) {
      if (!importer || id.startsWith('.') || id.startsWith('\0') || isAbsolute(id) || isBuiltin(id) || id === 'electron' || id.startsWith('@agentmux/')) return
      const result = await this.resolve(id, importer, { skipSelf: true })
      assert.ok(result && isAbsolute(result.id), 'An actual dependency resolves: ' + id)
      return { id: result.id, external: true }
    }, async transform(code, id) {
      const path = id.split('?')[0]
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const key = path.slice(root.length + 1), hash = digest(await readFile(path))
      assert.ok(!sources[key] || sources[key] === hash, 'Source changed during the paired proof: ' + key)
      sources[key] = hash
      if (mutation && path === owner) {
        assert.equal(code.split('host.showPopover()').length, 2, 'One real cue top-layer call is mutated')
        changed = true
        return { code: code.replace('host.showPopover()', "if (payload.kind === 'page') host.showPopover()"), map: null }
      }
    }, resolveImportMeta(property, { moduleId }) {
      if (!isAbsolute(moduleId)) return
      if (property === 'url') return JSON.stringify(pathToFileURL(moduleId).href)
      if (property === 'filename') return JSON.stringify(moduleId)
      if (property === 'dirname') return JSON.stringify(dirname(moduleId))
    } }], build: { ssr: true, outDir: join(output, label), emptyOutDir: true, minify: false,
      rollupOptions: { input: fixture, external: id => id === 'electron' || isBuiltin(id), output: { format: 'es', entryFileNames: 'main.mjs',
        banner: "import{createRequire as _require}from'node:module';const require=_require(import.meta.url);" } } } })
  assert.equal(changed, mutation)
  return join(output, label, 'main.mjs')
}
try {
  const baseline = await bundle('current', false), mutant = await bundle('without-top-layer', true)
  assert.ok(Object.keys(sources).length > 1 && sources['apps/desktop/src/main/browser-operation-feedback.ts'])
  for (const [label, entry, mode, mutated] of [['current-dialog', baseline, 'dialog', false], ['current-popover', baseline, 'popover', false],
    ['without-top-layer-dialog', mutant, 'dialog', true], ['without-top-layer-popover', mutant, 'popover', true]]) {
    const privateRoot = await mkdtemp(join(tmpdir(), 'amx-pointer-')), out = join(output, label); await mkdir(out)
    const bootstrap = join(privateRoot, 'bootstrap.cjs')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const name of ['home','appData','userData','sessionData']){const p=path.join(${JSON.stringify(privateRoot)},name);fs.mkdirSync(p,{recursive:true});app.setPath(name,p)};import(${JSON.stringify(pathToFileURL(entry).href)}).catch(e=>{console.error(e);app.exit(1)})`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { AGENTMUX_POINTER_OUTPUT: out, AGENTMUX_POINTER_PRIVATE: privateRoot, AGENTMUX_POINTER_MODE: mode })
    const row = { label, mutated, privateRoot, process: null, remaining: null, native: null }; receipt.runs.push(row); await save()
    try { row.process = await runProbeProcess(require('electron'), [bootstrap], { cwd: privateRoot, env, timeoutMs: 45000 }) }
    catch (error) { row.process = error.probe; throw error }
    finally {
      if (row.process?.originalPid) { await stopProbeProcesses(row.process.originalPid, privateRoot); row.remaining = await listProbeProcesses(row.process.originalPid, privateRoot) }
      await save()
    }
    row.native = JSON.parse(await readFile(join(out, 'native.json'), 'utf8'))
    assert.equal(row.process.timedOut, false, 'A timeout cannot qualify an implementation mutation')
    assert.equal(row.process.exitConfirmed, true); assert.equal(row.process.exitSignal, null); assert.deepEqual(row.remaining, [])
    assert.deepEqual(row.native.cleanup, []); assert.equal(row.native.operation.outcome.kind, 'completed', 'The real action remains usable in both candidates')
    assert.ok(row.native.targets.length > 0 && row.native.image.path)
    if (mutated) {
      assert.equal(row.native.passed, false); assert.equal(row.process.exitCode, 1)
      assert.equal(row.native.failure.code, 'ERR_ASSERTION')
      assert.equal(row.native.failure.message, 'Actual pointer pixels remain visible above the native page layer')
      assert.equal(row.native.image.greenPixels, 0, 'The changed production top-layer call makes the exact native pixel check red')
    } else { assert.equal(row.native.passed, true); assert.equal(row.process.exitCode, 0); assert.ok(row.native.image.greenPixels > 25) }
    await rm(privateRoot, { recursive: true })
    row.privateDataRemoved = true; await save()
  }
  assert.equal(digest(await readFile(owner)), digest(sourceBytes), 'The product owner was never mutated on disk')
  receipt.passed = true
} catch (error) { receipt.failure = { code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1 }
await save()
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(output, 'receipt.json'), failure: receipt.failure }))
