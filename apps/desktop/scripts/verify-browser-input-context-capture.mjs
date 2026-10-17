import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat, symlink, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fixturePath } from './lib/fixture-values.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url)
const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
const output = join(root, '.tmp/browser-input-context-capture', randomUUID())
await mkdir(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), sources = new Map()
const receipt = { schema: 'agentmux.browser-input-context-capture-proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), runs: [], sharedTreeMutations: 0,
  boundary: 'Real Main immutable files/trusted IPC and public Core/Host consumers; private native Browser/Renderer/preload → original Main owner → public read/compiled CLI → Host/Hosted/Core → shipped CodexProvider and real ctxmux PTY with repository-controlled CLI. No upstream model or user workface is used.' }
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify({ ...receipt, sources: Object.fromEntries(sources) }, null, 2))
async function bind(file) {
  const name = relative(root, file), digest = hash(await readFile(file))
  if (sources.has(name)) assert.equal(sources.get(name), digest, 'Proof source changed: ' + name)
  sources.set(name, digest)
}
async function execute(executable, args, env, label, budget = 120000) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, budget)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, log }) })
  })
  await writeFile(join(output, label + '.log'), result.log)
  assert.equal(result.timedOut, false, label + ': timeout is not a behavioral RED')
  assert.equal(result.signal, null, label + ': process failure is not a behavioral RED')
  return result
}
const mainOwner = 'apps/desktop/src/main/browser-input-context-capture.ts', resolver = 'packages/core/src/agent-input-context-capture-resolve.ts'
const unitMutants = [
  { id: 'changed-original-intent', file: mainOwner,
    from: 'if (retained && JSON.stringify(retained.receipt.record) !== JSON.stringify(record)) throw conflict()', to: '/* private mutation: do not validate the original intent */', expected: 'refuses a changed prompt under the original input ID' },
  { id: 'existing-file-reconciliation', file: mainOwner,
    from: 'if (JSON.stringify(original) !== JSON.stringify(value)) throw conflict()', to: '/* private mutation: accept a conflicting original file */', expected: 'does not let temporary-file cleanup replace an original conflict' },
  { id: 'capture-digest-binding', file: resolver,
    from: 'JSON.stringify(proof) !== JSON.stringify({ reference: expected.reference, binding: expected.binding, intentDigest: expected.intentDigest })', to: 'false', expected: 'resolves only the exact original record' },
  { id: 'original-frozen-producer', file: resolver,
    from: 'const original = await readFrozen()', to: 'const original = undefined', expected: 'reads saved provenance before Main' }
]
const nativeMutants = [
  { id: 'native-page-observation', file: 'apps/desktop/src/main/browser-view-manager.ts',
    from: 'page: { url: contents.getURL() || entry.requestedUrl, title: contents.getTitle() },', to: "page: { url: 'about:blank', title: contents.getTitle() },", expected: 'Capture must use the real original Browser URL' },
  { id: 'public-capture-owner', file: 'packages/core/src/public-rpc-service.ts',
    from: 'await this.ports.inputContextCaptures.read(reference, context.signal ? { signal: context.signal } : undefined)', to: "{ reference, record: null, diskDurability: 'unconfirmed' }", expected: 'actual public Main owner returned the original capture' },
  { id: 'hosted-reader-port', file: 'packages/core/src/hosted-runtime-service.ts',
    from: "...(this.inputContextCaptureReader ? { captureReader: this.inputContextCaptureReader } : {}),", to: '/* private mutation: omit the installed Host reader */', expected: 'actual Hosted reader reaches original capture' }
]
for (const mutant of [...unitMutants, ...nativeMutants]) {
  const file = join(root, mutant.file); await bind(file)
  assert.equal((await readFile(file, 'utf8')).split(mutant.from).length, 2, 'Unique production anchor: ' + mutant.id)
}

