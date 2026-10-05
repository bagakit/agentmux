import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
it('independent second process hydrates mixed old/new Tabs, splits and focus from the actual Core durable spatial owner', async () => {
  const home=await mkdtemp(join(tmpdir(),'amux-object-restore-'))
  try {
    const worker=join(home,'worker.mjs'), state=join(home,'spatial.json'), expected=join(home,'expected.json')
    const {build}=createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
    const alias: Record<string,string>={'@agentmux/layout':resolve('packages/layout/src/index.ts'),'@agentmux/identity':resolve('packages/identity/src/index.ts')}
    const manifest=JSON.parse(readFileSync(resolve('packages/core/package.json'),'utf8'))
    for(const [name,value] of Object.entries(manifest.exports) as [string,{import?:string}][]) {
      if(!value.import)continue
      const source=resolve('packages/core',value.import.replace('./dist/','./src/').replace(/\.js$/,'.ts'))
      if(existsSync(source))alias[name==='.'?'@agentmux/core':'@agentmux/core/'+name.slice(2)]=source
    }
    expect(Object.keys(alias).length).toBeGreaterThan(20)
    const inputs: Record<string,string>={}
    await build({plugins:[{name:'actual-restoration-source-inputs',setup(builder) { builder.onLoad({filter:/\.(ts|tsx|js|mjs)$/},async args=> {
      if(args.path.includes('/node_modules/'))return null
      const bytes=await readFile(args.path,'utf8');inputs[args.path]=createHash('sha256').update(bytes).digest('hex')
      return {contents:bytes,loader:args.path.endsWith('.tsx')?'tsx':args.path.endsWith('.ts')?'ts':'js'}
    }) }}],stdin:{resolveDir:process.cwd(),contents:("\n      import assert from 'node:assert/strict';\n      import { readFileSync, writeFileSync } from 'node:fs';\n      import { AgentMuxSpatialStateStore } from './packages/core/src/spatial-state.ts';\n      import { mintObjectId } from '@agentmux/core/object-id';\n      import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout';\n      import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from './apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts';\n      import { restorePersistedWorkbench } from './apps/desktop/src/renderer/src/lib/workbench-persistence.ts';\n      import { createWorkbenchTab, addWorkbenchRegion, initialWorkbenchRegionId, fileTabId } from './apps/desktop/src/renderer/src/lib/workbench-tabs.ts';\n      import { fileWorkbenchIdentity } from './apps/desktop/src/renderer/src/lib/file-workbench-state.ts';\n      const [mode,file,expected]=process.argv.slice(2), owner=new AgentMuxSpatialStateStore(file);\n      const config={hosts:[{id:'local',kind:'local'}],workspaces:[{id:'original-workspace',hostId:'local',path:'" + _hygiene_fixturePath("original") + "',name:'Original',kind:'folder'}],executors:{}};\n      if(mode==='write') {\n        const old=createWorkbenchTab('file:original-workspace:old.ts',{kind:'file',workspaceId:'original-workspace',path:'old.ts',regionId:'region:file:original-workspace:old.ts'});\n        const split=mintObjectId(), retained=addWorkbenchRegion(old,old.titleRegionId,'right',{kind:'launcher',workspaceId:'original-workspace',regionId:split});\n        const id=fileTabId('original-workspace','new.ts'), fresh=createWorkbenchTab(id,{kind:'file',workspaceId:'original-workspace',path:'new.ts',regionId:initialWorkbenchRegionId(id)});\n        const spaceId=JSON.stringify(['local','" + _hygiene_fixturePath("original") + "']), space={spaceId,zoneId:JSON.stringify([spaceId,'workspace','original-workspace'])};\n        retained.space=space; fresh.space=space;\n        const group=mintObjectId(), layout=moveTabToNewGroup(createWorkspaceLayout('original-group',[retained.id,fresh.id]),fresh.id,'original-group','original-group','right',group);\n        const input={config,sessions:[],tabs:{[retained.id]:retained,[fresh.id]:fresh},layouts:{'original-workspace':layout},spaceZoneBindings:{},spatialRequests:{}};\n        const graph=desktopSpatialGraph(input,[]); const result=await owner.commit({expectedRevision:0,graph});\n        assert.equal(result.revision,1); writeFileSync(expected,JSON.stringify({tabs:input.tabs,layouts:input.layouts,split,newId:id}));\n      } else {\n        const original=JSON.parse(readFileSync(expected,'utf8')), saved=await owner.readForLayout();\n        const persisted=desktopWorkbenchFromSpatial(saved.graph);\n        const hydrated=restorePersistedWorkbench({config,sessions:[],persisted,createTabGroupId:mintObjectId,preserveEntityIds:new Set(saved.graph.tabs.map(t=>t.tabId))});\n        assert.deepEqual(hydrated.tabs,original.tabs); assert.deepEqual(hydrated.layouts,original.layouts);\n        assert.equal(hydrated.tabs['file:original-workspace:old.ts'].layout.activeRegionId,original.split);\n        assert.deepEqual(fileWorkbenchIdentity(hydrated,'original-workspace','old.ts'),{tabId:'file:original-workspace:old.ts',regionId:'region:file:original-workspace:old.ts'});\n        assert.equal(fileWorkbenchIdentity(hydrated,'original-workspace','new.ts').tabId,original.newId);\n        console.log(JSON.stringify({restored:true,oldTab:'file:original-workspace:old.ts',newTab:original.newId,split:original.split,groups:Object.keys(hydrated.layouts).length}));\n      }\n    ")},bundle:true,platform:'node',format:'esm',target:'node22',outfile:worker,conditions:['browser','import','default'],alias,logLevel:'silent'})
    execFileSync(process.execPath,[worker,'write',state,expected],{encoding:'utf8',timeout:15000})
    const output=JSON.parse(execFileSync(process.execPath,[worker,'read',state,expected],{encoding:'utf8',timeout:15000}))
    await mkdir(resolve('.local/state/unified-product-id'),{recursive:true})
    await writeFile(resolve('.local/state/unified-product-id/renderer-restore-worker.mjs'),await readFile(worker))
    await writeFile(resolve('.local/state/unified-product-id/renderer-restore-receipt.json'),JSON.stringify({schema:'amux.renderer-object-restore.v1',passed:true,workerPath:'.local/state/unified-product-id/renderer-restore-worker.mjs',workerSHA256:createHash('sha256').update(await readFile(worker)).digest('hex'),loadedSourceInputs:inputs,output},null,2)+'\n')
    expect(output.restored).toBe(true); expect(output.newTab).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(JSON.parse(await readFile(expected,'utf8')).tabs['file:original-workspace:old.ts']).toBeDefined()
  } finally { await rm(home,{recursive:true,force:true}) }
},30000)
