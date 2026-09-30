import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root=resolve(import.meta.dirname,'../../../../..')
const global='apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'
const mutations={
  'drop-project-selection':['onValueChange={setProject}','onValueChange={() => {}}'],
  'drop-state-selection':['onValueChange={value => setBucketFilter(value as FocusColumn | \'all\')}','onValueChange={() => {}}'],
  'steal-later-focus':['if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body','if (false && focused instanceof HTMLElement && focused.isConnected && focused !== document.body']
} as const
export default defineConfig({...original,root,cacheDir:resolve(root,'.tmp/focus-narrow-filters-cache'),plugins:[...original.plugins??[],{
  name:'actual-loaded-focus-filter',enforce:'pre',transform(source,id){
    const path=id.split('?')[0]!;if(!path.startsWith(root+'/apps/desktop/src/'))return
    const key=process.env.AGENTMUX_FOCUS_FILTER_MUTATION as keyof typeof mutations|'old-64px-strategy'|undefined;let code=source
    if(key&&path===resolve(root,global)){
      if(key==='old-64px-strategy'){
        const start=source.indexOf('<FilterMenu.Root>'),end=source.indexOf('</FilterMenu.Root>',start)
        assert.ok(start>=0&&end>start,'Actual entire filter block, not empty slice')
        code=source.slice(0,start)+`<label className="global-board-select" style={{flex:'0 1 64px',minWidth:0}}><select aria-label="Focus project filter" style={{width:'100%',maxWidth:64}} value={project} onChange={event=>setProject(event.target.value)}><option value="all">All projects</option>{projectOptions.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}</select></label><label className="global-board-select" style={{flex:'0 1 64px',minWidth:0}}><select aria-label="Focus state filter" style={{width:'100%',maxWidth:64}} value={bucketFilter} onChange={event=>setBucketFilter(event.target.value as FocusColumn|'all')}><option value="all">All states</option>{buckets.map(bucket=><option key={bucket} value={bucket}>{bucketMeta[bucket].label}</option>)}</select></label>`+source.slice(end+'</FilterMenu.Root>'.length)
      }else{const m=mutations[key];assert.ok(m,'Known semantic mutation');assert.equal(source.split(m[0]).length-1,1,'Exact nonempty loaded anchor');code=source.replace(m[0],m[1])}
    }
    if(process.env.AGENTMUX_FOCUS_FILTER_LOADED)appendFileSync(process.env.AGENTMUX_FOCUS_FILTER_LOADED,JSON.stringify({path:relative(root,path),sourceSHA256:createHash('sha256').update(source).digest('hex'),loadedSHA256:createHash('sha256').update(code).digest('hex'),mutated:code!==source,...(code!==source?{mutation:key}:{})})+'\n')
    if(code!==source)return{code,map:null}
  }
}],test:{...original.test,include:['apps/desktop/test/focus-narrow-filters.test.tsx'],passWithNoTests:false,fileParallelism:false,maxWorkers:1,testTimeout:15000}})
