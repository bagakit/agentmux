import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const requireDesktop = createRequire(join(desktop, 'package.json'))
const output = join(root, '.tmp/workbench-startup-observation', ("attempt-" + (globalThis.crypto.randomUUID()) + ""))
await mkdir(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ts = requireDesktop('typescript')
const { build } = await import(pathToFileURL(requireDesktop.resolve('vite')).href)
const { resolveConfig } = await import(pathToFileURL(requireDesktop.resolve('electron-vite')).href)
const execute = promisify(execFile)
const tracked = ['src/main/workbench-startup-capture.ts', 'src/main/crash-capture.ts', 'src/main/crash-log.ts',
  'src/main/index.ts', 'src/main/ipc.ts', 'src/main/ipc-sender-trust.ts', 'src/main/crash-log-access.ts',
  'src/main/client-observation.ts', 'src/main/window-security.ts', 'src/main/top-frame-navigation.ts',
  'src/preload/index.ts', 'src/shared/contracts.ts', 'src/shared/workbench-startup-failure.ts',
  'src/renderer/index.html', 'src/renderer/src/startup-entry.ts', 'src/renderer/src/lib/renderer-startup-capture.ts',
  'scripts/verify-workbench-startup-capture.mjs', 'test/workbench-startup-capture.test.ts',
  'test/crash-log-diagnostics-control.test.ts'].map(path => join(desktop, path))
const originals = new Map(await Promise.all(tracked.map(async path => [path, await readFile(path, 'utf8')])))
const consumed = new Map()
function consumePlugin(mutant) {
  let replacements = 0
  return { name: 'bind-workbench-startup-sources', enforce: 'pre',
    transform(source, id) {
      if (id.startsWith(root) && !id.includes('node_modules') && !id.includes('/.tmp/')) consumed.set(id, hash(source))
      if (!mutant || id !== join(desktop, mutant.path)) return
      assert.equal(source.split(mutant.before).length - 1, 1, `Mutation must consume exactly one original production span: ${mutant.kind}`)
      replacements += 1
      return source.replace(mutant.before, mutant.after)
    },
    closeBundle() { if (mutant) assert.equal(replacements, 1, `Compiled mutation was not consumed: ${mutant.kind}`) }
  }
}
const main = ts.createSourceFile('index.ts', originals.get(join(desktop, 'src/main/index.ts')), ts.ScriptTarget.Latest, true)
const ipc = ts.createSourceFile('ipc.ts', originals.get(join(desktop, 'src/main/ipc.ts')), ts.ScriptTarget.Latest, true)
let loader, ready, capture, rendererHandler
function visit(node, file) {
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(file) === 'loadPackagedRenderer') loader = node.initializer.getText(file)
    if (node.name.getText(file) === 'startupCapture') capture = node.initializer.getText(file)
  }
  if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'onRendererUpdateReady') ready = node.initializer.getText(file)
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'handleWithEvent' &&
    node.arguments[0]?.getText(file) === "'ui:recordStartupFailure'") rendererHandler = node.arguments[1].getText(file)
  ts.forEachChild(node, child => visit(child, file))
}
visit(main, main); visit(ipc, ipc)
assert.ok(loader && ready && capture && rendererHandler, 'Actual Main window capture/loader/Ready and trusted IPC handler must be reachable')
const adapter = join(output, 'actual-owner.ts')
await writeFile(adapter, `
import { app, ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CrashLog } from ${JSON.stringify(join(desktop, 'src/main/crash-log.ts'))}
import { registerWorkbenchStartupCapture } from ${JSON.stringify(join(desktop, 'src/main/workbench-startup-capture.ts'))}
import { topFrameOrigin, type TopFrameOrigin } from ${JSON.stringify(join(desktop, 'src/main/top-frame-navigation.ts'))}
import { assertSenderTrusted, senderTrust } from ${JSON.stringify(join(desktop, 'src/main/ipc-sender-trust.ts'))}
import { readLoadedPackageIdentity } from ${JSON.stringify(join(desktop, 'src/main/client-observation.ts'))}
export async function wire(window: BrowserWindow, directory: string, sinkFailure: boolean) {
  let updateReady: { token: string; resolve: () => void } | null = null
  let appOrigin: TopFrameOrigin
  const startupAttemptId = randomUUID()
  const packageIdentity = await readLoadedPackageIdentity(join(directory, 'package-identity.json'))
  const crashLog = new CrashLog(join(directory, 'user-data/crash-log.ndjson'))
  if (sinkFailure) crashLog.append = async () => { throw Object.assign(new Error('Controlled ENOSPC diagnostic sink'), { code: 'ENOSPC' }) }
  const startupCapture = ${capture}
  const args = { window, onRendererStartupFailure: (input: unknown) => startupCapture.recordRenderer(input) }
  const requireTrustedSender = (channel: 'ui:recordStartupFailure', event: Electron.IpcMainInvokeEvent) =>
    assertSenderTrusted(senderTrust(channel, event.sender, window.webContents))
  ipcMain.handle('ui:recordStartupFailure', ${rendererHandler})
  const readyTokens: string[] = []
  ipcMain.handle('ui:rendererUpdateReady', (event, token: string) => {
    assertSenderTrusted(senderTrust('ui:rendererUpdateReady', event.sender, window.webContents))
    readyTokens.push(token); (${ready})(token)
  })
  const probeQuery = undefined
  const loadPackagedRenderer = ${loader}
  return { load: loadPackagedRenderer, capture: startupCapture, readyTokens, dispose() {
    startupCapture.dispose(); ipcMain.removeHandler('ui:recordStartupFailure'); ipcMain.removeHandler('ui:rendererUpdateReady')
  } }
}
`)
const callerPatterns = [
  ['src/main/index.ts', /const startupCapture = registerWorkbenchStartupCapture\(/],
  ['src/main/index.ts', /onRendererStartupFailure: failure => startupCapture\.recordRenderer\(failure\)/],
  ['src/main/index.ts', /startupCapture\.ready\(token\); updateReady\.resolve\(\)/],
  ['src/main/ipc.ts', /requireTrustedSender\('ui:recordStartupFailure', event\)/],
  ['src/preload/index.ts', /recordStartupFailure: input => ipcRenderer\.invoke\('ui:recordStartupFailure', input\)/],
  ['src/renderer/index.html', /src="\/src\/startup-entry\.ts"/],
  ['src/renderer/src/startup-entry.ts', /load: \(\) => import\('\.\/main'\)/],
  ['src/renderer/src/startup-entry.ts', /window\.agentmux\?\.ui\.recordStartupFailure\(failure\)/],
  ['src/main/ipc.ts', /return await executeCrashLogControl\(request\)/],
  ['../../packages/core/src/public-rpc.ts', /'system\.crash-log\.inspect': 'diagnostics\.crash-log\.get'/],
  ['../../packages/core/src/agentmux-cli-commands.ts', /empty\('system\.crash-log\.inspect',/]
]
const callers = []
for (const [path, pattern] of callerPatterns) {
  const source = await readFile(resolve(desktop, path), 'utf8')
  const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))]
  assert.ok(matches.length > 0, `No defined-outside production caller: ${path}: ${pattern}`)
  callers.push({ path, pattern: pattern.source, count: matches.length, sha256: hash(source) })
}
assert.ok(callers.length > 0)

