import { createRequire } from 'node:module'
import { resolve, join, relative } from 'node:path'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'../../..'), appRoot=join(root,'apps/desktop'), req=createRequire(join(appRoot,'package.json'))
const {build}=await import(req.resolve('vite'))
const output=resolve(process.argv[2]??join(root,'.tmp/pending-actual-app',String(globalThis.crypto.randomUUID())))
await mkdir(output,{recursive:true})
const fixture=join(appRoot,'scripts/fixtures/composer-pending-actual-app'), compiled=join(output,'out'), wrapper=join(output,'xterm.mjs')
const xterm=req.resolve('@xterm/xterm'), loaded={}
const hash=b=>createHash('sha256').update(b).digest('hex')
await writeFile(wrapper,`import xterm from ${JSON.stringify(xterm)};export class Terminal extends xterm.Terminal{constructor(...args){super(...args);(globalThis.resultReadyTerminals??=[]).push({id:globalThis.resultReadyTerminals.length,terminal:this,disposed:false})}dispose(){const r=globalThis.resultReadyTerminals.find(r=>r.terminal===this);if(r)r.disposed=true;return super.dispose()}}`)
await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[
  {find:/^@agentmux\/client-ui\/components\/(.+)$/,replacement:join(root,'packages/client-ui/src/components/$1.tsx')},
  {find:/^@agentmux\/client-ui\/styles\/(.+)$/,replacement:join(root,'packages/client-ui/src/styles/$1')},
  {find:/^@agentmux\/client-ui\/terminal\/(.+)$/,replacement:join(root,'packages/client-ui/src/terminal/$1.ts')},
  {find:/^@agentmux\/client-ui\/platform$/,replacement:join(root,'packages/client-ui/src/platform.tsx')},
  {find:/^@agentmux\/client-ui\/(.+)$/,replacement:join(root,'packages/client-ui/src/lib/$1.ts')},
  {find:/^@agentmux\/client-ui$/,replacement:join(root,'packages/client-ui/src/index.ts')},
  {find:/^@xterm\/xterm$/,replacement:wrapper},
  {find:/^@agentmux\/layout$/,replacement:join(root,'packages/layout/src/index.ts')},
  ...Object.entries(JSON.parse(await readFile(join(root,'packages/core/package.json'),'utf8')).exports).filter(([key,t])=>key!=='.'&&t.import).map(([key,t])=>({find:new RegExp('^@agentmux/core'+key.slice(1)+'$'),replacement:join(root,'packages/core',t.import.replace('./dist/','./src/').replace(/\.js$/,'.ts'))}))
]},plugins:[{name:'source-binding',enforce:'pre',transform(bytes,id){if(id.startsWith(root+'/')&&!id.includes('/node_modules/')&&!id.includes('?'))loaded[relative(root,id)]=hash(bytes)},async generateBundle(){for(const p of this.getWatchFiles())if(p.startsWith(root+'/')&&p.endsWith('.css'))loaded[relative(root,p)]=hash(await readFile(p))}}],
define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},
build:{outDir:compiled,emptyOutDir:true,minify:false,reportCompressedSize:false}})
for(const p of ['apps/desktop/src/renderer/src/components/ComposerPendingDelivery.tsx','apps/desktop/src/renderer/src/components/TerminalView.tsx','packages/client-ui/src/styles/composer.css'])assert.equal(loaded[p],hash(await readFile(join(root,p))),p+' actual consumed Source')
const compiledHashes={}
for(const e of await readdir(compiled,{recursive:true,withFileTypes:true}))if(e.isFile()){const p=join(e.parentPath,e.name);compiledHashes[relative(compiled,p)]=hash(await readFile(p))}
const drivers={}
for(const p of [join(fixture,'main.cjs'),import.meta.filename])drivers[relative(root,p)]=hash(await readFile(p))
const manifest={root,loaded,drivers,compiled:compiledHashes,xterm:{path:xterm,sha256:hash(await readFile(xterm))},electron:req('electron/package.json').version,userRunTouched:false,results:[]}
for(const profile of process.argv.length>3?process.argv.slice(3):['wide-dark','narrow-light','coarse-light']){
  const destination=join(output,profile);await mkdir(destination,{recursive:true})
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const logs=[]
  const child=spawn(req('electron'),[join(fixture,'main.cjs'),join(compiled,'index.html'),destination,profile],{cwd:root,env,stdio:['ignore','pipe','pipe']})
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},25000)
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs.push(b.toString()))
  const exit=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer)
  await writeFile(join(destination,'process.log'),logs.join(''))
  let facts
  try{facts=JSON.parse(await readFile(join(destination,'actual.json'),'utf8'))}catch(error){facts={passed:false,failure:{message:'Native facts unavailable: '+error.message}}}
  manifest.results.push({profile,...exit,timedOut,passed:facts.passed,failure:facts.failure??null})
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2))
  assert.equal(timedOut,false);assert.equal(exit.code,0,facts.failure?.message);assert.equal(facts.passed,true)
}
console.log(JSON.stringify({output,results:manifest.results}))
