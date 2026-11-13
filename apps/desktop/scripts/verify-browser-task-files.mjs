import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdir,mkdtemp,readFile,writeFile,symlink,copyFile,rm,realpath } from 'node:fs/promises'
import { join,resolve,relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess,stopProbeProcesses,listProbeProcesses } from './probe-process.mjs'
const repo=resolve(import.meta.dirname,'../../..'),require=createRequire(join(repo,'apps/desktop/package.json'))
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild'),{build:renderer}=await import(pathToFileURL(require.resolve('vite'))),electron=require('electron')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),root=join(repo,'.local/browser-task-files');await mkdir(root,{recursive:true})
const out=await mkdtemp(join(root,'attempt-')),home=await mkdtemp('/tmp/amux-task-files-'),fixture=join(repo,'apps/desktop/scripts/fixtures/browser-task-files')
const receipt={schema:'agentmux.browser-task-files.native.v1',passed:false,head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),inputs:{},sourceBundleInputs:{},runs:[],images:[],electron:{version:require('electron/package.json').version,executable:await realpath(electron),sha256:sha(await readFile(electron))}}
let probe
const uiIndex=process.argv.indexOf('--ui-only'),uiOnly=uiIndex>=0
if(uiOnly){assert.ok(process.argv[uiIndex+1],'--ui-only requires the original validated asset file');const seed=process.argv[uiIndex+1];await copyFile(seed,join(home,'assets.json'));receipt.originalAssetSha256=sha(await readFile(seed))}
try{
 await renderer({configFile:false,root:fixture,base:'./',logLevel:'warn',define:{__AGENTMUX_WEB_PREVIEW__:'true'},esbuild:{jsx:'automatic'},plugins:[{name:'task-files-renderer-source',async transform(code,id){const file=id.split('?')[0];if(file.startsWith(repo+'/')&&!file.includes('/node_modules/'))receipt.sourceBundleInputs[relative(repo,file)]=sha(await readFile(file))}}],build:{outDir:join(out,'renderer'),emptyOutDir:false}})
 await symlink(join(repo,'apps/desktop/node_modules'),join(out,'node_modules'))
 const native=join(out,'native'),main=join(native,'src/main/main.mjs');await mkdir(join(native,'src/main'),{recursive:true});await mkdir(join(native,'resources/bin'),{recursive:true})
 await copyFile(join(repo,'apps/desktop/resources/bin/agentmux-workspace-move'),join(native,'resources/bin/agentmux-workspace-move'));await copyFile(join(fixture,'preload.cjs'),join(out,'preload.cjs'))
 await build({entryPoints:[join(fixture,'main.ts')],outfile:main,bundle:true,packages:'external',format:'esm',platform:'node',target:'node24',banner:{js:"import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);"},plugins:[{name:'task-files-main-source',setup(builder){builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async args=>{if(!args.path.startsWith(repo+'/')||args.path.includes('/node_modules/'))return;const code=await readFile(args.path,'utf8');receipt.sourceBundleInputs[relative(repo,args.path)]=sha(code);return{contents:code,loader:args.path.endsWith('.tsx')?'tsx':args.path.endsWith('.ts')?'ts':'js'}})}}]})
 for(const file of ['packages/browser/src/browser-page-interrupts.ts','packages/browser/dist/browser-page-interrupts.js','packages/browser/src/browser-page-dispatch.ts','packages/browser/dist/browser-page-dispatch.js','packages/browser/src/browser-operation-step.ts','packages/browser/dist/browser-operation-step.js','packages/core/dist/agentmux.js','packages/core/dist/browser-task-control.js','apps/desktop/resources/bin/agentmux-workspace-move','apps/desktop/scripts/verify-browser-task-files.mjs'])receipt.inputs[file]=sha(await readFile(join(repo,file)))
 for(const file of ['apps/desktop/src/main/browser-task-assets.ts','apps/desktop/src/main/browser-view-manager.ts','apps/desktop/src/main/browser-uploads.ts','apps/desktop/src/main/browser-downloads.ts','apps/desktop/src/main/workspace-files.ts','apps/desktop/src/renderer/src/components/BrowserTaskFileDialogEditor.tsx'])assert.ok(receipt.sourceBundleInputs[file],'Actual nonempty production consumer '+file)
 const bootstrap=join(out,'bootstrap.cjs');await writeFile(bootstrap,`const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const home=${JSON.stringify(home)};for(const key of['home','appData','userData','sessionData']){const p=path.join(home,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(error=>{console.error(error);app.exit(1)});`)
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(AGENTMUX_|CTXMUX_)/.test(key)&&key!=='ELECTRON_RUN_AS_NODE'))
 Object.assign(env,{TASK_FILES_HOME:home,TASK_FILES_OUT:out,TASK_FILES_REPO:repo,TASK_FILES_NODE:process.execPath})
 for(const phase of uiOnly?['ui-only']:process.env.TASK_FILES_BEFOREUNLOAD_ONLY?['beforeunload']:process.env.TASK_FILES_PROBE_ONLY?['prompt-probe']:['seed','restart']){
  const lines=[],row={phase};receipt.runs.push(row)
  probe=await runProbeProcess(electron,[bootstrap],{cwd:home,env:{...env,TASK_FILES_PHASE:phase},timeoutMs:180000,onLine:line=>{lines.push(line);console.log('['+phase+'] '+line)}})
  await stopProbeProcesses(probe.originalPid,home);row.process=probe;row.remaining=await listProbeProcesses(probe.originalPid,home);await writeFile(join(out,phase+'.log'),lines.join('\n'))
  row.actual=JSON.parse(await readFile(join(out,phase+'.json'),'utf8'));assert.equal(probe.timedOut,false);assert.equal(probe.exitConfirmed,true);assert.equal(probe.exitCode,0,JSON.stringify(row.actual.failure));assert.deepEqual(row.remaining,[]);assert.equal(row.actual.passed,true);assert.equal(row.actual.cases.length,phase==='seed'?4:1)
 }
 for(const file of receipt.runs[0].actual.captures)receipt.images.push({file,sha256:sha(await readFile(join(out,file)))})
 assert.equal(receipt.images.length,process.env.TASK_FILES_PROBE_ONLY||process.env.TASK_FILES_BEFOREUNLOAD_ONLY?0:4)
 for(const[file,hash]of Object.entries({...receipt.inputs,...receipt.sourceBundleInputs}))assert.equal(sha(await readFile(join(repo,file))),hash,'Native input drift: '+file)
 receipt.passed=true
}finally{
 if(probe){await stopProbeProcesses(probe.originalPid,home);receipt.remaining=await listProbeProcesses(probe.originalPid,home)}
 for(const file of ['assets.json','descriptor.json']){try{await copyFile(join(home,file),join(out,'original-'+file))}catch(error){if(error.code!=='ENOENT')throw error}}
 if(!receipt.remaining?.length){await rm(home,{recursive:true,force:true});receipt.privateHomeRemoved=true}
 await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({passed:receipt.passed,receipt:join(out,'receipt.json')}))
}
