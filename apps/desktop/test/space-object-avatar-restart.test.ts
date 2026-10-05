import { expect,it } from 'vitest'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild') as {build(options: Record<string,unknown>): Promise<unknown>}
import { readFile,mkdir,copyFile,rm,mkdtemp } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

it('two real fresh Node processes in different package locations retain original Main choices and immutable assets',async()=>{
  const repository=resolve(import.meta.dirname,'../../..'),root=await mkdtemp(join(repository,'.tmp-avatar-restart-'))
  try {
    const a=join(root,'package-one'),b=join(root,'package-two');await mkdir(a);await mkdir(b)
    const aliases:Record<string,string>={'@ctxmux/sdk':join(repository,'packages/core/node_modules/@ctxmux/sdk/dist/index.js'),'@ctxmux/sdk/integrations':join(repository,'packages/core/node_modules/@ctxmux/sdk/dist/integrations/index.js')}
    for(const name of ['core','layout','demand','client-ui']){
      const directory=join(repository,'packages',name), manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
      for(const [key,value] of Object.entries(manifest.exports) as [string,any][]){
        if(key.includes('*'))continue
        const source=name==='client-ui'?value.browser:value.import?.replace('./dist/',name==='core'?'./src/':'./').replace(/\.js$/,'.ts')
        if(source?.startsWith('./src/')||source?.endsWith('.ts')) aliases['@agentmux/'+name+(key==='.'?'':key.slice(1))]=join(directory,source)
      }
    }
    const relay=join(repository,'packages/core/node_modules/@agentmux/relay');for(const [sub,target] of Object.entries(JSON.parse(await readFile(join(relay,'package.json'),'utf8')).exports) as [string,any][]) aliases['@agentmux/relay'+(sub==='.'?'':sub.slice(1))]=join(relay,target.import)
    const out=join(a,'entry.cjs')
    await build({entryPoints:[join(repository,'apps/desktop/scripts/fixtures/mote-avatar-durable/process.ts')],outfile:out,bundle:true,platform:'node',format:'cjs',alias:aliases,loader:{'.png':'dataurl','.css':'empty'},
      banner:{js:"const fixtureModuleUrl=require('node:url').pathToFileURL(__filename).href"},define:{__AGENTMUX_WEB_PREVIEW__:'true','import.meta.url':'fixtureModuleUrl'},plugins:[{name:'original-client-source',setup(b:any){
        b.onResolve({filter:/^@agentmux\/client-ui\//},(args:any)=>{const sub=args.path.slice('@agentmux/client-ui/'.length);return {path:join(repository,'packages/client-ui/src',sub.startsWith('components/')?sub+'.tsx':sub.startsWith('note/')?sub+'.ts':'lib/'+sub+'.ts')}})
        b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'private-app'}))
        b.onLoad({filter:/.*/,namespace:'private-app'},()=>({contents:"import {join} from 'node:path';export const app={getPath:name=>join(process.env.AVATAR_FIXTURE_ROOT,name),getAppPath:()=>process.cwd()}",loader:'js'}))
      }}],logLevel:'silent'})
    await copyFile(out,join(b,'entry.cjs'))
    const execute=(directory:string,mode:string)=>{const child=spawnSync(process.execPath,[join(directory,'entry.cjs'),mode],{cwd:directory,env:{...process.env,NODE_PATH:[join(repository,'packages/core/node_modules'),join(repository,'packages/core/node_modules/@agentmux/relay/node_modules'),join(repository,'apps/desktop/node_modules'),join(repository,'packages/client-ui/node_modules')].join(':'),AVATAR_FIXTURE_ROOT:root,AGENTMUX_STATE_DIRECTORY:join(root,'state')},encoding:'utf8',timeout:30000});expect(child.status,child.stderr).toBe(0);return JSON.parse(child.stdout.trim().split('\n').at(-1)!)}
    const before=execute(a,'write'),after=execute(b,'read')
    expect(after.pid).not.toBe(before.pid);expect(after.packageLocation).not.toBe(before.packageLocation)
    expect(after.choices).toEqual(before.choices);expect(after.projection).toEqual(before.projection)
    expect(after.projection[0].image.dataUrl).toBe('data:image/png;base64,'+after.png)
    expect(after.projection[1].parts).toMatchObject({kind:'face',eyes:'spark',marking:'freckles'})
    const manifest=await readFile(join(root,'user-data','config.json'),'utf8')
    expect(Object.keys(JSON.parse(manifest).appearance.spaceObjectIcons)).toHaveLength(2)
    console.log('avatar restart receipt',JSON.stringify({passed:true,processes:2,beforePid:before.pid,afterPid:after.pid,differentPackageLocation:true,configSha256:createHash('sha256').update(manifest).digest('hex'),originalAssetRead:true}))
  } finally {await rm(root,{recursive:true,force:true})}
},60000)