async function units(label, mutation) {
  const report = join(output, label + '.tests.json'), loads = join(output, label + '.loads.json'), config = join(output, label + '.config.mts')
  await writeFile(config, `import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const mutation=${JSON.stringify(mutation ?? null)},loads={};const hash=s=>createHash('sha256').update(s).digest('hex');
export default {cacheDir:${JSON.stringify(join(output, label + '-cache'))},plugins:[{name:'private-capture-production',enforce:'pre',load(id){
if(!mutation||id.split('?')[0]!==${JSON.stringify(root)}+'/'+mutation.file)return;const original=readFileSync(id.split('?')[0],'utf8');
const source=original.replace(mutation.from,mutation.to);loads[mutation.file]={original:hash(original),consumed:hash(source)};writeFileSync(${JSON.stringify(loads)},JSON.stringify(loads));return source;
}}],test:{include:['apps/desktop/test/browser-input-context-capture.test.ts','packages/core/test/agent-input-context-capture.test.ts'],passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:10000}};
`)
  const result = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=default', '--reporter=json', '--outputFile.json=' + report], process.env, label)
  const tests = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(tests.testResults.length, 2); assert.ok(tests.numTotalTests >= 26); assert.equal(tests.numPendingTests, 0)
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  for (const file of tests.testResults) assert.equal(file.message, '', 'Collection/setup failure is not assertion RED')
  if (mutation) {
    const assertion = tests.testResults.flatMap(file => file.assertionResults).find(item => item.fullName.includes(mutation.expected))
    assert.notEqual(result.code, 0); assert.equal(assertion?.status, 'failed', 'Owning behavior must turn RED: ' + mutation.id)
    assert.ok(assertion.failureMessages.some(text => /AssertionError|promise resolved|promise rejected/isu.test(text)), 'Only the original owning assertion qualifies')
    const loaded = JSON.parse(await readFile(loads, 'utf8'))[mutation.file]
    assert.equal(loaded.original, sources.get(mutation.file)); assert.equal(loaded.consumed, hash((await readFile(join(root, mutation.file), 'utf8')).replace(mutation.from, mutation.to)))
  } else { assert.equal(result.code, 0, label + ': inspect log'); assert.equal(tests.numFailedTests, 0) }
  receipt.runs.push({ label, exit: result.code, tests: tests.numTotalTests, mutation: mutation?.id ?? null }); await save()
  console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
}

