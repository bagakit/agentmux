import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
const { build: viteBuild } = await import(pathToFileURL(require.resolve('vite')).href)
const output = join(root, '.tmp/pasted-image-persistence', randomUUID())
await mkdir(output, { recursive: true })
const baselineOnly = process.argv.includes('--baseline-only'), args = process.argv.slice(2).filter(arg => arg !== '--baseline-only')
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--receipt', 'Usage: verify-pasted-image-persistence.mjs [--receipt PATH] [--baseline-only]')
const receiptPath = args[1] ? resolve(args[1]) : join(output, 'receipt.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), sources = new Map()
const receipt = { schema: 'agentmux.pasted-image-persistence-proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), runs: [], sharedTreeMutations: 0 }
async function bind(file) {
  const name = relative(root, file), sha = hash(await readFile(file))
  if (sources.has(name)) assert.equal(sources.get(name), sha, 'Bound source changed: ' + name)
  sources.set(name, sha)
}
async function save() { await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, JSON.stringify({ ...receipt, sources: Object.fromEntries(sources) }, null, 2)) }
async function execute(file, args, env, label) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, log }) })
  })
  await writeFile(join(output, label + '.log'), result.log)
  assert.equal(result.timedOut, false, 'Timeout cannot qualify: ' + label)
  assert.equal(result.signal, null, 'Signal cannot qualify: ' + label)
  return result
}
const writer = 'apps/desktop/src/main/pasted-image-write.ts', ipc = 'apps/desktop/src/main/ipc.ts'
const mutations = [
  { id: 'retained-bytes', file: writer, from: 'await confirm(path, bytes)', to: '/* private mutant: trust filename */', expected: 'refuses changed retained bytes' },
  { id: 'no-overwrite', file: writer, from: 'await link(temporary, path)', to: "await (await import('node:fs/promises')).rename(temporary, path)", expected: 'refuses changed retained bytes' },
  { id: 'directory-confirmation', file: writer, from: 'await syncDirectory(directory)', to: '/* private mutant: omit publication sync */', expected: 'does not report success when directory synchronization is unconfirmed' },
  { id: 'legitimate-link-cleanup', file: writer, from: 'before.size !== after.size || before.mtimeMs !== after.mtimeMs',
    to: 'before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs', expected: 'accepts concurrent identical bytes when the original publisher removes its private hard link' },
  { id: 'actual-ipc-writer', file: ipc, from: "return (await savePastedImage(app.getPath('home'), input)).path",
    to: "const destination=join(app.getPath('home'),'.agentmux','pasted');await mkdir(destination,{recursive:true});const path=join(destination,randomUUID()+'.png');await writeFile(path,Buffer.from(input.bytes));return path",
    expected: 'actual IPC retry must return the same original pasted object', native: true }
]
async function mutationReceipt(mutation) {
  return mutation ? { id: mutation.id, file: mutation.file, original: sources.get(mutation.file),
    consumed: hash((await readFile(join(root, mutation.file), 'utf8')).replace(mutation.from, mutation.to)) } : null
}
for (const mutation of mutations) { await bind(join(root, mutation.file)); assert.equal((await readFile(join(root, mutation.file), 'utf8')).split(mutation.from).length, 2, 'Unique production anchor: ' + mutation.id) }
async function units(label, mutation) {
  const report = join(output, label + '.tests.json'), config = join(output, label + '.config.mts'), loaded = join(output, label + '.loaded.json')
  await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/test/pasted-image-persistence.config.mts'))};
import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';const m=${JSON.stringify(mutation ?? null)};
export default {...base,cacheDir:${JSON.stringify(join(output, label + '-cache'))},plugins:[{name:'private-pasted-mutation',enforce:'pre',load(id){if(!m||id.split('?')[0]!==${JSON.stringify(root)}+'/'+m.file)return;const original=readFileSync(id,'utf8'),source=original.replace(m.from,m.to);writeFileSync(${JSON.stringify(loaded)},JSON.stringify({original:createHash('sha256').update(original).digest('hex'),consumed:createHash('sha256').update(source).digest('hex')}));return source;}}]};`)
  const result = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=default', '--reporter=json', '--outputFile.json=' + report], { ...process.env, NODE_ENV: 'test' }, label)
  const tests = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(tests.testResults.length, 2); assert.equal(tests.numTotalTests, 24); assert.equal(tests.numPendingTests, 0)
  assert.equal(tests.numRuntimeErrorTestSuites ?? 0, 0)
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  assert.doesNotMatch(result.log, /test timed out/iu, 'An individual test timeout cannot qualify RED')
  for (const suite of tests.testResults) assert.equal(suite.message, '', 'Collection/setup failures do not qualify')
  if (mutation) {
    const owning = tests.testResults.flatMap(suite => suite.assertionResults).find(test => test.fullName.includes(mutation.expected))
    assert.notEqual(result.code, 0); assert.equal(owning?.status, 'failed', 'Owning assertion must fail: ' + mutation.id)
    assert.ok(owning.failureMessages.some(message => /AssertionError/u.test(message)), 'A real assertion must cause RED')
    const consumed = JSON.parse(await readFile(loaded, 'utf8'))
    assert.equal(consumed.original, sources.get(mutation.file))
    assert.equal(consumed.consumed, hash((await readFile(join(root, mutation.file), 'utf8')).replace(mutation.from, mutation.to)))
  } else { assert.equal(result.code, 0, label + ': inspect log'); assert.equal(tests.numFailedTests, 0) }
  receipt.runs.push({ label, tests: tests.numTotalTests, failed: tests.numFailedTests, mutation: await mutationReceipt(mutation), passed: true }); await save()
  console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
}

// Resolve ordinary installed dependencies relative to their actual importer; package import-only
// exports cannot be resolved with require.resolve alone. No shared dist is built or modified.
function externalDependency(specifier, importer) {
  const resolver = createRequire(importer || join(root, 'package.json'))
  const parts = specifier.split('/'), name = specifier.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
  for (const directory of resolver.resolve.paths(name) ?? []) {
    try {
      const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(require('node:fs').readFileSync(manifest, 'utf8'))
      const key = parts.length ? './' + parts.join('/') : '.'
      let spec = pkg.exports?.[key] ?? (!parts.length ? pkg.exports : undefined), wildcard
      if (!spec) for (const [pattern, value] of Object.entries(pkg.exports ?? {}).sort(([a], [b]) => b.length - a.length)) {
        const [prefix, suffix] = pattern.split('*')
        if (suffix !== undefined && key.startsWith(prefix) && key.endsWith(suffix)) { wildcard = key.slice(prefix.length, suffix.length ? -suffix.length : undefined); spec = value; break }
      }
      let target = typeof spec === 'string' ? spec : typeof spec?.import === 'string' ? spec.import : spec?.import?.default
      if (target && wildcard !== undefined) target = target.replaceAll('*', wildcard)
      if (target) return resolve(dirname(manifest), target)
    } catch {}
  }
  return resolver.resolve(specifier)
}
let renderer
async function native(label, mutation) {
  const directory = await mkdtemp(join(tmpdir(), 'amp-'))
  let applied = false
  const options = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', external: ['electron'], metafile: true, logLevel: 'warning',
    banner: { js: "import {createRequire as __proofRequire} from 'node:module';const require=__proofRequire(import.meta.url);" },
    plugins: [{ name: 'original-pasted-production', setup(plugin) {
      plugin.onResolve({ filter: /^[^./]/ }, async args => {
        if (isBuiltin(args.path) || args.path === 'electron') return null
        const path = externalDependency(args.path, args.importer); await bind(path); return { path, external: true }
      })
      plugin.onLoad({ filter: /\.ts$/ }, async args => {
        if (!mutation || args.path !== join(root, mutation.file)) return null
        applied = true; return { contents: (await readFile(args.path, 'utf8')).replace(mutation.from, mutation.to), loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] }
  const main = await build({ ...options, entryPoints: ['apps/desktop/scripts/fixtures/pasted-image-persistence/main.ts'], outfile: join(directory, 'main.mjs') })
  const storage = await build({ ...options, stdin: { resolveDir: root, loader: 'ts', contents: 'export {savePastedImage} from "./apps/desktop/src/main/pasted-image-write.ts";export {readPastedImage} from "./apps/desktop/src/main/pasted-image-read.ts"' }, outfile: join(directory, 'storage.mjs') })
  const preload = await build({ ...options, plugins: [], platform: 'browser', conditions: ['module', 'browser', 'production'],
    mainFields: ['browser', 'module', 'jsnext:main', 'jsnext', 'main'], format: 'cjs', banner: undefined,
    entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(directory, 'preload.cjs') })
  for (const built of [main, storage, preload]) for (const file of Object.keys(built.metafile.inputs)) if (file !== '<stdin>') await bind(resolve(root, file))
  if (mutation) assert.equal(applied, true, 'Actual native build must consume its production mutation')
  for (const expected of [ipc, 'apps/desktop/src/main/pasted-image-read.ts']) assert.ok(main.metafile.inputs[expected], 'Actual Main must load ' + expected)
  if (!mutation) assert.ok(main.metafile.inputs[writer], 'Actual IPC must load the original writer')
  assert.ok(preload.metafile.inputs['apps/desktop/src/preload/index.ts'])
  const html = join(root, 'apps/desktop/scripts/fixtures/pasted-image-persistence/index.html')
  await bind(html)
  if (!renderer) {
  renderer = join(output, 'renderer')
  await viteBuild({ configFile: false, root: dirname(html), base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] }, worker: { format: 'es' },
    plugins: [{ name: 'pasted-renderer-source-binding', async transform(_source, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await bind(file) } }],
    build: { outDir: renderer, emptyOutDir: true, rollupOptions: { input: html }, chunkSizeWarningLimit: 10000 } })
  }
  await symlink(renderer, join(directory, 'renderer'), 'dir')
  await writeFile(join(directory, 'bootstrap.cjs'), `const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=${JSON.stringify(directory)};for(const key of ['home','appData','userData','sessionData']){const target=path.join(root,key);fs.mkdirSync(target,{recursive:true});app.setPath(key,target)};
app.on('window-all-closed',()=>{});import(${JSON.stringify(pathToFileURL(join(directory, 'main.mjs')).href)}).catch(error=>{console.error(error);fs.writeFileSync(path.join(root,'native-receipt.json'),JSON.stringify({passed:false,failure:{name:error.name,message:error.message,stack:error.stack}}));app.exit(1)});`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name) && name !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_PASTED_PROOF_ROOT: directory, AGENTMUX_PASTED_PROOF_NODE: process.execPath,
    AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
  const result = await execute(require('electron'), [join(directory, 'bootstrap.cjs')], env, label)
  const actual = JSON.parse(await readFile(join(directory, 'native-receipt.json'), 'utf8'))
  await writeFile(join(output, label + '.native.json'), JSON.stringify(actual, null, 2))
  if (mutation) {
    assert.notEqual(result.code, 0); assert.equal(actual.passed, false)
    assert.equal(actual.failure?.name, 'AssertionError'); assert.ok(actual.failure.message.includes(mutation.expected), 'The exact actual IPC consumer assertion must turn RED')
  } else { assert.equal(result.code, 0, label + ': inspect log'); assert.equal(actual.passed, true) }
  receipt.runs.push({ label, mutation: await mutationReceipt(mutation), actual, passed: true }); await save()
  console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
}
try {
  await bind(import.meta.filename)
  for (const file of ['apps/desktop/test/pasted-image-write.test.ts', 'apps/desktop/test/pasted-image-read.test.ts', 'apps/desktop/test/pasted-image-persistence.config.mts']) await bind(join(root, file))
  await units('baseline')
  await native('consumer-baseline')
  if (!baselineOnly) {
    for (const mutation of mutations) { if (mutation.native) await native(mutation.id, mutation); else await units(mutation.id, mutation) }
    await units('restored')
    await native('consumer-restored')
  }
  for (const file of [...sources.keys()]) await bind(resolve(root, file))
  receipt.baselineQualified = true
  receipt.passed = !baselineOnly
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
await save(); console.log('Pasted image proof: ' + receiptPath)
