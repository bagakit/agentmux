import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = new Set(process.argv.slice(2))
for (const arg of args) assert.ok(['--mutations', '--restart', '--visual', '--native-owners'].includes(arg), 'Unknown private Browser verification option: ' + arg)
assert.ok(!args.has('--visual') || args.has('--restart'), 'Visual proof consumes the actual product restart scenario')
const nativeOnly = args.has('--native-owners')
assert.ok(!nativeOnly || !args.has('--restart'), 'The hidden Session slice is separate from the complete App restart gate')
const config = 'apps/desktop/scripts/fixtures/browser-private/vitest.config.mts'
const manager = 'apps/desktop/src/main/browser-view-manager.ts', ipc = 'apps/desktop/src/main/ipc.ts'
const ownerTest = 'apps/desktop/test/browser-view-manager.test.ts'
const historyTest = 'apps/desktop/test/browser-input-history-ipc.test.ts'
const batches = [
  { label: 'owners', tests: [ownerTest, historyTest, 'apps/desktop/test/browser-private-persistence.test.ts', 'packages/core/test/browser-private-mode.test.ts'] },
  { label: 'mounted-public-and-menu', tests: ['apps/desktop/test/control.test.ts', 'apps/desktop/test/survey-surface.test.tsx'], filter: 'private (public creation|Survey|More|Research)' }
]
const mutations = [
  { label: 'private-partition-persisted', source: manager,
    find: 'const partition = `agentmux-browser-private:${randomUUID()}`', replace: 'const partition = `persist:agentmux-browser-private:${randomUUID()}`',
    test: ownerTest, consumer: 'private owner retains one session across release and ends only that incarnation on close', failure: /private session must not use a persistent partition/ },
  { label: 'closed-incarnation-reused', source: manager,
    find: 'const partition = `agentmux-browser-private:${randomUUID()}`', replace: 'const partition = `agentmux-browser-private:${id}`',
    test: ownerTest, consumer: 'private owner retains one session across release and ends only that incarnation on close', failure: /closed private incarnation must never be reused/ },
  { label: 'private-input-persisted-in-default-profile', source: ipc,
    find: "return scope.profileId === null ? { scope, entries: [], outcome: 'private' } : await browserInputHistory.record(scope, text)",
    replace: 'return await browserInputHistory.record(scope.profileId === null ? { ...scope, profileId: browserProfiles.defaultProfileId() } : scope, text)',
    test: historyTest, consumer: 'private input does not read or write persistent history, through actual preload and Main handlers', failure: /private input must not change the real persistent history bytes/ }
]
const require = createRequire(resolve('package.json')), cli = require.resolve('vitest/vitest.mjs')
const desktopRequire = createRequire(resolve('apps/desktop/package.json'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const temporary = await mkdtemp(join(tmpdir(), 'agentmux-browser-private-proof-'))
const out = resolve('.local/browser-private/' + (nativeOnly ? 'native-owner-proof' : 'proof')); await mkdir(out, { recursive: true })
const previous = await readFile(join(out, 'receipt.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error })
if (previous) await writeFile(join(out, 'receipt-' + sha(previous) + '.json'), previous)
await rm(join(out, 'receipt.json'), { force: true })
const product = [manager, ipc, 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/shared/browser-input-history.ts', 'apps/desktop/src/shared/client-observation.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts',
  'apps/desktop/src/renderer/src/lib/browser-state.ts', 'apps/desktop/src/renderer/src/lib/survey-browser-creation.ts',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/BrowserProfilesPanel.tsx',
  'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', 'apps/desktop/src/renderer/src/styles/browser.css',
  ...['control.ts', 'control-codec.ts', 'control-browser-targets.ts', 'browser-targets.ts', 'agentmux-cli-commands.ts', 'agentmux-cli-browser-guide.ts', 'index.ts'].map(name => 'packages/core/src/' + name)]
const inputs = [...new Set([...product, ...batches.flatMap(batch => batch.tests), config, 'apps/desktop/scripts/verify-browser-private.mjs',
  'apps/desktop/scripts/fixtures/browser-private/main.ts', 'apps/desktop/scripts/browser-private-probe-scenario.mjs',
  'apps/desktop/scripts/verify-browser-recovery-restart.mjs', 'apps/desktop/scripts/probe-process.mjs',
  'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'apps/desktop/src/main/native-overlay-surfaces.ts',
  'apps/desktop/src/main/native-overlay-focus.ts', 'apps/desktop/src/preload/native-overlay-focus.ts',
  ...['index.js', 'agentmux.js', 'control-codec.js', 'control-browser-targets.js', 'browser-targets.js', 'agentmux-cli-commands.js', 'agentmux-cli-browser-guide.js'].map(name => 'packages/core/dist/' + name),
  'apps/desktop/scripts/radix-overlay-aliases.ts', 'apps/desktop/electron.vite.config.ts', 'vitest.config.ts', 'vitest.dist-freshness.ts'])]
const fingerprint = async () => Object.fromEntries(await Promise.all(inputs.map(async path => [path, sha(await readFile(path))])))
const evidence = { schema: 'agentmux.browser-private-proof.v1', scope: nativeOnly ? 'native-session-owners' : args.has('--restart') ? 'complete-product' : 'bounded-consumers', passed: false, sourceInputs: await fingerprint(), cases: [],
  boundary: 'Unit Session doubles prove Main ownership and callback wiring. Real Electron website isolation, public SDK/CLI and restart are separate required product consumers.' }

function child(program, argv, budget = 60_000, binary = process.execPath, env = process.env) {
  return new Promise((done, reject) => {
    const processChild = spawn(binary, [program, ...argv], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', expired = false, escalation
    processChild.stdout.on('data', bytes => { output += bytes }); processChild.stderr.on('data', bytes => { output += bytes })
    const timer = setTimeout(() => { expired = true; processChild.kill('SIGTERM'); escalation = setTimeout(() => processChild.kill('SIGKILL'), 1000) }, budget)
    processChild.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    processChild.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      expired ? reject(Object.assign(new Error('The exact private proof child timed out and exited'), { output, code, signal })) : done({ code, signal, output })
    })
  })
}
async function nativeOwner(label, mutation) {
  const { build } = createRequire(desktopRequire.resolve('vite'))('esbuild'), compiled = join(temporary, label), source = await readFile(manager, 'utf8')
  await mkdir(compiled); await mkdir(join(compiled, 'home')); await symlink(resolve('apps/desktop/node_modules'), join(compiled, 'node_modules'))
  const program = join(compiled, 'main.mjs'), report = join(compiled, 'receipt.json'), bootstrap = join(compiled, 'bootstrap.cjs')
  await writeFile(bootstrap, `const {app}=require('electron');const {writeFileSync}=require('node:fs');
app.setPath('userData',${JSON.stringify(join(compiled, 'user-data'))});app.setPath('home',${JSON.stringify(join(compiled, 'home'))});
if(process.platform==='darwin')app.setActivationPolicy('prohibited');
function fail(error){writeFileSync(${JSON.stringify(report)},JSON.stringify({passed:false,cases:[],stage:'module-bootstrap',failure:{message:String(error),stack:error?.stack}}));app.exit(1)}
process.on('uncaughtException',fail);import('./main.mjs').catch(fail)`)
  let consumed
  if (mutation) assert.equal(source.split(mutation.find).length - 1, 1)
  const built = await build({ entryPoints: ['apps/desktop/scripts/fixtures/browser-private/main.ts'], outfile: program,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', metafile: true,
    plugins: mutation ? [{ name: 'private-original-session-mutation', setup(build) { build.onLoad({ filter: /browser-view-manager\.ts$/ }, async input => {
      assert.equal(input.path, resolve(manager)); const code = source.replace(mutation.find, mutation.replace)
      consumed = { source: manager, sha256: sha(code) }; return { contents: code, loader: 'ts' }
    }) } }] : [] })
  if (mutation) assert.deepEqual(consumed, { source: manager, sha256: sha(source.replace(mutation.find, mutation.replace)) })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { HOME: join(compiled, 'home'), AGENTMUX_PRIVATE_OWNER_ROOT: compiled, AGENTMUX_PRIVATE_OWNER_RECEIPT: report,
    AGENTMUX_RUNTIME_DIRECTORY: join(compiled, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(compiled, 'state') })
  let result
  try { result = await child(bootstrap, ['--agentmux-probe-root=' + compiled], 40_000, desktopRequire('electron'), env) }
  catch (error) {
    await writeFile(join(out, label + '.log'), (error.output ?? error.message).replaceAll(process.cwd(), '<repository>').replaceAll(temporary, '<private-proof>'))
    const stage = await readFile(report + '.stage.json', 'utf8').catch(() => '{"stage":"no-module-body-receipt"}')
    await writeFile(join(out, label + '.failure.json'), stage.replaceAll(process.cwd(), '<repository>').replaceAll(temporary, '<private-proof>'))
    throw error
  }
  await writeFile(join(out, label + '.log'), result.output.replaceAll(process.cwd(), '<repository>').replaceAll(temporary, '<private-proof>'))
  const raw = await readFile(report, 'utf8'), stage = await readFile(report + '.stage.json', 'utf8').catch(() => null)
  assert.ok(raw.trim(), 'Actual native child exited without a complete receipt: ' + JSON.stringify({ code: result.code, signal: result.signal, stage }))
  const actual = JSON.parse(raw)
  await writeFile(join(out, label + '.actual.json'), JSON.stringify(actual, null, 2).replaceAll(process.cwd(), '<repository>').replaceAll(temporary, '<private-proof>') + '\n')
  assert.ok(actual.cases.length > 0, 'The original real Session consumer must execute: ' + JSON.stringify(actual))
  if (mutation) {
    assert.equal(actual.passed, false); assert.equal(result.code, 1)
    assert.match(actual.failure?.message ?? '', label.includes('persisted') ? /actual private Session must be in memory/ : /closed private Session must never be reused/)
  } else { assert.equal(result.code, 0, JSON.stringify(actual)); assert.equal(actual.passed, true); assert.equal(actual.cases.length, 4) }
  const sourceInputs = Object.fromEntries(await Promise.all(Object.keys(built.metafile.inputs).map(async path => [path, sha(await readFile(path))])))
  const { listProbeProcesses } = await import('./probe-process.mjs')
  const end = Date.now() + 3000
  while ((await listProbeProcesses(0, compiled)).length && Date.now() < end) await new Promise(done => setTimeout(done, 50))
  assert.deepEqual(await listProbeProcesses(0, compiled), [], 'The exact hidden owner process and its helpers must exit before cleanup')
  const record = { label, result: mutation ? 'RED' : 'GREEN', sourceInputs, compiledSha256: sha(await readFile(program)),
    ...(mutation ? { mutation: consumed } : {}), actual, cleanup: { remainingProcesses: [] },
    boundary: 'Actual production BrowserViewManager/ProfileStore/Electron Session in a hidden nonactivating fixture. This is website-session proof, not App UI/focus or package proof.' }
  await writeFile(join(out, label + '.json'), JSON.stringify(record, null, 2) + '\n')
  evidence.nativeOwners ??= []; evidence.nativeOwners.push(record)
  process.stdout.write(label + ': ' + record.result + '\n')
}
async function run(label, batch, mutation) {
  const report = join(temporary, label + '.json'), privateConfig = join(temporary, label + '.config.mjs')
  const loaded = join(temporary, label + '.loaded.json')
  let mutantBytes
  if (mutation) {
    const source = await readFile(mutation.source, 'utf8')
    assert.equal(source.split(mutation.find).length - 1, 1, 'Mutation anchor must identify the original owner exactly once')
    mutantBytes = source.replace(mutation.find, mutation.replace)
    const privateSource = join(temporary, label + '.ts'); await writeFile(privateSource, mutantBytes)
    await writeFile(privateConfig, `import base from ${JSON.stringify(pathToFileURL(resolve(config)).href)};
import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
export default {...base,plugins:[...(base.plugins??[]),{name:'private-browser-original-owner-mutation',enforce:'pre',load(id){
if(id.split('?')[0]!==${JSON.stringify(resolve(mutation.source))})return;
const code=readFileSync(${JSON.stringify(privateSource)},'utf8');
writeFileSync(${JSON.stringify(loaded)},JSON.stringify({source:${JSON.stringify(mutation.source)},sha256:createHash('sha256').update(code).digest('hex')}));
return {code,map:null};}}]};`)
  }
  const result = await child(cli, ['run', ...batch.tests, '--config', mutation ? privateConfig : config,
    ...(batch.filter ? ['-t', batch.filter] : []), '--maxWorkers=1', '--fileParallelism=false', '--reporter=json', '--outputFile', report])
  await writeFile(join(out, label + '.log'), result.output.replaceAll(process.cwd(), '<repository>'))
  const raw = JSON.parse(await readFile(report, 'utf8').catch(error => { throw new Error('No fresh original consumer report: ' + result.output.replaceAll(process.cwd(), '<repository>'), { cause: error }) }))
  const assertions = raw.testResults.flatMap(suite => suite.assertionResults), selected = assertions.filter(row => row.status !== 'pending' && row.status !== 'skipped')
  await writeFile(join(out, label + '.consumers.json'), JSON.stringify(selected.map(row => ({ title: row.title, status: row.status,
    failures: row.failureMessages.map(message => message.replaceAll(process.cwd(), '<repository>').replaceAll(temporary, '<private-proof>')) })), null, 2) + '\n')
  assert.ok(selected.length > 0, 'The original owner must run a nonempty actual consumer')
  if (mutation) {
    assert.deepEqual(JSON.parse(await readFile(loaded, 'utf8')), { source: mutation.source, sha256: sha(mutantBytes) })
    assert.equal(selected.length, 1, 'The exact mutation must have one actual selected consumer')
    assert.equal(selected[0].title, mutation.consumer); assert.equal(selected[0].status, 'failed'); assert.equal(result.code, 1)
    assert.match(selected[0].failureMessages.join('\n'), mutation.failure)
    evidence.cases.push({ label, result: 'RED', consumer: mutation.consumer, mutation: { source: mutation.source, sha256: sha(mutantBytes) } })
  } else {
    assert.equal(result.code, 0, result.output.replaceAll(process.cwd(), '<repository>'))
    assert.ok(selected.every(row => row.status === 'passed'))
    for (const test of batch.tests) assert.ok(raw.testResults.some(suite => suite.name === resolve(test) && suite.assertionResults.some(row => row.status === 'passed')), 'Every selected suite must have an actual passing consumer: ' + test)
    evidence.cases.push({ label, result: 'GREEN', tests: selected.length, consumers: selected.map(row => row.fullName) })
  }
  process.stdout.write(label + ': ' + (mutation ? 'expected RED' : 'GREEN') + '\n')
}
try {
  if (!nativeOnly) for (const batch of batches) await run('source-' + batch.label, batch)
  if (!nativeOnly && args.has('--mutations')) {
    for (const mutation of mutations) await run(mutation.label, { tests: [mutation.test], filter: mutation.consumer }, mutation)
    for (const batch of batches) await run('restored-source-' + batch.label, batch)
  }
  if (nativeOnly || args.has('--mutations')) {
    await nativeOwner('native-source')
    if (args.has('--mutations')) {
      await nativeOwner('native-private-partition-persisted', mutations[0])
      await nativeOwner('native-closed-incarnation-reused', mutations[1])
      await nativeOwner('native-restored-source')
    }
  }
  if (args.has('--restart')) {
    evidence.nativeProduct = []
    for (const crash of [false, true]) {
      const label = crash ? 'crash-restart' : 'ordinary-restart'
      const result = await child(resolve('apps/desktop/scripts/verify-browser-recovery-restart.mjs'), ['--case-private', ...(crash ? ['--private-crash'] : []), ...(!crash && args.has('--visual') ? ['--private-visual'] : [])], 200_000)
      await writeFile(join(out, label + '.log'), result.output.replaceAll(process.cwd(), '<repository>'))
      assert.equal(result.code, 0, result.output)
      const path = crash ? '.tmp/browser-private-crash-restart-last.json' : '.tmp/browser-private-restart-last.json', bytes = await readFile(path), receipt = JSON.parse(bytes)
      assert.equal(receipt.case, 'private'); assert.equal(receipt.passed, true); assert.equal(receipt.completeGate, true)
      evidence.nativeProduct.push({ path, sha256: sha(bytes), receipt })
    }
  }
  assert.deepEqual(await fingerprint(), evidence.sourceInputs, 'The exact source must remain unchanged through all consumers')
  evidence.passed = true
} finally {
  const { listProbeProcesses, signalOwnedProbeProcess } = await import('./probe-process.mjs')
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of await listProbeProcesses(0, temporary)) await signalOwnedProbeProcess(pid, temporary, signal)
    const end = Date.now() + 2000
    while ((await listProbeProcesses(0, temporary)).length && Date.now() < end) await new Promise(done => setTimeout(done, 50))
  }
  const remaining = await listProbeProcesses(0, temporary)
  evidence.cleanup = { remainingProcesses: remaining, temporaryRootRemoved: false }
  if (!remaining.length) { await rm(temporary, { recursive: true, force: true }); evidence.cleanup.temporaryRootRemoved = true }
  else evidence.passed = false
  await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n')
  assert.deepEqual(remaining, [], 'Private proof cleanup must finish without deleting any active process resources')
}
