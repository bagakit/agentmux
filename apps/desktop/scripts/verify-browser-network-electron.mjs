import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {browserSourceBuild} from '../../../packages/browser/scripts/source-build.mjs'
import {runProbeProcess,listProbeProcesses,stopProbeProcesses} from './probe-process.mjs'
const repo=resolve(import.meta.dirname,'../../..'),require=createRequire(join(repo,'apps/desktop/package.json'))
const electron=require('electron'),{build}=browserSourceBuild(createRequire(require.resolve('vite'))('esbuild'))
const out=await mkdtemp(join(repo,'.local/browser-network-electron-')),privateRoot=await mkdtemp('/tmp/amux-native-network-'),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const sources=['packages/browser/src/browser-network-routing.ts','packages/browser/src/browser-page-transport.ts','apps/desktop/src/main/browser-cdp-session.ts','apps/desktop/scripts/fixtures/browser-network/native-main.ts']
const inputs=Object.fromEntries(await Promise.all(sources.map(async path=>[path,hash(await readFile(join(repo,path)))])))
let posts=0
const receipt={passed:false,inputs,privateRoot,electron:{path:electron,sha256:hash(await readFile(electron)),version:require('electron/package.json').version},cases:'Actual Electron original CDP adapter + production shared rule owner. Separate native scopes preserve original reader; dropped native-close dispatch observation is fault-injected, with exact late close retained. No installed App or user data.',posts:0}
const server=createServer((request,response)=>{if(request.method==='POST'){posts++;response.end('accepted')}else{response.setHeader('Content-Type','text/html');response.end('<title>Original network scope</title><input value="Original input">')}})
server.listen(0,'127.0.0.1');await once(server,'listening')
try{
 const result=await build({absWorkingDir:repo,bundle:true,platform:'node',format:'cjs',packages:'external',entryPoints:['apps/desktop/scripts/fixtures/browser-network/native-main.ts'],outfile:join(out,'main.cjs'),metafile:true,logLevel:'silent'})
 for(const path of sources.filter(path=>!path.endsWith('browser-page-transport.ts')))assert.ok(Object.hasOwn(result.metafile.inputs,path),'Actual original native network consumer '+path)
 receipt.bundleSha256=hash(await readFile(join(out,'main.cjs')))
 const env={...process.env,PRIVATE_NETWORK_ROOT:privateRoot,PRIVATE_NETWORK_URL:'http://127.0.0.1:'+server.address().port+'/',PRIVATE_NETWORK_RECEIPT:join(out,'native.json')};delete env.ELECTRON_RUN_AS_NODE
 receipt.process=await runProbeProcess(electron,[join(out,'main.cjs')],{cwd:repo,env,timeoutMs:30000})
 receipt.native=JSON.parse(await readFile(join(out,'native.json'),'utf8'));assert.equal(receipt.native.passed,true,'Current native engine scope assertions must pass')
 for(const[path,sha]of Object.entries(inputs))assert.equal(hash(await readFile(join(repo,path))),sha,'Exact network source drift '+path)
 receipt.passed=true
}catch(error){receipt.error=String(error?.stack??error);if(error?.probe)receipt.process=error.probe;throw error}
finally{
 await new Promise(done=>server.close(done));receipt.posts=posts
 try{await stopProbeProcesses(receipt.process?.originalPid,privateRoot)}catch(error){receipt.cleanupObservationError=String(error);const observed=await listProbeProcesses(receipt.process?.originalPid,privateRoot);if(observed.length)throw error}
 receipt.remaining=await listProbeProcesses(receipt.process?.originalPid,privateRoot)
 if(receipt.process?.exitConfirmed&&receipt.remaining.length===0){await rm(privateRoot,{recursive:true,force:true});receipt.privateProfileRemoved=true}
 await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log('native-network-receipt:',join(out,'receipt.json'))
}
