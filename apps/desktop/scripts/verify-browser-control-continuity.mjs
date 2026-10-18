import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, copyFile, symlink, stat, writeFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const take = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
assert.ok(args.every((arg, index) => ['--receipt', '--baseline-only', '--prepare-only'].includes(arg) || args[index - 1] === '--receipt'), 'Unsupported continuity proof option')
const baselineOnly = args.includes('--baseline-only'), prepareOnly = args.includes('--prepare-only')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const { transform } = createRequire(require.resolve('vite/package.json'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const base = join(root, '.tmp/browser-control-continuity'); await mkdir(base, { recursive: true })
const out = await mkdtemp(join(base, 'attempt-')), projection = join(out, 'source')
const receiptPath = take('--receipt') ? resolve(take('--receipt')) : join(out, 'receipt.json')
try { await stat(receiptPath); throw new Error('Keep the original receipt; use a fresh explicit output') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(dirname(receiptPath), { recursive: true }); await mkdir(projection)
const fixture = 'apps/desktop/scripts/fixtures/browser-control-continuity/main.ts'
const owners = ['apps/desktop/src/main/browser-native-input-shield.ts', 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/shared/browser-agent-control.ts', 'apps/desktop/src/main/browser-operation-feedback.ts', 'apps/desktop/src/main/browser-control-feedback.ts']
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024 })
const candidate = git(['rev-parse', 'HEAD']).toString().trim()
const receipt = { schema: 'agentmux.browser-control-continuity.proof.v1', candidate, passed: false, baselinePassed: false,
  diagnostic: baselineOnly || prepareOnly, out, sharedSourceMutations: 0, overlays: [], sources: {}, externalInputs: {}, bundles: {}, runs: [],
  boundary: 'Real private BVM/native shield/script worker/CDP. Frozen committed Main dependencies plus exact current shield/BVM/shared-appearance owners; mutations affect private compiled source only. Native layer PNGs do not certify final OS composition, mirrored stages, halo blending, physical input or installation.' }
const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
const mutations = [
  { label: 'rim-not-painted', file: owners[0], from: 'stroke-width="2" vector-effect="non-scaling-stroke"', to: 'stroke-width="0" vector-effect="non-scaling-stroke"', assertion: 'Actual native shield paints all four stable rim edges: waiting' },
  { label: 'rim-cleared-by-navigation', file: owners[0], from: "    this.source.on('focus', this.focused)",
    to: "    this.source.on('focus', this.focused)\n    this.source.on('did-start-navigation', () => { void this.contents.insertCSS('[data-browser-control-boundary]{opacity:0!important}') })",
    assertion: 'Actual native shield paints all four stable rim edges: navigation-in-flight' }
]
async function bind(file) {
  const bytes = await readFile(file), key = relative(projection, file), hash = sha(bytes)
  assert.ok(!receipt.sources[key] || receipt.sources[key] === hash, 'A frozen native source must not drift: ' + key)
  receipt.sources[key] = hash
}
try {
  const paths = ['apps/desktop/src/main', 'apps/desktop/src/shared', 'apps/desktop/browser-extension', 'apps/desktop/resources/toolkit', 'apps/desktop/package.json', 'package.json']
  for (const name of await readdir(join(root, 'packages'))) for (const leaf of ['src', 'package.json']) {
    const file = 'packages/' + name + '/' + leaf
    try { git(['cat-file', '-e', candidate + ':' + file]); paths.push(file) } catch {}
  }
  execFileSync('tar', ['-x', '-C', projection], { input: git(['archive', candidate, ...paths]) })
  for (const file of owners) {
    const original = await readFile(join(projection, file)), bytes = await readFile(join(root, file))
    await writeFile(join(projection, file), bytes)
    receipt.overlays.push({ file, originalGitBlob: git(['rev-parse', candidate + ':' + file]).toString().trim(), originalSha256: sha(original), consumedSha256: sha(bytes) })
  }
  await mkdir(dirname(join(projection, fixture)), { recursive: true })
  await copyFile(join(root, fixture), join(projection, fixture))
  receipt.fixtureSha256 = sha(await readFile(join(root, fixture)))
  receipt.driverSha256 = sha(await readFile(import.meta.filename))
  receipt.sceneSha256 = sha(await readFile(join(root, 'apps/desktop/scripts/fixtures/browser-control-continuity/scene.md')))
  const aliases = []
  for (const folder of ['', 'apps/desktop', ...paths.filter(p => p.startsWith('packages/') && p.endsWith('/package.json')).map(dirname)]) {
    try { await symlink(join(root, folder, 'node_modules'), join(projection, folder, 'node_modules')) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!folder.startsWith('packages/')) continue
    const pkg = JSON.parse(await readFile(join(projection, folder, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const target = typeof value === 'string' ? value : value.browser ?? value.import
      if (typeof target !== 'string') continue
      const name = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = name.includes('*')
      let replacement = resolve(projection, folder, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      if (!wildcard) { try { await stat(replacement) } catch { replacement = replacement.replace(/\.ts$/u, '.tsx'); try { await stat(replacement) } catch { continue } } }
      aliases.push({ name, wildcard, find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'), replacement: replacement.replace('*', '$1') })
    }
  }
  aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.name.length - a.name.length)
  for (const mutation of baselineOnly ? [] : mutations) {
    const code = await readFile(join(projection, mutation.file), 'utf8')
    assert.equal(code.split(mutation.from).length, 2, 'One original paint mutation anchor: ' + mutation.label)
    await transform(code.replace(mutation.from, mutation.to), { loader: 'ts' })
  }
  async function bundle(label, mutation) {
    const directory = join(out, label); await mkdir(directory)
    let changed = false
    await build({ configFile: false, root: projection, logLevel: 'error', ssr: { noExternal: true }, resolve: { alias: aliases }, plugins: [{ name: 'private-native-continuity', enforce: 'pre',
      async resolveId(id, importer) {
        if (!importer || id.startsWith('.') || isAbsolute(id) || id.startsWith('\0') || isBuiltin(id) || id === 'electron' || id.startsWith('@agentmux/')) return
        const found = await this.resolve(id, importer, { skipSelf: true })
        assert.ok(found && isAbsolute(found.id), 'An actual dependency entry is available: ' + id)
        receipt.externalInputs[found.id] = sha(await readFile(found.id))
        return { id: found.id, external: true }
      },
      resolveImportMeta(property, { moduleId }) {
        if (!isAbsolute(moduleId)) return
        if (property === 'url') return JSON.stringify(pathToFileURL(moduleId).href)
        if (property === 'filename') return JSON.stringify(moduleId)
        if (property === 'dirname') return JSON.stringify(dirname(moduleId))
      },
      async transform(code, id) {
        const file = id.split('?')[0]
        if (!file.startsWith(projection + '/') || file.includes('/node_modules/')) return
        await bind(file)
        if (mutation && file === join(projection, mutation.file)) {
          assert.equal(code.split(mutation.from).length, 2)
          const transformed = code.replace(mutation.from, mutation.to)
          receipt.bundles[label] = { mutation, sourceSha256: sha(code), transformedSha256: sha(transformed) }
          changed = true
          return { code: transformed, map: null }
        }
      }
    }], build: { ssr: true, outDir: join(directory, 'dist'), minify: false, rollupOptions: { input: join(projection, fixture), external: id => id === 'electron' || isBuiltin(id),
      output: { format: 'es', entryFileNames: 'main.mjs', banner: "import{createRequire as __nativeRequire}from'node:module';const require=__nativeRequire(import.meta.url);" } } } })
    assert.equal(changed, Boolean(mutation), 'Exactly the intended private paint mutation is consumed')
    const file = join(directory, 'dist/main.mjs')
    receipt.bundles[label] = { ...receipt.bundles[label], file, sha256: sha(await readFile(file)) }
  }
  await bundle('baseline')
  if (!baselineOnly) for (const mutation of mutations) await bundle(mutation.label, mutation)
  assert.ok(Object.keys(receipt.sources).length > owners.length, 'Actual native production consumers are nonempty')
  receipt.engine = { executable: require('electron'), version: require('electron/package.json').version, sha256: sha(await readFile(require('electron'))) }
  await writeFile(join(out, 'prepared.json'), JSON.stringify(receipt, null, 2) + '\n'); await save()
  if (prepareOnly) { receipt.prepared = true; await save(); console.log(JSON.stringify({ prepared: true, receipt: receiptPath })); process.exit(0) }
  for (const label of baselineOnly ? ['baseline'] : ['baseline', ...mutations.map(m => m.label), 'restored']) {
    const directory = label === 'restored' ? join(out, label) : dirname(dirname(receipt.bundles[label].file))
    if (label === 'restored') await mkdir(directory)
    const privateRoot = await mkdtemp(join(tmpdir(), 'amx-control-continuity-'))
    const bundle = receipt.bundles[label === 'restored' ? 'baseline' : label]
    assert.equal(sha(await readFile(bundle.file)), bundle.sha256)
    const bootstrap = join(privateRoot, 'bootstrap.cjs')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(privateRoot)};for(const key of ['home','appData','userData','sessionData']){const dir=path.join(root,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(bundle.file).href)})).catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { HOME: join(privateRoot, 'home'), XDG_CACHE_HOME: join(privateRoot, 'cache'), XDG_CONFIG_HOME: join(privateRoot, 'config'), XDG_DATA_HOME: join(privateRoot, 'data'),
      AGENTMUX_CONTINUITY_PRIVATE: privateRoot, AGENTMUX_CONTINUITY_OUTPUT: directory })
    const logs = [], row = { label, privateRoot, process: null, remaining: null, actual: null }
    receipt.runs.push(row); await save()
    try { row.process = await runProbeProcess(receipt.engine.executable, [bootstrap], { cwd: privateRoot, env, timeoutMs: 60000, onLine: line => logs.push(line) }) }
    catch (error) { row.process = error.probe; throw error }
    finally {
      await writeFile(join(directory, 'process.log'), logs.join('\n')); await writeFile(join(directory, 'process.json'), JSON.stringify(row.process, null, 2) + '\n'); await save()
      if (row.process?.originalPid) {
        await stopProbeProcesses(row.process.originalPid, privateRoot); row.remaining = await listProbeProcesses(row.process.originalPid, privateRoot)
        if (row.process.exitConfirmed && row.remaining.length === 0) {
          let noOpenFiles = false
          try { row.openFiles = execFileSync('lsof', ['+D', privateRoot], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }) }
          catch (error) { if (error.status === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) noOpenFiles = true; else row.openFileUnknown = String(error) }
          if (noOpenFiles) { await rm(privateRoot, { recursive: true }); row.privateDataRemoved = true }
        }
      }
      await save()
    }
    const file = join(directory, 'native.json'), bytes = await readFile(file), actual = JSON.parse(bytes)
    row.actual = actual; row.native = { file, sha256: sha(bytes) }; await save()
    assert.equal(row.process.timedOut, false, 'Timeout cannot qualify a paint mutation')
    assert.equal(row.process.exitConfirmed, true); assert.equal(row.process.exitSignal, null); assert.deepEqual(row.remaining, [])
    assert.equal(actual.cleanupComplete, true); assert.deepEqual(actual.cleanup, [])
    assert.ok(actual.cases.length > 0 && actual.checkpoints.length > 0, 'Actual operation and native pixel consumers are nonempty')
    const mutation = mutations.find(m => m.label === label)
    if (mutation) {
      assert.equal(row.process.exitCode, 1); assert.equal(actual.failure?.name, 'AssertionError')
      assert.ok(actual.failure.message.includes(mutation.assertion), 'Expected owning paint AssertionRED: ' + mutation.assertion)
      row.owningAssertion = 'AssertionRED'
    } else {
      assert.equal(row.process.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true)
      assert.equal(actual.cases.length, 10); assert.equal(actual.checkpoints.length, 11); assert.equal(actual.inputDelivery.length, 3)
      assert.equal(actual.preferenceChanges.length, 1, 'The original hidden Browser consumes the actual saved appearance')
      assert.ok(actual.cases.every(value => value.passed)); receipt.baselinePassed = true
    }
  }
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(join(projection, file))), digest, 'Frozen input remains unchanged: ' + file)
  for (const owner of receipt.overlays) assert.equal(sha(await readFile(join(root, owner.file))), owner.consumedSha256, 'Actual owner remains the consumed candidate: ' + owner.file)
  assert.equal(sha(await readFile(join(root, fixture))), receipt.fixtureSha256)
  receipt.passed = !baselineOnly
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await save() }
console.log(JSON.stringify({ passed: receipt.passed, baselinePassed: receipt.baselinePassed, receipt: receiptPath }))
