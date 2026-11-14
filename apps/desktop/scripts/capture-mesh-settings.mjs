import { build } from 'vite'
import { aliases, root as candidateRoot } from './fixtures/settings-resource-library/environment.mjs'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { runProbeProcess } from './probe-process.mjs'
const root=resolve(import.meta.dirname,'../../..'),evidence=resolve(root,process.env.AGENTMUX_MESH_CAPTURE_EVIDENCE ?? '.local/state/mesh-network-access/ui-visual'),temporaryRoot=await mkdtemp('/tmp/amux-mesh-capture-'),require=createRequire(import.meta.url)
await mkdir(evidence,{recursive:true})
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
try{
 await build({configFile:false,root:resolve(import.meta.dirname,'fixtures/mesh-settings'),base:'./',logLevel:'error',resolve:{alias:aliases},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},worker:{format:'es'},plugins:[{name:'mesh-capture-source',enforce:'pre',transform(input,id){if(id.startsWith(candidateRoot+'/')&&!id.includes('/node_modules/')&&!id.includes('?'))appendFileSync(join(evidence,'built.jsonl'),JSON.stringify({path:id.slice(candidateRoot.length+1),sha256:createHash('sha256').update(input).digest('hex')})+'\n')}}],build:{outDir:join(temporaryRoot,'site'),emptyOutDir:true}})
 const result=await runProbeProcess(require('electron'),[resolve(import.meta.dirname,'fixtures/mesh-settings/capture.cjs'),pathToFileURL(join(temporaryRoot,'site/index.html')).href,join(temporaryRoot,'profile'),evidence,...process.argv.slice(2)],{cwd:root,env,timeoutMs:60000,temporaryRoot,onLine:line=>process.stderr.write(line.slice(0,200)+'\n')});await writeFile(join(evidence,'process.json'),JSON.stringify(result,null,2));if(result.exitCode!==0)throw Error('Mesh capture process failed; inspect original capture.json/process.json')}
finally{await rm(temporaryRoot,{recursive:true,force:true})}
