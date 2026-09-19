import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// All compilation is owned by this invocation. No shared dist, dependencies,
// production Runtime or physical desktop is changed by this verification.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/terminal-cross-client-input')
const require = createRequire(path.join(desktop, 'package.json')), exec = promisify(execFile)
const { build: vite } = await import(pathToFileURL(require.resolve('vite')).href)
const viteRequire = createRequire(require.resolve('vite'))
const { build: esbuild } = await import(pathToFileURL(viteRequire.resolve('esbuild')).href)
const privateRoot = await fs.mkdtemp('/tmp/amx-cross-client-input-')
const outputRoot = path.join(root, '.tmp/terminal-cross-client-input-proof')
await fs.mkdir(outputRoot, { recursive: true })
const vendor = path.join(root, 'packages/core/vendor/ctxmux/darwin-arm64')
const vendorManifest = JSON.parse(await fs.readFile(path.join(vendor, 'manifest.json'), 'utf8'))
const binary = path.join(vendor, 'bin/ctxmuxd'), pkg = path.dirname(require.resolve('@xterm/xterm/package.json'))
const files = [fileURLToPath(import.meta.url),fileURLToPath(new URL('./probe-process.mjs', import.meta.url)),
  ...['index.html','entry.tsx','main.cjs','program.py','xterm-instrumented.ts'].map(name => path.join(fixture,name)),
  ...['client.ts','ctxmux-run-adapter.ts','runtime-paths.ts','agent-session-store.ts'].map(name => path.join(root,'packages/core/src',name)),
  ...['build.mjs','clean-build.mjs'].map(name => path.join(root,'packages/core/scripts',name)),
  ...['tsconfig.json','tsconfig.build.json','package.json'].map(name => path.join(root,'packages/core',name)),
  path.join(root,'tsconfig.base.json'),path.join(root,'pnpm-workspace.yaml'),path.join(root,'pnpm-lock.yaml'), ...['manifest.json','bin/ctxmuxd','bin/ctxmux',vendorManifest.sdk.archive.path].map(name => path.join(vendor,name)),
  ...['src/renderer/src/components/TerminalView.tsx','src/renderer/src/components/SessionPane.tsx','src/renderer/src/lib/api.ts','src/renderer/src/lib/session-events.ts','src/renderer/src/lib/terminal-reveal.ts','src/renderer/src/lib/terminal-paste.ts','src/main/runtime-controller.ts','src/preload/index.ts','src/shared/contracts.ts'].map(name => path.join(desktop,name)),
  path.join(pkg,'lib/xterm.mjs'),path.join(pkg,'package.json'), require('electron')]
const hashes = async inputs => Object.fromEntries(await Promise.all(inputs.map(async file => {
  const bytes = await fs.readFile(file); assert.ok(bytes.length)
  return [file,{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}]
})))
const collect = async dir => { const files=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=path.join(dir,entry.name);if(entry.isDirectory())files.push(...await collect(name));else if(entry.isFile())files.push(name)}return files }
const receipt = {schema:'agentmux.terminal-cross-client-input.v1',passed:false,userRuntimeTouched:false,privateRoot,
  limits:['One private generic TUI, two public Core Clients and one mounted SessionPane; not actual Codex or physical trackpad.',
    'Selected source/build/compiled/native identities are recorded; not an exhaustive transitive build manifest.',
    'Explicit fixture attach/resize IPC and connectedClient injection; not full production bootstrap.'],
  cleanup:{remaining:null,errors:[],rootRemoved:false}}
