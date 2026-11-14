import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { sourceAliases } from './fixtures/launcher-launchpad/vitest.owning.config.mts'
import { runProbeProcess } from './probe-process.mjs'
const repository=resolve(import.meta.dirname,'../../..'),fixture=join(import.meta.dirname,'fixtures/mounted-creation')
const evidence=resolve(process.argv[2]??'.tmp/mounted-creation'),temporaryRoot=await mkdtemp(join(tmpdir(),'amux-mounted-creation-'))
const require=createRequire(join(repository,'apps/desktop/package.json')),{build}=await import(require.resolve('vite'))
const sources={},hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const receipt={passed:false,captureOnly:true,visualReview:'pending-independent-review',boundary:'Actual isolated Renderer/Workbench and production CSS with controlled public observations; no production SG1 or installed App claim.'}
await mkdir(evidence,{recursive:true})
try{
 await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:sourceAliases},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},worker:{format:'es'},plugins:[{name:'capture-exact-source',enforce:'pre',transform(source,id){const file=id.split('?')[0];if(file.startsWith(join(repository,'apps/desktop/src/renderer/src/')))sources[file.slice(repository.length+1)]=hash(source)}}],build:{outDir:join(temporaryRoot,'renderer'),emptyOutDir:true}})
 for(const name of ['MountedSpaceWorkbench','MountedCreationRecovery','FullPageLoadingSurface'])assert(sources[`apps/desktop/src/renderer/src/components/${name}.tsx`])
 await writeFile(join(temporaryRoot,'main.cjs'),await readFile(join(fixture,'main.cjs')))
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')&&key!=='ELECTRON_RUN_AS_NODE'))
 const result=await runProbeProcess(require('electron'),[join(temporaryRoot,'main.cjs'),join(temporaryRoot,'renderer/index.html'),join(temporaryRoot,'profile'),evidence],{cwd:repository,temporaryRoot,env,timeoutMs:60000,onLine:line=>process.stderr.write(line.slice(0,300)+'\n')})
 const ui=JSON.parse(await readFile(join(evidence,'ui-receipt.json'),'utf8'));Object.assign(receipt,{sources,ui,exitCode:result.exitCode})
 assert.equal(result.exitCode,0,JSON.stringify(ui.failure));assert.equal(ui.passed,true)
 receipt.frames=await Promise.all(ui.frames.map(async file=>({file,sha256:hash(await readFile(join(evidence,file)))})));receipt.passed=true
}catch(error){receipt.failure={message:error.message};process.exitCode=1}
finally{await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));await rm(temporaryRoot,{recursive:true,force:true});console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure}))}