const aliases = {}
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json')
  let pkg; try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  for (const [key, spec] of Object.entries(pkg.exports ?? {})) {
    const target = typeof spec === 'string' ? spec : spec.import
    if (!target?.startsWith('./dist/')) continue
    const source = resolve(dirname(manifest), target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    try { await stat(source); aliases[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source } catch {}
  }
}
async function cleanupDaemon(directory) {
  const listing = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (match && match[2].includes('/ctxmuxd ') && match[2].includes('--socket ' + join(directory, 'runtime/ctxmux.sock')) &&
      match[2].includes('--state-dir ' + join(directory, 'state/ctxmux'))) process.kill(Number(match[1]), 'SIGTERM')
  }
}
async function native(label, mutation) {
  const directory = await mkdtemp(fixturePath('tmp/amx-bcap-')), packageRoot = join(directory, 'package'), dist = join(packageRoot, 'dist')
  await mkdir(dist, { recursive: true })
  for (const name of ['bin', 'vendor', 'package.json', 'node_modules']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
  await writeFile(join(directory, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('captureProof',{capture:id=>ipcRenderer.invoke('browser:captureInputContext',id),freeze:input=>ipcRenderer.invoke('browser:freezeInputContext',input)});`)
  await writeFile(join(directory, 'bootstrap.cjs'), `const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(directory)};
for(const key of ['home','appData','userData','sessionData']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}
const fail=e=>{console.error(e);fs.writeFileSync(path.join(root,'native-receipt.json'),JSON.stringify({passed:false,failure:{name:e.name,message:e.message,stack:e.stack}}));app.exit(1)};
process.on('uncaughtException',fail);app.whenReady().then(()=>import(${JSON.stringify(join(dist, 'main.mjs'))})).catch(fail);`)
  let applied = false
  try {
    const options = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: aliases,
      external: ['electron'], metafile: true, logLevel: 'warning',
      banner: { js: "import {createRequire as __createProofRequire} from 'node:module';const require=__createProofRequire(import.meta.url);" },
      plugins: [{ name: 'actual-capture-production', setup(plugin) {
        plugin.onResolve({ filter: /^[^./]/ }, async args => {
          if (isBuiltin(args.path) || args.path === 'electron' || aliases[args.path]) return null
          const resolver = createRequire(args.importer || join(root, 'package.json'))
          const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
          let entry
          for (const directory of resolver.resolve.paths(name) ?? []) {
            try {
              const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
              const spec = pkg.exports?.[parts.length ? './' + parts.join('/') : '.'] ?? (!parts.length ? pkg.exports : undefined)
              const target = typeof spec === 'string' ? spec : typeof spec?.import === 'string' ? spec.import : spec?.import?.default
              if (!target) continue
              entry = resolve(dirname(manifest), target); await stat(entry); await bind(manifest); break
            } catch {}
          }
          return { path: entry ?? resolver.resolve(args.path), external: true }
        })
        plugin.onLoad({ filter: /\.ts$/ }, async args => {
          if (!mutation || args.path !== join(root, mutation.file)) return null
          const original = await readFile(args.path, 'utf8'); applied = true
          return { contents: original.replace(mutation.from, mutation.to), loader: 'ts', resolveDir: dirname(args.path) }
        })
      } }] }
    const built = await build({ ...options, entryPoints: ['apps/desktop/scripts/fixtures/browser-input-context-capture/main.ts'], outfile: join(dist, 'main.mjs') })
    const api = await build({ ...options, stdin: { resolveDir: root, loader: 'ts', contents: [
      'export * from "./packages/core/src/index.ts"',
      'export {AgentMuxControlServer} from "./packages/core/src/public-rpc-server.ts"',
      'export {AgentMuxHostedRuntimeService} from "./packages/core/src/hosted-runtime-service.ts"',
      'export {composeAgentPrompt} from "./packages/core/src/agent-outbound-message.ts"',
      'export {createDesktopInputContextCaptureReader} from "./apps/host/src/input-context-capture-reader.ts"'
    ].join('\n') }, outfile: join(dist, 'api.mjs') })
    const listener = await build({ ...options, entryPoints: ['packages/core/src/control-endpoint-listener-worker.ts'], outfile: join(dist, 'control-endpoint-listener-worker.js') })
    if (mutation) assert.ok(applied, 'Native candidate consumed the production mutation')
    for (const file of new Set([...Object.keys(built.metafile.inputs), ...Object.keys(api.metafile.inputs), ...Object.keys(listener.metafile.inputs)])) if (file !== '<stdin>') await bind(resolve(root, file))
    for (const expected of [mainOwner, 'apps/desktop/src/main/browser-view-manager.ts', resolver, 'apps/host/src/input-context-capture-reader.ts']) {
      assert.ok(built.metafile.inputs[expected], 'Native product consumer loaded: ' + expected)
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { AGENTMUX_CAPTURE_ROOT: directory, AGENTMUX_CAPTURE_SOURCE: root, AGENTMUX_CAPTURE_NODE: process.execPath,
      AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
    const result = await execute(require('electron'), [join(directory, 'bootstrap.cjs')], env, label)
    if (result.code !== 0) {
      for (const name of ['main.mjs', 'api.mjs']) await writeFile(join(output, label + '-' + name), await readFile(join(dist, name)))
    }
    const actual = JSON.parse(await readFile(join(directory, 'native-receipt.json'), 'utf8'))
    await writeFile(join(output, label + '.native.json'), JSON.stringify(actual, null, 2))
    if (mutation) {
      assert.notEqual(result.code, 0); assert.equal(actual.passed, false)
      assert.match(actual.failure?.stack ?? '', /AssertionError/u); assert.ok(actual.failure.message.includes(mutation.expected), 'Exact native assertion: ' + mutation.id)
    } else { assert.equal(result.code, 0, label + ': inspect log'); assert.equal(actual.passed, true) }
    receipt.runs.push({ label, exit: result.code, mutation: mutation ? { id: mutation.id, file: mutation.file,
      original: sources.get(mutation.file), consumed: hash((await readFile(join(root, mutation.file), 'utf8')).replace(mutation.from, mutation.to)) } : null, actual }); await save()
    console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
  } finally { await cleanupDaemon(directory); await rm(directory, { recursive: true, force: true }) }
}
try {
  if (!process.argv.includes('--native-only')) {
    await units('baseline')
    for (const mutation of unitMutants) await units(mutation.id + '-red', mutation)
    await units('restored')
  }
  if (!process.argv.includes('--units-only')) {
    await native('native-baseline')
    if (!process.argv.includes('--source-only')) for (const mutation of nativeMutants) await native(mutation.id + '-red', mutation)
    if (!process.argv.includes('--source-only')) await native('native-restored')
  }
  for (const [file, digest] of sources) assert.equal(hash(await readFile(join(root, file))), digest, 'Final exact source: ' + file)
  receipt.passed = !process.argv.includes('--source-only') && !process.argv.includes('--native-only') && !process.argv.includes('--units-only'); await save()
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; await save(); throw error }
