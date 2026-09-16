import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const fixture = path.join(desktop, 'scripts/fixtures/terminal-live-scroll')
const instrument = path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts')
const productPreload = path.join(desktop, 'out/preload/index.cjs')
const core = path.join(root, 'packages/core/dist/index.js')
const receiptPath = path.join(root, '.tmp/terminal-live-scroll-last.json')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-live-read-'))
await fs.mkdir(path.dirname(receiptPath), { recursive: true })
const pkg = path.dirname(require.resolve('@xterm/xterm/package.json'))
const electron = require('electron')
const critical = [
  fileURLToPath(import.meta.url), path.join(desktop, 'scripts/probe-process.mjs'), instrument,
  ...['main.cjs', 'entry.tsx', 'index.html'].map(name => path.join(fixture, name)),
  path.join(desktop, 'src/renderer/src/components/TerminalView.tsx'), path.join(desktop, 'src/renderer/src/components/SessionPane.tsx'),
  path.join(desktop, 'src/renderer/src/components/SessionHistoryView.tsx'), path.join(desktop, 'src/renderer/src/store.ts'),
  path.join(desktop, 'src/renderer/src/lib/api.ts'), path.join(desktop, 'src/renderer/src/lib/session-events.ts'),
  path.join(desktop, 'src/renderer/src/lib/idle-agent-restore-policy.ts'), path.join(desktop, 'src/renderer/src/lib/terminal-theme.ts'),
  path.join(desktop, 'src/shared/terminal-palettes.ts'), path.join(desktop, 'src/renderer/src/styles/session-history.css'),
  path.join(desktop, 'src/preload/index.ts'), path.join(desktop, 'src/shared/contracts.ts'), productPreload,
  core, ...['providers/codex.js', 'providers/codex-native-history.js', 'providers/codex-native-read.js', 'session-history.js', 'errors.js']
    .map(name => path.join(root, 'packages/core/dist', name)),
  ...['providers/codex.ts', 'providers/codex-native-history.ts', 'providers/codex-native-read.ts', 'session-history.ts', 'types.ts']
    .map(name => path.join(root, 'packages/core/src', name)),
  path.join(pkg, 'package.json'), path.join(pkg, 'lib/xterm.mjs'), path.join(pkg, 'src/browser/CoreBrowserTerminal.ts'),
  electron
]
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file => [file,
  createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
const readerSource = String.raw`
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('.', import.meta.url))
const trace = root + 'reader.ndjson'
const record = value => appendFileSync(trace, JSON.stringify({pid:process.pid,...value})+'\n')
assert.deepEqual(process.argv.slice(2), ['-s','read-only','-a','never','app-server','--stdio'])
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
const items = JSON.parse(readFileSync(root+'native-items.json','utf8'))
assert.equal(items.length,63)
record({kind:'start',argvReadOnly:true})
const lines = createInterface({input:process.stdin})
lines.on('line', line => {
  const request=JSON.parse(line)
  if(request.method==='initialized'){assert.equal(request.id,undefined);record({kind:'method',method:'initialized'});return}
  assert.ok(Number.isSafeInteger(request.id))
  let result
  switch(request.method){
    case 'initialize':
      assert.equal(request.params.clientInfo.name,'agentmux_native_read')
      assert.equal(request.params.capabilities.experimentalApi,true)
      result={userAgent:'private-read-only-protocol-fixture'};break
    case 'thread/read':
      assert.deepEqual(request.params,{threadId:'private-native-thread',includeTurns:false})
      result={thread:{id:'private-native-thread',historyMode:'paginated',turns:[]}};break
    case 'thread/items/list': {
      assert.equal(request.params.threadId,'private-native-thread')
      assert.equal(request.params.limit,30)
      assert.equal(request.params.sortDirection,'desc')
      const cursor=request.params.cursor
      assert.ok(cursor===undefined||cursor==='page:30'||cursor==='page:60')
      const offset=cursor===undefined?0:Number(cursor.slice(5))
      const descending=[...items].reverse()
      result={data:descending.slice(offset,offset+30),nextCursor:offset+30<items.length?'page:'+String(offset+30):null};break
    }
    default:throw new Error('Only native read methods are permitted')
  }
  record({kind:'method',method:request.method})
  process.stdout.write(JSON.stringify({id:request.id,result})+'\n')
})
lines.on('close',()=>{record({kind:'eof'});process.exit(0)})
`
const result = { schema: 'agentmux.terminal-live-scroll-delivery.v1', passed: false,
  sourceAndPackageBefore: null, sourceAndPackageAfter: null, distributionArtifacts: null,
  nativeFixture: null, browser: null, exit: null, processRuns: [],
  cleanup: { remaining: null, rootRemoved: false, errors: [] }, physicalDeviceTested: false, userRunTouched: false,
  boundary: 'Two private actual Electron processes with CDP trusted input, product Store durable workbench initialization, SessionPane/preload/xterm and Core Provider reading over a synthetic native protocol. No Core connect/create, Agent Run, model or user home access; active missing VT state is not restored.' }
let child, timer
const childPids = []
try {
  result.sourceAndPackageBefore = await hashes(critical)
  await fs.mkdir(path.join(privateRoot, 'codex-home'), { mode: 0o700 })
  const items = Array.from({ length: 63 }, (_, i) => ({
    turnId: `private-native-turn-${i}`, startedAtMs: 1000 + i, completedAtMs: 1001 + i,
    item: { id: `private-native-item-${i}`, type: i % 2 ? 'userMessage' : 'agentMessage',
      ...(i % 2 ? { content: [{ type: 'text', text: `Private persisted record ${i}. ` + 'Synthetic readable native text. '.repeat(35) }] }
        : { text: `**Private persisted record ${i}.** ` + 'Synthetic readable native text. '.repeat(35) }) }
  }))
  await fs.writeFile(path.join(privateRoot, 'native-items.json'), JSON.stringify(items), { mode: 0o600 })
  await fs.writeFile(path.join(privateRoot, 'native-reader.mjs'), readerSource, { mode: 0o600 })
  result.nativeFixture = await hashes(['native-items.json', 'native-reader.mjs'].map(name => path.join(privateRoot, name)))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"',
      __TERMINAL_WHEEL_UMD_URL__: JSON.stringify(pathToFileURL(path.join(pkg, 'lib/xterm.js')).href) },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: instrument }] },
    esbuild: { jsx: 'automatic' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, minify: false } })
  const artifacts = []
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await collect(file)
      else artifacts.push(file)
    }
  }
  await collect(path.join(privateRoot, 'renderer')); assert.ok(artifacts.length > 0)
  result.distributionArtifacts = await hashes(artifacts)
  const env = { ...process.env, CODEX_HOME: path.join(privateRoot, 'codex-home') }
  delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['capture', 'restore']) {
    child = spawn(electron, [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, core, productPreload, phase],
      { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    result.pid = child.pid; childPids.push(child.pid)
    child.stderr.on('data', () => {})
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
    result.exit = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Private live-reader browser deadline exceeded')), 45000)
    })])
    clearTimeout(timer)
    const browser = JSON.parse(await fs.readFile(path.join(privateRoot, `browser-${phase}.json`), 'utf8'))
    result.browser = browser
    result.processRuns.push({ phase, pid: child.pid, exit: result.exit, browser })
    assert.equal(result.exit.code, 0, browser.failure)
    assert.equal(browser.passed, true, browser.failure)
    await stopProbeProcesses(child.pid, privateRoot)
    assert.deepEqual(await listProbeProcesses(child.pid, privateRoot), [], 'Private process must exit before the next process starts')
  }
  const trace = (await fs.readFile(path.join(privateRoot, 'reader.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(trace.filter(entry => entry.kind === 'start').length, 2)
  assert.equal(trace.filter(entry => entry.kind === 'eof').length, 2)
  assert.deepEqual(trace.filter(entry => entry.kind === 'method').map(entry => entry.method),
    ['initialize', 'initialized', 'thread/read', 'thread/items/list', 'initialize', 'initialized', 'thread/read', 'thread/items/list'])
  result.nativeReaderTrace = trace
  result.sourceAndPackageAfter = await hashes(critical)
  assert.deepEqual(result.sourceAndPackageAfter, result.sourceAndPackageBefore, 'Selected actual source/dependency inputs changed during proof')
  assert.deepEqual(await hashes(Object.keys(result.nativeFixture)), result.nativeFixture, 'Private native records/helper changed while being read')
  result.passed = true
} catch (error) {
  result.failure = error.stack
  result.stages = {}
  for (const phase of ['capture', 'restore']) {
    try { result.stages[phase] = JSON.parse(await fs.readFile(path.join(privateRoot, `stage-${phase}.json`), 'utf8')) } catch {}
  }
}
finally {
  clearTimeout(timer)
  for (const pid of childPids) {
    try { await stopProbeProcesses(pid, privateRoot) } catch (error) { result.cleanup.errors.push(String(error)); result.passed = false }
  }
  try { result.cleanup.remaining = await listProbeProcesses(-1, privateRoot) }
  catch (error) { result.cleanup.errors.push(String(error)); result.passed = false }
  if (result.cleanup.remaining?.length === 0 && result.cleanup.errors.length === 0) {
    try { await fs.rm(privateRoot, { recursive: true, force: true }); result.cleanup.rootRemoved = true }
    catch (error) { result.cleanup.errors.push(String(error)); result.passed = false }
  } else result.passed = false
  if (!result.cleanup.rootRemoved) result.passed = false
  await fs.writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ passed: result.passed, pid: result.pid, exit: result.exit, cleanup: result.cleanup,
    failure: result.failure ?? result.browser?.failure, receipt: receiptPath }))
}
if (!result.passed) process.exitCode = 1