let child, timer
try {
  receipt.inputsBefore = await hashes(files)
  const manifest = JSON.parse(await fs.readFile(path.join(vendor,'manifest.json'),'utf8'))
  assert.equal(manifest.product.protocol,18)
  const daemon = manifest.binaries.find(row=>row.name==='ctxmuxd');assert.ok(daemon)
  assert.equal(receipt.inputsBefore[binary].sha256,daemon.sha256)
  receipt.nativeSource=manifest.source
  const buildRoot=path.join(privateRoot,'build'),coreRoot=path.join(buildRoot,'packages/core')
  await fs.mkdir(coreRoot,{recursive:true})
  for(const name of ['src','scripts','vendor','package.json','tsconfig.json','tsconfig.build.json'])
    await fs.cp(path.join(root,'packages/core',name),path.join(coreRoot,name),{recursive:true})
  await fs.copyFile(path.join(root,'tsconfig.base.json'),path.join(buildRoot,'tsconfig.base.json'))
  await fs.copyFile(path.join(root,'package.json'),path.join(buildRoot,'package.json'))
  await fs.copyFile(path.join(root,'pnpm-workspace.yaml'),path.join(buildRoot,'pnpm-workspace.yaml'))
  await fs.copyFile(path.join(root,'pnpm-lock.yaml'),path.join(buildRoot,'pnpm-lock.yaml'))
  await fs.symlink(path.join(root,'node_modules'),path.join(buildRoot,'node_modules'),'dir')
  await fs.symlink(path.join(root,'packages/core/node_modules'),path.join(coreRoot,'node_modules'),'dir')
  // Use the product build owner, including actual SDK archive verification/bundling.
  const built=await exec(process.execPath,[path.join(coreRoot,'scripts/build.mjs')],{cwd:buildRoot,maxBuffer:8*1024*1024,env:{...process.env,pnpm_config_verify_deps_before_run:'warn'}})
  receipt.coreBuild={exitCode:0,stdout:built.stdout,stderr:built.stderr}
  const core=path.join(coreRoot,'dist/index.js'),preload=path.join(privateRoot,'preload.cjs'),controller=path.join(coreRoot,'dist/desktop-controller.mjs')
  await esbuild({entryPoints:[path.join(desktop,'src/preload/index.ts')],outfile:preload,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'error'})
  await esbuild({entryPoints:[path.join(desktop,'src/main/runtime-controller.ts')],outfile:controller,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'error'})
  await vite({configFile:false,root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"'},resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:path.join(fixture,'xterm-instrumented.ts')}]},esbuild:{jsx:'automatic'},build:{target:'esnext',outDir:path.join(privateRoot,'renderer'),emptyOutDir:true,minify:false}})
  receipt.compiledBefore=await hashes([...await collect(path.join(coreRoot,'dist')),preload,controller,...await collect(path.join(privateRoot,'renderer'))])
  assert.ok(Object.keys(receipt.compiledBefore).length>0)
  await Promise.all(['home','codex','runtime','user-data','session-data'].map(name=>fs.mkdir(path.join(privateRoot,name),{recursive:true,mode:0o700})))
  const env={...process.env,HOME:path.join(privateRoot,'home'),CODEX_HOME:path.join(privateRoot,'codex'),AGENTMUX_RUNTIME_DIRECTORY:path.join(privateRoot,'runtime'),AGENTMUX_MESSAGE_QUEUE_PATH:path.join(privateRoot,'messages.ndjson')};delete env.ELECTRON_RUN_AS_NODE
  child=spawn(require('electron'),[path.join(fixture,'main.cjs'),privateRoot,path.join(privateRoot,'renderer/index.html'),core,preload,controller,binary,path.join(fixture,'program.py')],{cwd:root,env,detached:true,stdio:['ignore','ignore','pipe']})
  receipt.pid=child.pid;const log=[];child.stderr.on('data',data=>log.push(data.toString()))
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))})
  receipt.exit=await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Private cross-client verification deadline')),60000)})]);clearTimeout(timer)
  await fs.writeFile(path.join(outputRoot,'electron.log'),log.join(''))
  receipt.raw=JSON.parse(await fs.readFile(path.join(privateRoot,'browser-result.json'),'utf8'))
  await fs.writeFile(path.join(outputRoot,'raw.json'),JSON.stringify(receipt.raw,null,2)+'\n')
  assert.deepEqual(receipt.exit,{code:0,signal:null})
  assert.equal(receipt.raw.passed,true);assert.equal(receipt.raw.reportAckAndPaintVerified,true)
  assert.ok(receipt.raw.firstWheel.writes.length>0);assert.equal(receipt.raw.firstWheel.rejectedCount,0)
  assert.deepEqual(receipt.raw.cleanup.errors,[])
  receipt.passed=true
} catch(error) { receipt.failure={name:error.name,message:error.message,stack:error.stack} }
finally {
  clearTimeout(timer)
  try {
    if(receipt.inputsBefore){receipt.inputsAfter=await hashes(files);assert.deepEqual(receipt.inputsAfter,receipt.inputsBefore)}
    if(receipt.compiledBefore){receipt.compiledAfter=await hashes(Object.keys(receipt.compiledBefore));assert.deepEqual(receipt.compiledAfter,receipt.compiledBefore)}
  } catch(error) { receipt.inputBindingFailure=String(error);receipt.passed=false }
  if(child?.pid)try{await stopProbeProcesses(child.pid,privateRoot)}catch(error){receipt.cleanup.errors.push(String(error))}
  try { receipt.cleanup.remaining=await listProbeProcesses(-1,privateRoot) } catch(error){receipt.cleanup.errors.push(String(error))}
  if(!receipt.cleanup.errors.length&&receipt.cleanup.remaining?.length===0){await fs.rm(privateRoot,{recursive:true,force:true});receipt.cleanup.rootRemoved=true}
  else receipt.passed=false
  await fs.writeFile(path.join(outputRoot,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({passed:receipt.passed,failure:receipt.failure,exit:receipt.exit,cleanup:receipt.cleanup,receipt:path.join(outputRoot,'receipt.json')}))
}
if(!receipt.passed)process.exitCode=1
