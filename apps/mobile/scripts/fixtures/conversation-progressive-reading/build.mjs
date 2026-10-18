import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
export async function buildMobile({root, output}) {
  const require = createRequire(resolve(root, 'apps/desktop/package.json'))
  const { build } = createRequire(require.resolve('vite'))('esbuild')
  const aliases = { '@mobile': resolve(root, 'apps/mobile/src'), react: resolve(root, 'apps/desktop/node_modules/react'), 'react-dom': resolve(root, 'apps/desktop/node_modules/react-dom') }
  const packages = new Map()
  for (const name of ['core','relay','identity','layout','demand','git','client-ui']) {
    const folder = resolve(root, 'packages',name), manifest = JSON.parse(await readFile(resolve(folder,'package.json'),'utf8'))
    packages.set(name,{folder,exports:Object.entries(manifest.exports).sort(([a],[b])=>Number(a.includes('*'))-Number(b.includes('*'))||b.length-a.length)})
  }
  const sourceExports = {name:'original-mobile-source-exports',setup(plugin){
    plugin.onResolve({filter:/^@agentmux\/(?:core|relay|identity|layout|demand|git|client-ui)(?:\/|$)/},args=>{
      const [,name,rest='']=args.path.match(/^@agentmux\/([^/]+)(.*)$/), info=packages.get(name), sub='.'+rest
      for(const [key,target] of info.exports){
        const [prefix,suffix='']=key.split('*')
        if(key.includes('*')?!sub.startsWith(prefix)||!sub.endsWith(suffix):key!==sub)continue
        let source=typeof target==='string'?target:target.browser??target.import
        source=source.replace('*',sub.slice(prefix.length,suffix?-suffix.length:undefined))
        if(source.startsWith('./dist/'))source=source.replace(/^\.\/dist\/(?:src\/)?/,'./src/').replace(/\.js$/,'.ts')
        return {path:resolve(info.folder,source)}
      }
      throw Error('Original source export absent: '+args.path)
    })
  }}
  const workerInputs={}
  const workers={name:'original-mobile-monaco',setup(plugin){
    plugin.onResolve({filter:/\?url$/},args=>({path:require.resolve(args.path.replace(/\?url$/,'')),namespace:'original-url'}))
    plugin.onLoad({filter:/.*/,namespace:'original-url'},async args=>{workerInputs[args.path]={};return {loader:'file',contents:await readFile(args.path)}})
    plugin.onResolve({filter:/\?worker$/},args=>({path:require.resolve(args.path.replace(/\?worker$/,'')),namespace:'original-worker'}))
    plugin.onLoad({filter:/.*/,namespace:'original-worker'},async args=>{const built=await build({absWorkingDir:root,entryPoints:[args.path],bundle:true,write:false,platform:'browser',format:'iife',target:'esnext',metafile:true,logLevel:'error'});Object.assign(workerInputs,built.metafile.inputs);return {loader:'js',contents:`export default class OriginalWorker extends Worker{constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(built.outputFiles[0].text)}],{type:'text/javascript'})))}}`}})
  }}
  const folder=resolve(output,'mobile');await mkdir(folder,{recursive:true})
  const fixture=dirname(fileURLToPath(import.meta.url))
  const built=await build({absWorkingDir:root,entryPoints:[resolve(fixture,'entry.tsx')],outdir:folder,bundle:true,format:'esm',platform:'browser',target:'esnext',jsx:'automatic',metafile:true,logLevel:'error',alias:aliases,
    plugins:[sourceExports,workers],loader:{'.png':'file','.gif':'file','.svg':'file','.woff':'file','.woff2':'file','.ttf':'file'},define:{'process.env.NODE_ENV':'"production"',__AGENTMUX_WEB_PREVIEW__:'true'}})
  await writeFile(resolve(folder,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script type="module" src="entry.js"></script></body></html>')
  const preload=resolve(folder,'preload.cjs')
  const nodeBuilt=await build({absWorkingDir:root,entryPoints:[resolve(fixture,'preload.ts')],outfile:preload,bundle:true,format:'cjs',platform:'node',target:'node22',metafile:true,logLevel:'error',external:['electron']})
  execFileSync(process.execPath,['--check',preload],{stdio:'pipe'})
  const source={};const sha=value=>createHash('sha256').update(value).digest('hex')
  for(const file of Object.keys({...built.metafile.inputs,...nodeBuilt.metafile.inputs,...workerInputs}).filter(file=>!file.startsWith('original-')&&!file.startsWith('(disabled):')))source[relative(root,resolve(root,file))]=sha(await readFile(resolve(root,file)))
  for(const file of ['entry.tsx','preload.ts','build.mjs','exercise.mjs'])source[relative(root,resolve(fixture,file))]=sha(await readFile(resolve(fixture,file)))
  return {source,folder,preload,exercise:resolve(fixture,'exercise.mjs'),boundary:'Original MobileConversationSurface and SDK in isolated Chromium, with the original HTTP RPC transport in Main and a private IPC bridge; no physical phone or Relay qualification.'}
}
