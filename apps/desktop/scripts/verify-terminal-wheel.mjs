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
const fixture = path.join(desktop, 'scripts/fixtures/terminal-wheel')
const receiptPath = path.join(root, '.tmp/terminal-wheel-last.json')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-terminal-wheel-'))
await fs.mkdir(path.dirname(receiptPath), { recursive: true })
const pkg = path.dirname(require.resolve('@xterm/xterm/package.json'))
const critical = [
  path.join(pkg, 'package.json'), path.join(pkg, 'src/browser/services/MouseService.ts'),
  path.join(pkg, 'src/browser/scrollable/mouseEvent.ts'), path.join(pkg, 'lib/xterm.js'), path.join(pkg, 'lib/xterm.mjs'),
  path.join(desktop, 'src/renderer/src/components/TerminalView.tsx'), path.join(desktop, 'src/renderer/src/components/SessionPane.tsx'),
  path.join(desktop, 'src/renderer/src/store.ts'), path.join(desktop, 'src/renderer/src/lib/terminal-reveal.ts'),
  path.join(desktop, 'src/renderer/src/lib/terminal-replay.ts'), path.join(desktop, 'src/renderer/src/styles/index.css'),
  ...['entry.tsx','xterm-instrumented.ts','index.html','main.cjs'].map(name => path.join(fixture, name)), fileURLToPath(import.meta.url)
]
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file => [file,
  createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
const result = { schema:'agentmux.terminal-wheel-delivery.v1', passed:false, sourceAndPackageBefore:null,
  sourceAndPackageAfter:null, distributionArtifacts:null, browser:null, exit:null,
  cleanup:{remaining:null,rootRemoved:false,errors:[]}, physicalDeviceTested:false, userRunTouched:false }
let child, timer
try {
  result.sourceAndPackageBefore = await hashes(critical)
  const version = JSON.parse(await fs.readFile(path.join(pkg,'package.json'),'utf8'))
  assert.equal(version.version, '6.1.0-beta.303'); assert.equal(version.commit, 'd3e32b344dfe7dd6015cff6a9aeaaeaeccdc2789')
  for (const file of ['xterm.js','xterm.mjs']) assert.ok(!(await fs.readFile(path.join(pkg,'lib',file),'utf8')).includes('sourceMappingURL'),
    'Modified distribution must not point to a stale map')
  await build({ configFile:false,root:fixture,base:'./',logLevel:'error',
    define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"',
      __TERMINAL_WHEEL_UMD_URL__:JSON.stringify(pathToFileURL(path.join(pkg,'lib/xterm.js')).href)},
    resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:path.join(fixture,'xterm-instrumented.ts')}]},
    esbuild:{jsx:'automatic'},build:{target:'esnext',outDir:path.join(privateRoot,'renderer'),emptyOutDir:true,minify:false} })
  const artifacts = []
  async function collect(directory) {
    for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name)
      if (entry.isDirectory()) await collect(file)
      else artifacts.push(file)
    }
  }
  await collect(path.join(privateRoot,'renderer')); assert.ok(artifacts.length>0)
  result.distributionArtifacts = await hashes(artifacts)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(require('electron'),[path.join(fixture,'main.cjs'),path.join(privateRoot,'renderer/index.html'),privateRoot],
    {env,detached:true,stdio:['ignore','ignore','pipe']})
  result.pid = child.pid
  child.stderr.on('data',()=>{})
  const exited = new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',(code,signal)=>resolve({code,signal})) })
  result.exit = await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Private wheel browser deadline exceeded')),35000)})])
  clearTimeout(timer)
  result.browser = JSON.parse(await fs.readFile(path.join(privateRoot,'browser.json'),'utf8'))
  assert.equal(result.exit.code,0,result.browser.failure)
  assert.equal(result.browser.passed,true,result.browser.failure)
  assert.equal(result.browser.cases.length,32)
  result.sourceAndPackageAfter = await hashes(critical)
  assert.deepEqual(result.sourceAndPackageAfter,result.sourceAndPackageBefore,'Actual source/dependency inputs changed during proof')
  result.passed = true
} catch (error) { result.failure = error.stack }
finally {
  clearTimeout(timer)
  if (child?.pid) {
    try { await stopProbeProcesses(child.pid,privateRoot) } catch (error) { result.cleanup.errors.push(String(error)); result.passed=false }
    try { result.cleanup.remaining=await listProbeProcesses(child.pid,privateRoot) } catch (error) { result.cleanup.errors.push(String(error)); result.passed=false }
  } else result.cleanup.remaining=[]
  if (result.cleanup.remaining?.length===0 && result.cleanup.errors.length===0) {
    try { await fs.rm(privateRoot,{recursive:true,force:true}); result.cleanup.rootRemoved=true }
    catch (error) { result.cleanup.errors.push(String(error)); result.passed=false }
  } else result.passed=false
  if (!result.cleanup.rootRemoved) result.passed=false
  await fs.writeFile(receiptPath,JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify({passed:result.passed,pid:result.pid,exit:result.exit,cases:result.browser?.cases.length,
    cleanup:result.cleanup,failure:result.failure??result.browser?.failure,receipt:receiptPath}))
}
if (!result.passed) process.exitCode=1
