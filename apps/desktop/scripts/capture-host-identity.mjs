import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(desktop,'../..'),fixture=path.join(desktop,'scripts/fixtures/host-identity')
const require=createRequire(path.join(desktop,'package.json')),{build}=await import(require.resolve('vite'))
const out=path.join(root,'.tmp/host-identity',globalThis.crypto.randomUUID());await fs.mkdir(out,{recursive:true})
const files=['components/HostBadge.tsx','components/FocusProjectLanes.tsx','components/TopRowChrome.tsx','components/ProjectGroupsTree.tsx','components/WorkspaceSidebar.tsx','lib/region-execution-host.ts','styles/host-identity.css','styles/index.css'].map(f=>'apps/desktop/src/renderer/src/'+f)
const inputHashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')])))
await fs.writeFile(path.join(out,'input-hashes.json'),JSON.stringify(inputHashes,null,2))
const alias=['notebook-catalog','prompt-reaction'].map(name=>({find:`@agentmux/core/${name}`,replacement:path.join(root,`packages/core/src/${name}.ts`)}))
alias.push({find:'@agentmux/client-ui/components/ConversationReactionActions',replacement:path.join(root,'packages/client-ui/src/components/ConversationReactionActions.tsx')})
alias.push({find:'papaparse',replacement:path.join(root,'node_modules/.pnpm/papaparse@5.5.3/node_modules/papaparse/papaparse.js')})
alias.push({find:'pdfjs-dist',replacement:path.join(root,'node_modules/.pnpm/pdfjs-dist@6.3.289/node_modules/pdfjs-dist')})
alias.push({find:'jsonc-parser',replacement:path.join(root,'node_modules/.pnpm/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/main.js')})
const result=await build({configFile:false,root:fixture,base:'./',worker:{format:'es'},resolve:{alias},define:{__AGENTMUX_WEB_PREVIEW__:'true'},build:{target:'esnext',outDir:path.join(out,'renderer'),emptyOutDir:true,minify:false,rollupOptions:{input:path.join(fixture,'index.html')}},logLevel:'warn'})
await fs.writeFile(path.join(out,'compile.json'),JSON.stringify({root,alias,modules:Object.keys(result.output.filter(x=>x.type==='chunk').reduce((a,c)=>Object.assign(a,c.modules),{}))},null,2))
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const code=await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[path.join(fixture,'main.cjs'),path.join(out,'renderer/index.html'),out],{cwd:root,env,stdio:'inherit'});child.on('error',reject);child.on('exit',resolve)})
const after=Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')])))
await fs.writeFile(path.join(out,'candidate-stability.json'),JSON.stringify({unchanged:JSON.stringify(after)===JSON.stringify(inputHashes),before:inputHashes,after},null,2))
console.log(out);if(code)process.exitCode=code
