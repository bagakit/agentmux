import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join, relative, dirname } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
import { radixOverlayAliases } from './radix-overlay-aliases.ts'
import { assertWorkspaceDistBuiltFromCurrentSource } from '../../../vitest.dist-freshness.ts'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'

const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json')), esbuild = createRequire(require.resolve('vite'))('esbuild')
const args = process.argv.slice(2), caseIndex = args.indexOf('--case'), outputIndex = args.indexOf('--output')
const selected = args[caseIndex + 1]
const workerLabel = process.env.AGENTMUX_MODAL_PRIVATE_WORKER
assert.ok(caseIndex >= 0 && ['scrim', 'input', 'shared'].includes(selected), 'Use --case scrim|input|shared [--mutations] [--output DIRECTORY]')
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--case' || args[i] === '--output') { assert.ok(args[++i], 'Option requires a value'); continue }
  assert.equal(args[i], '--mutations', 'Unknown option')
}
const output = outputIndex < 0 ? join(repository, '.tmp/modal-boundaries', randomUUID()) : resolve(args[outputIndex + 1])
await mkdir(output, { recursive: true }); if (!workerLabel) assert.equal((await readdir(output)).length, 0, 'Select a fresh evidence directory')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = join(desktop, 'scripts/fixtures/modal-boundaries'), originals = new Map(), dependencyInputs = new Map(), results = []
const receipt = { schema: 'agentmux.modal-boundaries.v1', case: selected, passed: false, results,
  boundary: 'Isolated actual production owners and native Electron compositor/input; no user Browser, Session, physical keyboard or installed App is operated.',
  candidate: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository }).toString().trim(),
    status: execFileSync('git', ['status', '--short'], { cwd: repository }).toString() },
  aestheticReview: 'independent-review-pending' }
