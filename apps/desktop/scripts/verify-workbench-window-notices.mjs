import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { sourceAliases } from './fixtures/launcher-launchpad/vitest.owning.config.mts'
import { runProbeProcess } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const fixture = path.join(root, 'apps/desktop/scripts/fixtures/workbench-window-notices')
const evidence = path.resolve(process.argv.find((value,index) => index>1 && !value.startsWith('--')) ?? path.join(root,'.local/window-return/notices'))
const require = createRequire(path.join(root,'apps/desktop/package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const app = 'apps/desktop/src/renderer/src/App.tsx'
const owner = 'apps/desktop/src/renderer/src/lib/workbench-windows.tsx'
const component = 'apps/desktop/src/renderer/src/components/WorkbenchWindowNotice.tsx'
const css = 'apps/desktop/src/renderer/src/styles/service-notice.css'
const sources = [app,owner,component,css,'apps/desktop/src/renderer/src/components/ServiceNoticeDisclosure.tsx',
 'apps/desktop/scripts/verify-workbench-window-notices.mjs','apps/desktop/scripts/fixtures/workbench-window-notices/entry.mjs',
 'apps/desktop/scripts/fixtures/workbench-window-notices/main.cjs','apps/desktop/scripts/fixtures/workbench-window-notices/index.html',
 'apps/desktop/scripts/fixtures/launcher-launchpad/vitest.owning.config.mts','pnpm-lock.yaml']
const fingerprints = async files => Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await fs.readFile(path.join(root,file)))])))
const current = await fingerprints(sources)
let prior
try { prior = JSON.parse(await fs.readFile(path.join(evidence,'receipt.json'),'utf8')) } catch {}
// Reuse only the exact proof inputs and every loaded production module. A changed
// candidate, fixture or verifier requires a fresh actual product invocation.
let reusable = false
if(!process.argv.includes('--capture-only') && prior?.passed && prior.mutations?.length===2 &&
 JSON.stringify(prior.sources)===JSON.stringify(current) && Object.keys(prior.loadedInputs??{}).length>0) {
 try { reusable = JSON.stringify(await fingerprints(Object.keys(prior.loadedInputs)))===JSON.stringify(prior.loadedInputs) } catch {}
}
if(reusable) {
 console.log('window-notices: reusing exact candidate proof '+path.join(evidence,'receipt.json'))
 process.exit(0)
}
const privateRoot = await fs.mkdtemp(path.join(tmpdir(),'amux-window-notice-'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const receipt = {schema:'agentmux.workbench-window-notice.v1',passed:false,visualReview:'pending-independent-review',mutations:[]}
await fs.mkdir(evidence,{recursive:true})
try {
 receipt.sources = current
 const execute = async mutation => {
  const directory=path.join(evidence,mutation?.name??'baseline');await fs.mkdir(directory,{recursive:true})
  const compiled=new Map(), loadedInputs=new Map(), hits=[]
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true'},resolve:{alias:sourceAliases},esbuild:{jsx:'automatic'},worker:{format:'es'},
   plugins:[{name:'private-window-notice-proof',enforce:'pre',
    resolveId(id){
     if(/^(\.\.\/)+shared\/zone-file-resource(?:\.js)?$/.test(id))return '\0unused-zone-file-resource'
     if(/(^|\/)ConversationView(?:\.js)?$/.test(id))return '\0unused-conversation-view'
    },
    load(id){if(id==='\0unused-zone-file-resource')return 'export function zoneFileResource(){throw new Error("Unused native file leaf")}'
     if(id==='\0unused-conversation-view')return 'export function ConversationView(){throw new Error("Unused native history leaf")}'},
    async transform(source,id){
     const file=path.relative(root,id.split('?')[0]);if(!file.startsWith('apps/desktop/src/')&&!file.startsWith('packages/'))return
     let code=source
     if(mutation?.file===file){assert.equal(source.split(mutation.before).length-1,1,'Exact nonempty production mutation anchor');code=source.replace(mutation.before,mutation.after);hits.push({file,source:hash(source),loaded:hash(code)})}
     compiled.set(file,hash(code));loadedInputs.set(file,hash(await fs.readFile(path.join(root,file))));if(code!==source)return {code,map:null}
    }}],build:{outDir:path.join(directory,'renderer'),emptyOutDir:true,minify:false}})
  for(const file of [app,owner,component])assert.ok(compiled.has(file),'Actual production consumer compiled: '+file)
  const main=path.join(privateRoot,(mutation?.name??'baseline')+'.cjs');await fs.copyFile(path.join(fixture,'main.cjs'),main)
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')&&key!=='ELECTRON_RUN_AS_NODE'))
  const result=await runProbeProcess(require('electron'),[main,path.join(directory,'renderer/index.html'),privateRoot,directory,mutation?'mutation':'baseline'],{cwd:root,temporaryRoot:privateRoot,env,timeoutMs:45000,onLine:line=>process.stderr.write(line.slice(0,600)+'\n')})
  const ui=JSON.parse(await fs.readFile(path.join(directory,'ui-receipt.json'),'utf8'))
  if(mutation){assert.equal(hits.length,1);assert.equal(result.exitCode,1);assert.match(ui.failure?.message??'',new RegExp(mutation.failure));receipt.mutations.push({...mutation,hits,killed:true,failure:ui.failure.message})}
  else {assert.equal(result.exitCode,0,JSON.stringify(ui.failure));assert.equal(ui.passed,true);receipt.ui=ui;receipt.compiled=Object.fromEntries(compiled);receipt.loadedInputs=Object.fromEntries(loadedInputs)}
  console.log('window-notices '+(mutation?.name??'baseline')+': passed')
 }
 await execute(null)
 if(!process.argv.includes('--capture-only'))for(const mutation of [
  {name:'global-document-flow',file:app,before:'<GitHistoryProvider workspace={gitWorkspace}>',after:'<GitHistoryProvider workspace={gitWorkspace}><WorkbenchWindowNotices />',failure:'preserve the complete original App geometry'},
  {name:'missing-current-warning',file:component,before:'notices={notices}',after:'notices={[]}',failure:'remains discoverable'}
 ])await execute(mutation)
 receipt.after=await fingerprints(sources)
 assert.deepEqual(receipt.after,receipt.sources,'Private compiler mutations never alter the candidate')
 receipt.passed=true
} catch(error){receipt.failure={message:error.message,stack:error.stack};throw error}
finally {await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));await fs.rm(privateRoot,{recursive:true,force:true});console.log('window-notices evidence='+evidence)}
