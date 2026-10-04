import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { build as viteBuild } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const repo=resolve(import.meta.dirname,'../../..'),desktop=join(repo,'apps/desktop'),fixture=join(desktop,'scripts/fixtures/mote-directory-short-name'),require=createRequire(join(desktop,'package.json'))
const esBuild=createRequire(require.resolve('vite'))('esbuild').build
const flag=process.argv.indexOf('--evidence-dir'),evidence=resolve(flag<0?join(repo,'.tmp/mote-directory-short-renderer',String(globalThis.crypto.randomUUID())):process.argv[flag+1]),privateRoot=await mkdtemp(join(tmpdir(),'agentmux-short-mote-'))
const hash=b=>createHash('sha256').update(b).digest('hex'),inputs=new Map(),aliases=[]
const receipt={schema:'agentmux.mote-directory-short-renderer.v1',passed:false,aestheticReview:'pending',userRunTouched:false,phases:[],limitations:['Original App/shared Workbench and original preload/API/Store/metadata owner, bounded real Chromium input. Other public ports use private controlled facts; no Core/ctxmux/CLI process survival or native Browser qualification.','Lightweight isolated fixture compilation, not build/package/install. Two real private Electron processes verify draft/topology retention, not a user App restart.']}
await mkdir(evidence,{recursive:true});await symlink(join(repo,'packages/core/node_modules'),join(privateRoot,'node_modules'),'dir')
try{
for(const name of ['core','demand','layout','client-ui']){
 const root=join(repo,'packages',name),file=join(root,'package.json'),exports=Object.entries(JSON.parse(await readFile(file,'utf8')).exports).sort(([a],[b])=>Number(a.includes('*'))-Number(b.includes('*'))||b.length-a.length);assert.ok(exports.length)
 inputs.set(file,hash(await readFile(file)))
 for(const[key,value]of exports){const target=typeof value==='string'?value:name==='client-ui'?value.browser:value.import;if(!target||target.endsWith('.json'))continue;const source=name==='client-ui'?target:target.replace('./dist/',name==='core'?'./src/':'./').replace(/\.js$/,'.ts');const spec='@agentmux/'+name+(key==='.'?'':key.slice(1)),expression=spec.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('(.+)');aliases.push({find:new RegExp('^'+expression+'$'),replacement:resolve(root,source).replace('*','$1')})}
}
const bind=async file=>{if(file.startsWith(repo+'/')&&!file.includes('/node_modules/'))inputs.set(file,hash(await readFile(file)))}
for(const file of [import.meta.filename,join(desktop,'scripts/probe-process.mjs'),join(fixture,'main.cjs'),join(fixture,'entry.mjs'),join(fixture,'index.html'),join(fixture,'owner.ts')])await bind(file)
const out=join(privateRoot,'renderer')
await viteBuild({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:aliases},esbuild:{jsx:'automatic'},define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"'},plugins:[{name:'bind-actual-short-renderer-source',enforce:'pre',async load(id){const file=id.split('?')[0];await bind(file);return null}}],build:{target:'esnext',outDir:out,emptyOutDir:true,minify:false}})
const sourcePlugin={name:'actual-short-owner-source',setup(builder){builder.onResolve({filter:/^@agentmux\//},args=>{const alias=aliases.find(x=>x.find.test(args.path));return alias?{path:args.path.replace(alias.find,alias.replacement)}:null});builder.onLoad({filter:/\.(ts|mjs)$/},async args=>{await bind(args.path);if(args.path.endsWith('/scratch-directory-identity.mjs')){const source=await readFile(args.path,'utf8'),anchor="const defaultHelper = resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move')";assert.equal(source.split(anchor).length-1,1);return{contents:source.replace(anchor,'const defaultHelper = process.env.AGENTMUX_PRIVATE_HELPER'),loader:'js'}}return null})}}
const owner=join(privateRoot,'owner.mjs'),preload=join(privateRoot,'preload.cjs')
const ipcFile=join(desktop,'src/main/ipc.ts'),ts=require('typescript'),ipcSource=await readFile(ipcFile,'utf8');await bind(ipcFile)
const parsed=ts.createSourceFile(ipcFile,ipcSource,ts.ScriptTarget.Latest,true),statements=[]
const channels=['scratch:listTopics','scratch:readTopic','scratch:ensureMote','spatial:read','spatial:commit','spatial:retainLabels','files:readPublic']
function visit(node){if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(parsed)==='publicFiles'))statements.push(node.getText(parsed));if(ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&['handle','handleWithEvent'].includes(node.expression.expression.getText(parsed))&&node.expression.arguments[0]&&ts.isStringLiteral(node.expression.arguments[0])&&channels.includes(node.expression.arguments[0].text))statements.push(node.getText(parsed));ts.forEachChild(node,visit)}visit(parsed);assert.equal(statements.length,8)
const handlerSource=ts.transpileModule(statements.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
await writeFile(join(privateRoot,'actual-scratch-handlers.cjs'),'module.exports=ports=>{const {handle,handleWithEvent,args,config,workspace,spatialState,files,FileReadOwner,spatialCatalog,requireTrustedSender}=ports;\n'+handlerSource+'\n}');receipt.actualIpcStatements={source:relative(repo,ipcFile),sha256:hash(ipcSource),channels,compiled:hash(handlerSource)}
await esBuild({entryPoints:[join(fixture,'owner.ts')],outfile:owner,bundle:true,format:'esm',banner:{js:"import { createRequire as privateRequire } from 'node:module'; const require=privateRequire(import.meta.url);"},platform:'node',external:['electron'],plugins:[sourcePlugin],logLevel:'error'})
await esBuild({entryPoints:[join(desktop,'src/preload/index.ts')],outfile:preload,bundle:true,format:'cjs',platform:'node',external:['electron'],plugins:[sourcePlugin],logLevel:'error'})
const env={...process.env,AGENTMUX_PRIVATE_HELPER:join(desktop,'resources/bin/agentmux-workspace-move')};delete env.ELECTRON_RUN_AS_NODE
for(const phase of ['seed','restore']){const lines=[];const exit=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),join(out,'index.html'),privateRoot,phase,evidence,owner,preload],{temporaryRoot:privateRoot,cwd:repo,env,timeoutMs:90000,onLine:line=>lines.push(line)});await writeFile(join(evidence,phase+'.log'),lines.join('\n'));const app=JSON.parse(await readFile(join(evidence,phase+'.json'),'utf8'));receipt.phases.push({phase,exit,app});assert.equal(exit.timedOut,false);assert.equal(exit.exitCode,0,app.error?.message);assert.equal(app.passed,true)}
assert.equal(new Set(receipt.phases.map(p=>p.app.pid)).size,2)
receipt.source=Object.fromEntries([...inputs].map(([file,digest])=>[relative(repo,file),digest]));for(const[file,digest]of inputs)assert.equal(hash(await readFile(file)),digest,'Source drift '+relative(repo,file))
receipt.passed=true
}catch(error){receipt.error={message:error.message,stack:error.stack}}finally{receipt.source=Object.fromEntries([...inputs].map(([file,digest])=>[relative(repo,file),digest]));receipt.remainingProcesses=await listProbeProcesses(-1,privateRoot);if(!receipt.remainingProcesses.length){await rm(privateRoot,{recursive:true});receipt.privateRootRemoved=true}await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,evidence,error:receipt.error}))}
assert.equal(receipt.passed,true,receipt.error?.message)
