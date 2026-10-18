import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { candidateResolve, candidateModule } from '../../../../desktop/scripts/candidate-package-resolve.mjs'
export async function buildMobile({root, output}) {
  const require = createRequire(resolve(root, 'apps/desktop/package.json'))
  const { build } = createRequire(require.resolve('vite'))('esbuild')
  const aliases = { '@mobile': resolve(root, 'apps/mobile/src'), react: resolve(root, 'apps/desktop/node_modules/react'), 'react-dom': resolve(root, 'apps/desktop/node_modules/react-dom') }
  const manifests = new Map()
  const sourceExports = {name:'original-mobile-source-exports',setup(plugin){
    plugin.onResolve({filter:/^@agentmux\//},args=>({path:candidateResolve(root,args.path,{browser:true,source:true,onManifest:(file,bytes)=>{
      const original=manifests.get(file)
      if(original&&!original.equals(bytes))throw Error('Candidate manifest changed while compiling: '+args.path)
      manifests.set(file,bytes)
    }})}))
  }}
  const workerInputs={}
  const workers={name:'original-mobile-monaco',setup(plugin){
    plugin.onResolve({filter:/\?url$/},args=>({path:require.resolve(args.path.replace(/\?url$/,'')),namespace:'original-url'}))
    plugin.onLoad({filter:/.*/,namespace:'original-url'},async args=>{workerInputs[args.path]={};return {loader:'file',contents:await readFile(args.path)}})
    plugin.onResolve({filter:/\?worker$/},args=>({path:require.resolve(args.path.replace(/\?worker$/,'')),namespace:'original-worker'}))
    plugin.onLoad({filter:/.*/,namespace:'original-worker'},async args=>{const built=await build({absWorkingDir:root,entryPoints:[args.path],bundle:true,write:false,platform:'browser',format:'iife',target:'esnext',metafile:true,logLevel:'error',plugins:[sourceExports]});Object.assign(workerInputs,built.metafile.inputs);return {loader:'js',contents:`export default class OriginalWorker extends Worker{constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(built.outputFiles[0].text)}],{type:'text/javascript'})))}}`}})
  }}
  const folder=resolve(output,'mobile');await mkdir(folder,{recursive:true})
  const fixture=dirname(fileURLToPath(import.meta.url))
  const built=await build({absWorkingDir:root,entryPoints:[resolve(fixture,'entry.tsx')],outdir:folder,bundle:true,format:'esm',platform:'browser',target:'esnext',jsx:'automatic',metafile:true,logLevel:'error',alias:aliases,
    plugins:[sourceExports,workers],loader:{'.png':'file','.gif':'file','.svg':'file','.woff':'file','.woff2':'file','.ttf':'file'},define:{'process.env.NODE_ENV':'"production"',__AGENTMUX_WEB_PREVIEW__:'true'}})
  await writeFile(resolve(folder,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script type="module" src="entry.js"></script></body></html>')
  const preload=resolve(folder,'preload.cjs')
  const nodeBuilt=await build({absWorkingDir:root,entryPoints:[resolve(fixture,'preload.ts')],outfile:preload,bundle:true,format:'cjs',platform:'node',target:'node22',metafile:true,logLevel:'error',external:['electron'],plugins:[sourceExports]})
  execFileSync(process.execPath,['--check',preload],{stdio:'pipe'})
  const source={};const sha=value=>createHash('sha256').update(value).digest('hex')
  for(const file of Object.keys({...built.metafile.inputs,...nodeBuilt.metafile.inputs,...workerInputs}).filter(file=>!file.startsWith('original-')&&!file.startsWith('(disabled):'))){
    const actual=candidateModule(root,resolve(root,file));source[relative(root,actual)]=sha(await readFile(actual))
  }
  for(const [file,bytes] of manifests){
    const original=sha(bytes)
    if(sha(await readFile(file))!==original)throw Error('Candidate manifest changed before receipt: '+relative(root,file))
    source[relative(root,file)]=original
  }
  const helper=resolve(root,'apps/desktop/scripts/candidate-package-resolve.mjs')
  source[relative(root,helper)]=sha(await readFile(helper))
  for(const file of ['entry.tsx','preload.ts','build.mjs','exercise.mjs'])source[relative(root,resolve(fixture,file))]=sha(await readFile(resolve(fixture,file)))
  return {source,folder,preload,exercise:resolve(fixture,'exercise.mjs'),boundary:'Original MobileConversationSurface and SDK in isolated Chromium, with the original HTTP RPC transport in Main and a private IPC bridge; no physical phone or Relay qualification.'}
}
