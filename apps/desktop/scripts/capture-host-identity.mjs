import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(desktop,'../..'),fixture=path.join(desktop,'scripts/fixtures/host-identity')
const require=createRequire(path.join(desktop,'package.json')),{build}=await import(require.resolve('vite'))
const mutant=process.env.AGENTMUX_HOST_IDENTITY_WRAP_MUTANT==='1'
const out=path.join(root,'.tmp/host-identity',(mutant?'mutant-':'')+globalThis.crypto.randomUUID());await fs.mkdir(out,{recursive:true})
const files=['components/HostBadge.tsx','components/FocusProjectLanes.tsx','components/TopRowChrome.tsx','components/WorkspaceBoard.tsx','components/ProjectGroupsTree.tsx','components/WorkspaceSidebar.tsx','lib/region-execution-host.ts','styles/host-identity.css','styles/index.css','styles/board.css'].map(f=>'apps/desktop/src/renderer/src/'+f)
const inputHashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')])))
await fs.writeFile(path.join(out,'input-hashes.json'),JSON.stringify(inputHashes,null,2))
const alias=['notebook-catalog','prompt-reaction'].map(name=>({find:`@agentmux/core/${name}`,replacement:path.join(root,`packages/core/src/${name}.ts`)}))
alias.push({find:'@agentmux/client-ui/components/ConversationReactionActions',replacement:path.join(root,'packages/client-ui/src/components/ConversationReactionActions.tsx')})
alias.push({find:'papaparse',replacement:path.join(root,'node_modules/.pnpm/papaparse@5.5.3/node_modules/papaparse/papaparse.js')})
alias.push({find:'pdfjs-dist',replacement:path.join(root,'node_modules/.pnpm/pdfjs-dist@6.3.289/node_modules/pdfjs-dist')})
alias.push({find:'jsonc-parser',replacement:path.join(root,'node_modules/.pnpm/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/main.js')})
alias.push({find:'@agentmux/client-ui/styles',replacement:path.join(root,'packages/client-ui/src/styles')})
const boardFile=path.join(root,'apps/desktop/src/renderer/src/styles/board.css'), indexFile=path.join(root,'apps/desktop/src/renderer/src/styles/index.css')
const before='.board-toolbar--matrix { display: flex; flex-wrap: wrap; }', reverted='.board-toolbar--matrix { grid-template-columns: minmax(220px, 1fr) 138px 138px auto auto auto; }'
let mutationApplied=false
const mutate=code=>{if(!code.includes(before))throw Error('Grid mutation target missing');mutationApplied=true;return code.replace(before,reverted)}
const cssMutation={name:'host-identity-wrap-mutant',enforce:'pre',async transform(code,id){
 if(!mutant)return
 const file=id.split('?')[0]
 if(file===boardFile)return mutate(code)
 // PostCSS inlines CSS @imports before their own Vite transform. Substitute the actual
 // owning file with a private mutated CSS input at its existing import position.
 // Keep an @import rather than inline rules so later product imports remain intact.
 if(file===indexFile&&code.includes("@import './board.css';")){const privateCss=path.join(out,'board-mutant.css');await fs.writeFile(privateCss,mutate(await fs.readFile(boardFile,'utf8')));return code.replace("@import './board.css';",`@import '${privateCss}';`)}
}}

const result=await build({plugins:[cssMutation],configFile:false,root:fixture,base:'./',resolve:{alias},define:{__AGENTMUX_WEB_PREVIEW__:'true'},build:{target:'esnext',outDir:path.join(out,'renderer'),emptyOutDir:true,minify:false,rollupOptions:{input:path.join(fixture,'index.html')}},logLevel:'warn'})
if(mutant&&!mutationApplied)throw Error('CSS mutation was not loaded')
await fs.writeFile(path.join(out,'compile.json'),JSON.stringify({root,alias,mutant,mutationApplied,modules:Object.keys(result.output.filter(x=>x.type==='chunk').reduce((a,c)=>Object.assign(a,c.modules),{}))},null,2))
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const code=await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[path.join(fixture,'main.cjs'),path.join(out,'renderer/index.html'),out],{cwd:root,env,stdio:'inherit'});child.on('error',reject);child.on('exit',resolve)})
const after=Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')])))
await fs.writeFile(path.join(out,'candidate-stability.json'),JSON.stringify({unchanged:JSON.stringify(after)===JSON.stringify(inputHashes),before:inputHashes,after},null,2))
console.log(out);if(code)process.exitCode=code