const beforeExtracts = { loader: hash(loader), ready: hash(ready), capture: hash(capture), ipcHandler: hash(rendererHandler) }
async function compileOwner(name, mutant) {
  const out = join(output, name, 'out/main')
  await build({ configFile: false, logLevel: 'error', plugins: [consumePlugin(mutant)],
    define: { 'import.meta.dirname': '__dirname' },
    build: { target: 'node22', outDir: out, emptyOutDir: true, minify: false,
      lib: { entry: { owner: adapter, security: join(desktop, 'src/main/window-security.ts'),
        access: join(desktop, 'src/main/crash-log-access.ts') }, formats: ['cjs'] },
      rollupOptions: { external: ['electron', /^node:/, /^@agentmux\//], output: { entryFileNames: '[name].cjs',
        paths: id => id.startsWith('@agentmux/') ? fileURLToPath(import.meta.resolve(id)) : id } } } })
  return out
}
process.chdir(desktop)
const configuration = await resolveConfig({ root: desktop, configFile: join(desktop, 'electron.vite.config.ts'), logLevel: 'error' }, 'build', 'production')
assert.ok(configuration.config.preload)
const preloadOut = join(output, 'preload-build')
await build({ ...configuration.config.preload, plugins: [...configuration.config.preload.plugins, consumePlugin()],
  build: { ...configuration.config.preload.build, outDir: preloadOut, emptyOutDir: true } })
