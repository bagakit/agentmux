import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {sourceAliases} from './fixtures/launcher-launchpad/vitest.owning.config.mts'
import {runProbeProcess} from './probe-process.mjs'
const repository=resolve(import.meta.dirname,'../../..'),fixture=join(import.meta.dirname,'fixtures/source-launcher-failure')
const evidence=resolve(process.argv[2]??'.tmp/source-launcher-failure'),temporaryRoot=await mkdtemp(join(tmpdir(),'amux-source-failure-'))
const require=createRequire(join(repository,'apps/desktop/package.json')),{build}=await import(require.resolve('vite'))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sources={}
const receipt={passed:false,captureOnly:true,visualReview:'pending-independent-review',boundary:'Actual isolated WorkspaceWorkbench/NewTabSurface/SourceLauncherRequest and production CSS; only external public Source DTOs controlled. No installed App, original task or real Native recovery claim.'}
await mkdir(evidence,{recursive:true})
try{
 await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:sourceAliases},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},worker:{format:'es'},plugins:[{name:'original-source-failure-capture',enforce:'pre',transform(code,id){const path=id.split('?')[0];if(path.startsWith(join(repository,'apps/desktop/src/renderer/src/')))sources[path.slice(repository.length+1)]=hash(code)},async generateBundle(){for(const file of this.getWatchFiles())if(file.startsWith(join(repository,'apps/desktop/src/renderer/src/'))&&file.endsWith('.css'))sources[file.slice(repository.length+1)]=hash(await readFile(file))}}],build:{outDir:join(temporaryRoot,'renderer'),emptyOutDir:true}})
 for(const name of ['WorkspaceWorkbench','NewTabSurface','SourceLauncherRequest'])assert(sources[`apps/desktop/src/renderer/src/components/${name}.tsx`])
 await writeFile(join(temporaryRoot,'main.cjs'),await readFile(join(fixture,'main.cjs')))
 const {build:bundle}=await import(createRequire(join(repository,'packages/core/package.json')).resolve('esbuild'))
 const alias=Object.fromEntries(sourceAliases.map(item=>[item.find,item.replacement]))
 for(const [entry,outfile] of [['apps/desktop/src/preload/index.ts','preload.cjs'],['apps/desktop/src/main/native-desktop-ipc.ts','native-ipc.cjs']])await bundle({entryPoints:[join(repository,entry)],outfile:join(temporaryRoot,outfile),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent',alias})
 for(const entry of ['apps/desktop/src/preload/index.ts','apps/desktop/src/main/native-desktop-ipc.ts'])sources[entry]=hash(await readFile(join(repository,entry)))
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')&&key!=='ELECTRON_RUN_AS_NODE'))
 const result=await runProbeProcess(require('electron'),[join(temporaryRoot,'main.cjs'),join(temporaryRoot,'renderer/index.html'),join(temporaryRoot,'profile'),evidence],{cwd:repository,temporaryRoot,env,timeoutMs:60000,onLine:line=>process.stderr.write(line.slice(0,300)+'\n')})
 const ui=JSON.parse(await readFile(join(evidence,'ui-receipt.json'),'utf8'));Object.assign(receipt,{sources,ui,exitCode:result.exitCode})
 assert.equal(result.exitCode,0,JSON.stringify(ui.failure));assert.equal(ui.passed,true)
 receipt.frames=await Promise.all(ui.frames.map(async file=>({file,sha256:hash(await readFile(join(evidence,file)))})));receipt.passed=true
}catch(error){receipt.failure={message:error.message};process.exitCode=1}
finally{try{await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2))}finally{await rm(temporaryRoot,{recursive:true,force:true})}console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure}))}