assert.equal(receipt.candidate.status, '', 'A proof invocation requires its exact clean candidate')
const mutations = {
  scrim: [{ label: 'mask-default-origin', path: 'apps/desktop/src/main/native-overlay-scrim.ts',
    before: "mask.setAttribute('x','0'); mask.setAttribute('y','0');", after: '', expected: /scrim.*pixel/i }],
  input: [{ label: 'page-protocol-interception', path: 'apps/desktop/src/main/browser-view-manager.ts',
    before: 'surface.presentations.set(token, failed)',
    after: "surface.presentations.set(token, failed); owner.view.webContents.on('before-mouse-event', event => event.preventDefault())",
    expected: /input CDP must still perform/ }], shared: [
    { label: 'nonfocusable-boundary', path: 'packages/client-ui/src/components/Modal.tsx',
      before: '<div ref={setBoundary} data-overlay-modal-boundary=""',
      after: '<div ref={setBoundary} data-overlay-modal-boundary="" style={{ display: \'contents\' }}', expected: /shared focus fallback/ },
    { label: 'ime-escape-boundary', path: 'packages/client-ui/src/components/Modal.tsx',
      before: 'if (isImeOwnedKeyboardEvent(event)) { event.preventDefault(); return }',
      after: 'if (false) { event.preventDefault(); return }', expected: /shared IME Escape/ },
    { label: 'ime-form-submission', path: 'apps/desktop/src/renderer/src/components/HostFolderDialog.tsx',
      before: "if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event)) event.preventDefault()",
      after: 'if (false) event.preventDefault()', expected: /shared IME Enter/ },
    { label: 'input-selection-adoption', path: 'packages/client-ui/src/components/Modal.tsx',
      before: "if (textSelection) textControl!.setSelectionRange(textSelection.start, textSelection.end, textSelection.direction ?? 'none')",
      after: 'void textSelection', expected: /shared document move retains the original text selection/ },
    { label: 'document-focus-rebind', path: 'packages/client-ui/src/components/Modal.tsx',
      before: 'if (!close && transferred && transferred.attempt === attemptId && transferred.element.ownerDocument === behaviorDocument && (boundary?.boundary ?? element).contains(transferred.element)) {',
      after: 'if (false) {', expected: /shared document move retains the original text selection/ }
  ]
}
async function run(label, mutation) {
  if (selected !== 'scrim') await assertWorkspaceDistBuiltFromCurrentSource(repository)
  const directory = join(output, label); await mkdir(directory)
  const consumed = {}, dependencies = {}, changed = []
  const observe = async (file, source) => {
    const dependency = file.includes('/node_modules/')
    if ((!file.startsWith(repository + '/') && !dependency) || file.startsWith(directory + '/')) return source
    const name = relative(repository, file), bytes = source ?? await readFile(file), digest = sha(bytes)
    const bindings = dependency ? dependencyInputs : originals
    ;(dependency ? dependencies : consumed)[name] = digest
    if (bindings.has(name)) assert.equal(digest, bindings.get(name), 'Proof inputs changed; rerun this case: ' + name)
    else bindings.set(name, digest)
    if (mutation?.path !== name || source === undefined) return source
    assert.ok(mutation.before, 'Mutation must select an actual owner anchor')
    assert.equal(String(source).split(mutation.before).length, 2, 'Mutation must match one actual production owner')
    const loaded = source.replace(mutation.before, mutation.after)
    changed.push({ file: name, sourceSHA256: digest, loadedSHA256: sha(loaded), productionWritten: false })
    await writeFile(join(directory, 'mutation-original.txt'), source); await writeFile(join(directory, 'mutation-loaded.txt'), loaded)
    return loaded
  }
  const plugin = { name: 'modal-boundary-source-identity', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\/core(?:\/|$)/ }, entry => ({ path: fileURLToPath(import.meta.resolve(entry.path)), external: true }))
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async entry => {
      const source = await readFile(entry.path, 'utf8'), loaded = await observe(entry.path, source)
      return { contents: loaded, loader: /\.tsx$/.test(entry.path) ? 'tsx' : /\.ts$/.test(entry.path) ? 'ts' : 'js' }
    })
  } }
  for (const file of ['pnpm-lock.yaml', 'apps/desktop/scripts/verify-modal-boundaries.mjs', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/radix-overlay-aliases.ts', 'apps/desktop/scripts/package-smoke-context.mjs', 'vitest.dist-freshness.ts', ...(selected === 'shared' ? ['apps/desktop/scripts/fixtures/modal-boundaries/index.html'] : [])]) await observe(join(repository, file))
  const electronModule = require.resolve('electron')
  await observe(electronModule); await observe(join(dirname(electronModule), 'path.txt'))
  const electronExecutable = require('electron'); await observe(electronExecutable)
  await esbuild.build({ absWorkingDir: repository, entryPoints: [join(fixture, selected + '.ts')], outfile: join(directory, 'main.mjs'),
    bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent', plugins: [plugin],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
  if (selected === 'shared') {
    const { build } = await import('vite')
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: radixOverlayAliases }, worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
      plugins: [{ name: 'modal-shared-source-identity', enforce: 'pre', async transform(source, id) {
        if (id.includes('\0')) return
        const file = id.split('?')[0]
        if (!/\.(?:[cm]?[jt]sx?|css)$/.test(file) || (!file.startsWith(repository + '/') && !file.includes('/node_modules/'))) return
        const original = await readFile(file, 'utf8'), loaded = await observe(file, original)
        return loaded === original ? undefined : loaded
      }, async generateBundle() { for (const watched of this.getWatchFiles()) {
        if (watched.includes('\0')) continue
        const file = resolve(fixture, watched)
        if (/\.(?:[cm]?[jt]sx?|css|json|png|svg|woff2?|ttf)$/.test(file)) await observe(file)
      } } }],
      build: { outDir: join(directory, 'renderer'), emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] }, rollupOptions: { input: join(fixture, 'index.html') } } })
  }
  assert.equal(changed.length, mutation ? 1 : 0, 'Only the selected production source may be privately mutated')
  const compiled = {}
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name)
    if (/\.(?:m?js|css|html)$/.test(file)) compiled[relative(directory, file)] = sha(await readFile(file))
  }
  assert.ok(Object.keys(consumed).some(file => file.startsWith('apps/desktop/src/')), 'Compile a nonempty actual product owner')
  assert.ok(Object.keys(dependencies).some(file => file.includes('/node_modules/')), 'Observe nonempty actual installed NPM dependencies, including the Electron launcher')
  if (selected === 'shared') for (const name of ['react-dom', '@radix-ui/react-dialog']) assert.ok(Object.keys(dependencies).some(file => file.includes('/node_modules/' + name + '/')), 'Observe the actual Renderer dependency bytes: ' + name)
  assert.ok(Object.keys(compiled).length > 0, 'Bind nonempty actual compiled artifacts')
  await writeFile(join(directory, 'inputs.json'), JSON.stringify({ consumed, dependencies, compiled, changed }, null, 2))
  const privateEnv = privatePackageSmokeEnvironment(process.env, { userData: join(directory, 'profile'), runtimeRoot: join(directory, 'runtime'), readyFile: join(directory, 'unused-ready.json') })
  const paths = { home: privateEnv.HOME, appData: join(directory, 'app-data'), userData: join(directory, 'profile'), sessionData: join(directory, 'session-data') }
  for (const path of [...Object.values(paths), privateEnv.TMPDIR]) await mkdir(path, { recursive: true })
  await writeFile(join(directory, 'bootstrap.cjs'), `
const {app}=require('electron'),{mkdirSync,writeFileSync}=require('node:fs');const paths=${JSON.stringify(paths)};
for(const [name,path]of Object.entries(paths)){mkdirSync(path,{recursive:true});app.setPath(name,path);if(app.getPath(name)!==path)throw new Error('Private Electron path was not adopted: '+name)}
writeFileSync(${JSON.stringify(join(directory, 'isolation.json'))},JSON.stringify({paths,removedInheritedIdentity:!process.env.AGENTMUX_AGENT_SESSION_ID&&!process.env.AGENTMUX_RUN_ID&&!process.env.AGENTMUX_HOOK_URL&&!process.env.AGENTMUX_CONTROL_ENDPOINT,home:process.env.HOME}));
const {registerHooks}=require('node:module'),{readFileSync,appendFileSync}=require('node:fs'),{fileURLToPath}=require('node:url'),{createHash}=require('node:crypto');
registerHooks({load(url,context,next){const loaded=next(url,context);if(url.startsWith('file:')){const file=fileURLToPath(url);if((file.startsWith(${JSON.stringify(repository + '/')})||file.includes('/node_modules/'))&&!file.startsWith(${JSON.stringify(directory + '/')}))appendFileSync(${JSON.stringify(join(directory, 'node-loads.ndjson'))},JSON.stringify({file,sha256:createHash('sha256').update(loaded.source??readFileSync(file)).digest('hex')})+'\\n')}return loaded}});
import('./main.mjs').catch(error=>{console.error(error);require('electron').app.exit(1)});
`)
  compiled['bootstrap.cjs'] = sha(await readFile(join(directory, 'bootstrap.cjs')))
  const env = { ...privateEnv, AGENTMUX_MODAL_CASE_OUTPUT: directory }
  const lines = [], processReceipt = await runProbeProcess(electronExecutable, [join(directory, 'bootstrap.cjs')], {
    cwd: repository, env, temporaryRoot: directory, timeoutMs: 60000, onLine: line => lines.push(line)
  })
  await writeFile(join(directory, 'process.log'), lines.join('\n')); await writeFile(join(directory, 'process.json'), JSON.stringify(processReceipt, null, 2))
  await stopProbeProcesses(processReceipt.originalPid, directory)
  assert.deepEqual(await listProbeProcesses(processReceipt.originalPid, directory), [], 'Release only this exact private probe')
  assert.equal(processReceipt.timedOut, false, 'Timeout cannot count as mutation evidence')
  assert.equal(processReceipt.exitConfirmed, true)
  const actual = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
  const nodeLoads = (await readFile(join(directory, 'node-loads.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (selected === 'input') assert.ok(nodeLoads.some(entry => entry.file.endsWith('/packages/core/dist/index.js')), 'Observe the actual external product Core loader input')
  for (const loaded of nodeLoads) { const file = relative(repository, loaded.file); assert.equal(sha(await readFile(loaded.file)), loaded.sha256, 'External runtime loader input unchanged: ' + file); await observe(loaded.file) }
  await writeFile(join(directory, 'inputs.json'), JSON.stringify({ consumed, dependencies, compiled, changed, nodeLoads }, null, 2))
  const runtimeNpm = nodeLoads.filter(entry => entry.file.includes('/node_modules/'))
  if (selected === 'input') {
    assert.ok(runtimeNpm.length > 0, 'Observe nonempty actual runtime NPM loader inputs')
    assert.ok(runtimeNpm.every(entry => dependencies[relative(repository, entry.file)] === entry.sha256), 'Every actual runtime NPM loader input must be indexed independently of the launcher')
  }
  assert.ok(actual.cases.length > 0, 'The actual case must reach a nonempty independent oracle')
  if (mutation) { assert.equal(processReceipt.exitCode, 1); assert.equal(actual.passed, false); assert.match(actual.failure?.message ?? '', mutation.expected) }
  else { assert.equal(processReceipt.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true) }
  for (const bindings of [consumed, dependencies]) for (const [file, digest] of Object.entries(bindings)) assert.equal(sha(await readFile(join(repository, file))), digest, 'Original proof bytes remain unchanged: ' + file)
  for (const [file, digest] of Object.entries(compiled)) assert.equal(sha(await readFile(join(directory, file))), digest, 'Actual compiled proof bytes remain unchanged: ' + file)
  results.push({ label, expected: mutation ? 'RED' : 'GREEN', actual, changed, directory: relative(output, directory) })
  console.log(selected + '/' + label + ': ' + (mutation ? 'expected RED' : 'GREEN; independent image review pending'))
}
async function isolatedRound(label, mutation) {
  // A full production Renderer build releases its Vite module graph with this
  // child, rather than retaining several compilation graphs during mutations.
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--case', selected, '--output', output], {
    cwd: repository, env: { ...process.env, AGENTMUX_MODAL_PRIVATE_WORKER: label }, maxBuffer: 1024 * 1024, timeout: 180000
  })
  process.stdout.write(stdout)
  const round = JSON.parse(await readFile(join(output, label + '-round.json'), 'utf8'))
  assert.equal(round.passed, true, round.failure?.message)
  const inputs = JSON.parse(await readFile(join(output, label, 'inputs.json'), 'utf8'))
  assert.ok(Object.keys(inputs.consumed).some(file => file.startsWith('apps/desktop/src/')) && Object.keys(inputs.dependencies).length > 0 && Object.keys(inputs.compiled).length > 0, 'Every round binds nonempty product, dependency and compiled input sets')
  for (const [bindings, prior] of [[inputs.consumed, originals], [inputs.dependencies, dependencyInputs]]) for (const [file, digest] of Object.entries(bindings)) {
    if (prior.has(file)) assert.equal(digest, prior.get(file), 'Every round consumes the same original input: ' + file)
    else prior.set(file, digest)
    assert.equal(sha(await readFile(join(repository, file))), digest, 'Exact candidate or dependency input is still current: ' + file)
  }
  for (const [file, digest] of Object.entries(inputs.compiled)) assert.equal(sha(await readFile(join(output, label, file))), digest, 'Exact compiled round input is still current: ' + file)
  assert.equal(round.results[0]?.expected, mutation ? 'RED' : 'GREEN'); results.push(...round.results)
}
try {
  if (workerLabel) {
    const mutation = mutations[selected].find(row => row.label === workerLabel)
    assert.ok(workerLabel === 'candidate' || workerLabel === 'restored' || mutation, 'Unknown private worker round')
    await run(workerLabel, mutation)
  } else {
    await isolatedRound('candidate')
    if (args.includes('--mutations')) { assert.ok(mutations[selected].length > 0, 'This case requires an actual production mutation'); for (const mutation of mutations[selected]) await isolatedRound(mutation.label, mutation); await isolatedRound('restored') }
  }
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository }).toString().trim(), receipt.candidate.head, 'The original candidate HEAD remains unchanged')
  assert.equal(execFileSync('git', ['status', '--short'], { cwd: repository }).toString(), receipt.candidate.status, 'The original candidate worktree remains unchanged')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(output, workerLabel ? workerLabel + '-round.json' : 'receipt.json'), JSON.stringify(receipt, null, 2)); if (!workerLabel) console.log('Evidence: ' + output) }