const realPreload = await readFile(join(preloadOut, 'index.cjs'), 'utf8')
assert.ok(realPreload.includes('ui:recordStartupFailure'), 'Actual produced preload must contribute diagnostic IPC')

async function compileRenderer(name, kind, mutant) {
  const dir = join(output, name, 'renderer-input')
  await mkdir(dir, { recursive: true })
  const entry = join(dir, 'entry.ts')
  await writeFile(entry, `import ${JSON.stringify(join(desktop, 'src/renderer/src/startup-entry.ts'))}\n`)
  const application = join(dir, 'application.ts')
  await writeFile(application, kind === 'import' ? `throw new Error('ORIGINAL_RENDERER_IMPORT_FAILURE_T005')\nexport {}\n` :
    `const token=new URLSearchParams(location.search).get('renderer-update'); document.getElementById('root')!.textContent='healthy original frame';
     ${kind === 'sink' ? `setTimeout(()=>{throw new Error('ORIGINAL_RENDERER_SINK_FAILURE_T005')},0); setTimeout(()=>{void window.agentmux!.ui.rendererUpdateReady(token!)},75);` : `void window.agentmux!.ui.rendererUpdateReady(token!);`} export {}\n`)
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="./entry.ts"></script></body></html>')
  const out = join(output, name, 'out/renderer')
  await build({ configFile: false, root: dir, base: './', logLevel: 'error', plugins: [
    { name: 'controlled-application-input', enforce: 'pre', resolveId(id, importer) {
      if ((id === './main' || id === './main.tsx') && importer?.split('?')[0] === join(desktop, 'src/renderer/src/startup-entry.ts')) return application
    } }, consumePlugin(mutant)
  ], build: { outDir: out, emptyOutDir: true, minify: false } })
  return join(out, 'index.html')
}
const core = join(root, 'packages/core/dist/index.js')
const cli = join(root, 'packages/core/dist/agentmux.js')
const harness = join(output, 'harness.cjs')
await writeFile(harness, `
const {app,BrowserWindow}=require('electron'); const {readFileSync,writeFileSync}=require('node:fs'); const {join}=require('node:path');
const {pathToFileURL}=require('node:url'); const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const [ownerDirectory,renderer,directory,mode]=process.argv.slice(2);const {wire}=require(join(ownerDirectory,'owner.cjs'));
const {windowSecurityWebPreferences}=require(join(ownerDirectory,'security.cjs')); const {executeCrashLogControl}=require(join(ownerDirectory,'access.cjs'));
app.setPath('userData',join(directory,'user-data'));app.setName('AgentMux T005 isolated startup');
const result={preloadEvents:[],consoleErrors:[]};let done=false;let owner,server,rpc;
const finish=async code=>{if(done)return;done=true;try{owner?.dispose();await rpc?.dispose();await server?.stop()}finally{writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2));app.exit(code)}};
setTimeout(()=>{result.infrastructureTimeout=true;void finish(2)},10000);
app.whenReady().then(async()=>{
const preferences=windowSecurityWebPreferences(join(ownerDirectory,'../preload/index.cjs'));result.preferences=preferences;
const window=new BrowserWindow({show:false,webPreferences:preferences});result.mainPid=process.pid;
window.webContents.on('preload-error',(_e,path,error)=>result.preloadEvents.push({path,name:error.name,message:error.message}));
window.webContents.on('console-message',(event,level,message)=>{const text=event?.message??message;if(typeof text==='string'&&/ORIGINAL_RENDERER_IMPORT/.test(text))result.consoleErrors.push(text)});
owner=await wire(window,directory,mode==='sink');
const loading=owner.load(renderer).then(()=>{result.readyPublished=true});loading.catch(error=>{result.readyError=error.message});
for(let i=0;i<160&&!result.preloadEvents.length&&!result.readyPublished&&!result.consoleErrors.length;i++)await new Promise(r=>setTimeout(r,25));
await new Promise(r=>setTimeout(r,100));
result.readyTokens=owner.readyTokens;let records=[];try{records=readFileSync(join(directory,'user-data/crash-log.ndjson'),'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}catch{};result.records=records;
if(mode==='preload'){result.semanticOracle='original preload first cause';await finish(records.some(r=>r.sourceEvent==='preload-error'&&r.summary.includes('ORIGINAL_PRELOAD_FAILURE_T005'))?0:1);return}
if(mode==='import'){result.semanticOracle='original module import first cause';await finish(records.some(r=>r.sourceEvent==='renderer-import-error'&&r.summary.includes('ORIGINAL_RENDERER_IMPORT_FAILURE_T005'))?0:1);return}
result.dom=await window.webContents.executeJavaScript('({bridge:typeof window.agentmux,text:document.getElementById("root")?.textContent})');
result.lateReceipt=await window.webContents.executeJavaScript('window.agentmux.ui.recordStartupFailure({attemptId:new URLSearchParams(location.search).get("renderer-update"),event:"renderer-error",error:{name:"Error",message:"AFTER_READY_NOT_A_STARTUP_FAILURE"}})');
if(mode==='sink'){
// Actual own preload event during the still-pending original load is the source; another healthy attempt can still load.
result.semanticOracle='diagnostic sink does not prevent healthy Ready/IPC';await finish(result.readyPublished&&result.lateReceipt===false?0:1);return}
const api=await import(pathToFileURL(${JSON.stringify(core)}).href);
server=new api.AgentMuxControlServer({execute:executeCrashLogControl},join(directory,'control.sock'));await server.start();
rpc=await api.connectAgentMuxRpc({endpoint:{transport:'unix',path:join(directory,'control.sock')}});
result.rpc=await rpc.call('system.crash-log.inspect',{});
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')));
const execute=promisify(execFile);const cliResult=await execute(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'system','crash-log','inspect'],{env:{...env,AGENTMUX_RPC_ENDPOINT:'unix:'+join(directory,'control.sock'),AGENTMUX_ENV:'1'},timeout:4000});
result.cli=JSON.parse(cliResult.stdout.split('\\n').find(line=>line.startsWith('{')));
result.semanticOracle='healthy original Ready and private log discovery';await finish(result.readyPublished&&result.lateReceipt===false&&result.dom.bridge==='object'?0:1);
}).catch(error=>{result.infrastructureError=String(error.stack??error);void finish(3)});
`)

const sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const sourceTree = (await execute('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root })).stdout.trim()
async function run(name, ownerDirectory, renderer, mode) {
  const directory = await mkdtemp(_hygiene_fixturePath("private/tmp/amx-t005-"))
  const preserved = join(output, name)
  await mkdir(preserved, { recursive: true })
  await mkdir(join(ownerDirectory, '../preload'), { recursive: true })
  const preload = mode === 'preload' ? `throw new Error('ORIGINAL_PRELOAD_FAILURE_T005')\n${realPreload}` : realPreload
  await writeFile(join(ownerDirectory, '../preload/index.cjs'), preload)
  const packageIdentity = { schema: 'agentmux.package-identity.v1', sourceCommit, sourceTree,
    appVersion: 'private-startup-proof', platform: process.platform, arch: process.arch }
  await writeFile(join(directory, 'package-identity.json'), JSON.stringify(packageIdentity))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(requireDesktop('electron'), [harness, ownerDirectory, renderer, directory, mode], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  let outerTimeout = false
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { outerTimeout = true; child.kill('SIGKILL') }, 15000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', value => { clearTimeout(timer); resolveExit(value) })
  })
  await writeFile(join(preserved, 'electron.log'), log)
  let raw
  try { raw = await readFile(join(directory, 'result.json'), 'utf8') }
  catch { raw = JSON.stringify({ infrastructureError: 'Missing semantic receipt', outerTimeout, code, privateDirectory: directory }) }
  await writeFile(join(preserved, 'result.json'), raw)
  try { await writeFile(join(preserved, 'crash-log.ndjson'), await readFile(join(directory, 'user-data/crash-log.ndjson'))) } catch {}
  const result = JSON.parse(raw)
  if (outerTimeout || result.infrastructureTimeout || result.infrastructureError) throw new Error(`Not qualified: ${name}: ${JSON.stringify(result)}`)
  await rm(directory, { recursive: true })
  return { name, code, ...result, logSHA256: hash(log), resultSHA256: hash(raw), privateDirectoryReleased: true }
}
const ownerDirectory = await compileOwner('candidate')
const importRenderer = await compileRenderer('candidate-import', 'import')
const healthyRenderer = await compileRenderer('candidate-healthy', 'healthy')
const sinkRenderer = await compileRenderer('candidate-sink', 'sink')
const green = []
green.push(await run('candidate-preload', ownerDirectory, healthyRenderer, 'preload'))
green.push(await run('candidate-import', ownerDirectory, importRenderer, 'import'))
green.push(await run('candidate-healthy', ownerDirectory, healthyRenderer, 'healthy'))
green.push(await run('candidate-sink', ownerDirectory, sinkRenderer, 'sink'))
for (const result of green) assert.equal(result.code, 0, `${result.semanticOracle}: ${JSON.stringify(result)}`)
assert.equal(green[0].preloadEvents[0].message, 'ORIGINAL_PRELOAD_FAILURE_T005')
assert.ok(green[1].consoleErrors.length > 0, 'Actual Renderer import must throw before its original graph loads')
for (const result of green.slice(0, 2)) {
  const first = result.records[0]
  assert.equal(first.pid, result.mainPid)
  assert.ok(Number.isInteger(first.rendererPid) && first.rendererPid > 0)
  assert.equal(first.packageIdentity.sourceCommit, sourceCommit)
  assert.equal(first.packageIdentity.sourceTree, sourceTree)
  assert.equal(typeof first.attemptId, 'string')
  assert.equal(first.kind, 'workbench-startup-failure')
}
assert.equal(green[2].readyTokens.length, 1, 'One actual original Ready IPC receipt must complete the loader')
assert.deepEqual(green[2].records, [], 'Healthy startup and after-Ready observation must not create noise')
assert.equal(green[2].rpc.outcome, 'absent')
assert.equal(green[2].cli.result.path, green[2].rpc.path)
assert.deepEqual(green[3].records, [], 'Failed sink must not claim persisted original cause')
const sinkLog = await readFile(join(output, 'candidate-sink/electron.log'), 'utf8')
assert.ok(sinkLog.includes('ORIGINAL_RENDERER_SINK_FAILURE_T005') && sinkLog.includes('ENOSPC'), 'Original cause and controlled sink errno must remain independently visible')

const preloadMutant = { kind: 'missing-preload-capture', path: 'src/main/workbench-startup-capture.ts',
  before: "  deps.contents.on('preload-error', onPreloadError)", after: '  // counterfactual: original preload capture removed' }
const mutantOwner = await compileOwner('mutant-preload', preloadMutant)
const red = [await run('mutant-preload', mutantOwner, healthyRenderer, 'preload')]
assert.equal(red[0].code, 1, 'Removed actual listener must lose original preload cause (semantic RED)')
assert.equal(red[0].preloadEvents[0].message, 'ORIGINAL_PRELOAD_FAILURE_T005')
const delayedMutant = { kind: 'late-bootstrap-capture', path: 'src/renderer/src/lib/renderer-startup-capture.ts',
  before: "  input.host.addEventListener('error', onError as EventListener)\n  input.host.addEventListener('unhandledrejection', onRejection as EventListener)\n  void input.load().catch(error => { report('renderer-import-error', error); throw error })",
  after: "  void input.load().then(() => {\n    input.host.addEventListener('error', onError as EventListener)\n    input.host.addEventListener('unhandledrejection', onRejection as EventListener)\n  })" }
const delayedRenderer = await compileRenderer('mutant-delayed-import', 'import', delayedMutant)
red.push(await run('mutant-delayed-import', ownerDirectory, delayedRenderer, 'import'))
assert.equal(red[1].code, 1, 'Listeners installed after the failed graph must lose the original import cause (semantic RED)')
assert.ok(red[1].consoleErrors.length > 0)

const fastFiles = ['apps/desktop/test/workbench-startup-capture.test.ts',
  'apps/desktop/test/crash-log-diagnostics-control.test.ts', 'apps/desktop/test/main-crash-capture.test.ts']
const vitest = join(dirname(requireDesktop.resolve('vitest/package.json')), 'vitest.mjs')
async function fastProof(name, mutant, anchor) {
  const report = join(output, `${name}.json`)
  const args = [vitest, 'run', ...fastFiles, '--reporter=json', `--outputFile=${report}`]
  let transform
  if (mutant) {
    const config = join(output, `${name}.config.mjs`)
    transform = { original: hash(originals.get(join(desktop, mutant.path))),
      transformed: hash(originals.get(join(desktop, mutant.path)).replace(mutant.before, mutant.after)) }
    const binding = join(output, `${name}.transform.json`)
    await writeFile(config, `import {createHash} from 'node:crypto'; import {writeFileSync} from 'node:fs';
      let count=0; const digest=source=>createHash('sha256').update(source).digest('hex');
      export default {root:${JSON.stringify(root)},
      plugins:[{name:'compiled-startup-counterfactual',enforce:'pre',transform(source,id){
        if(id!==${JSON.stringify(join(desktop, mutant.path))})return;
        if(source.split(${JSON.stringify(mutant.before)}).length-1!==1)throw new Error('Exact production mutation span missing');
        const changed=source.replace(${JSON.stringify(mutant.before)},${JSON.stringify(mutant.after)});
        writeFileSync(${JSON.stringify(binding)},JSON.stringify({path:id,count:++count,original:digest(source),transformed:digest(changed)}));
        return changed;
      }}],test:{include:${JSON.stringify(fastFiles)},globalSetup:[${JSON.stringify(join(root, 'vitest.dist-freshness.ts'))}],
        setupFiles:[${JSON.stringify(join(root, 'vitest.setup.ts'))}]} }`)
    args.push('--config', config, '--testNamePattern', anchor)
  }
  let status = 0, log = ''
  try { const result = await execute(process.execPath, args, { cwd: root, maxBuffer: 1024 * 1024 }); log = result.stdout + result.stderr }
  catch (error) { status = error.code; log = `${error.stdout ?? ''}${error.stderr ?? ''}` }
  await writeFile(join(output, `${name}.log`), log)
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  const active = parsed.testResults.flatMap(item => item.assertionResults)
    .filter(item => ['passed', 'failed'].includes(item.status))
  assert.ok(active.length > 0, 'No actual collected assertions cannot qualify startup capture')
  if (mutant) {
    const actualTransform = JSON.parse(await readFile(join(output, `${name}.transform.json`), 'utf8'))
    assert.ok(actualTransform.count > 0, 'Production transform was not actually compiled')
    assert.equal(actualTransform.original, transform.original)
    assert.equal(actualTransform.transformed, transform.transformed)
    transform = actualTransform
    assert.equal(status, 1, `Production counterfactual must be semantic RED: ${name}`)
    assert.ok(active.some(item => item.status === 'failed' && item.fullName.includes(anchor)), 'Missing causal semantic assertion failure')
    assert.equal(parsed.testResults.filter(item => item.message && !item.assertionResults.length).length, 0,
      'Compilation/discovery failure is not semantic RED')
  } else { assert.equal(status, 0, log); assert.ok(active.every(item => item.status === 'passed')) }
  return { name, code: status, passed: active.filter(item => item.status === 'passed').length,
    failed: active.filter(item => item.status === 'failed').length, anchors: active.map(item => item.fullName),
    report, reportSHA256: hash(await readFile(report)), ...(transform ? { transform } : {}) }
}
const fastGreen = await fastProof('fast-candidate')
const scopeMutant = { kind: 'missing-original-attempt-guard', path: 'src/main/workbench-startup-capture.ts',
  before: 'if (!validFailure(input) || input.attemptId !== currentAttempt()) return false',
  after: 'if (!validFailure(input)) return false' }
const sinkMutant = { kind: 'missing-sink-containment', path: 'src/main/workbench-startup-capture.ts',
  before: 'try { void Promise.resolve(deps.sink(record)).catch(failed) }\n    catch (error) { failed(error) }',
  after: 'void deps.sink(record)' }
const documentMutant = { kind: 'missing-document-attempt-token', path: 'src/main/workbench-startup-capture.ts',
  before: "    const tokens = new URL(url).searchParams.getAll('renderer-update')\n    const active = currentAttempt()\n    if (!active || tokens.length !== 1 || tokens[0] !== active) return",
  after: '    // counterfactual: document event occurrence is not checked' }
const fastRed = []
fastRed.push(await fastProof('mutant-document-token', documentMutant,
  'rejects late document failures from another original loader token'))
fastRed.push(await fastProof('mutant-attempt-guard', scopeMutant,
  'rejects stale attempts and new events after exact Ready'))
fastRed.push(await fastProof('mutant-sink-containment', sinkMutant,
  'sink sync and async failure preserves original stderr'))

for (const [path, source] of originals) assert.equal(await readFile(path, 'utf8'), source, `Selected source changed: ${path}`)
for (const [path, sha] of consumed) assert.equal(hash(await readFile(path)), sha, `Consumed source changed: ${path}`)
await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.workbench-startup-capture-electron.v1', passed: true,
  sourceCommit, sourceTree, sourceSHA256: [...originals].map(([path, source]) => ({ path, sha256: hash(source) })),
  consumedSources: [...consumed].map(([path, sha256]) => ({ path, sha256 })), beforeExtracts, preloadSHA256: hash(realPreload),
  green, red, fastGreen, fastRed, callers, mutants: [preloadMutant, delayedMutant, documentMutant, scopeMutant, sinkMutant],
  boundary: 'Actual sandboxed Electron, production Main capture/loader/Ready/IPC extracted source and original early entry; controlled private application import/preload and sink inputs, no real Session/Runtime/user UI; fixed-path public query consumes actual Main owner. No release qualification claimed.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, green: green.length, semanticRed: red.length + fastRed.length, fastGreen: fastGreen.passed, receipt: join(output, 'receipt.json') }))
