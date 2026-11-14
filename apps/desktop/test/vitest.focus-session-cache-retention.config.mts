import {defineConfig} from 'vitest/config'
import {readFileSync,appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {relative,resolve} from 'node:path'
import base from './vitest.continuity-projection.config.mts'
const root=resolve(import.meta.dirname,'../../..')
const inverse=process.env.FOCUS_SESSION_CACHE_INVERSE?JSON.parse(readFileSync(process.env.FOCUS_SESSION_CACHE_INVERSE,'utf8')):undefined
export default defineConfig({...base,plugins:[{
 name:'focus-session-cache-source-proof',enforce:'pre',transform(original,id){
  const file=relative(root,id.split('?')[0]!)
  if(!['apps/desktop/test/focus-session-cache-retention.test.tsx','apps/desktop/src/renderer/src/store.ts','apps/desktop/src/renderer/src/lib/session-state.ts','apps/desktop/src/renderer/src/lib/focus-context.ts','apps/desktop/src/renderer/src/lib/use-observed-app-store.ts','apps/desktop/src/renderer/src/components/AgentAvatar.tsx','apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx','apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'].includes(file))return
  let code=original
  if(inverse?.file===file){if(code.split(inverse.before).length!==2)throw Error('Inverse must match exactly one owning cache: '+inverse.name);code=code.replace(inverse.before,inverse.after)}
  if(process.env.FOCUS_SESSION_CACHE_LOADED)appendFileSync(process.env.FOCUS_SESSION_CACHE_LOADED,JSON.stringify({file,sourceSHA256:createHash('sha256').update(original).digest('hex'),loadedSHA256:createHash('sha256').update(code).digest('hex'),...(code===original?{}:{inverse:inverse.name})})+'\n')
  return code===original?undefined:{code,map:null}
 }},...base.plugins??[]],test:{...base.test,include:process.env.FOCUS_SESSION_CACHE_REGRESSIONS?['apps/desktop/test/focus-conversation-facts.test.tsx','apps/desktop/test/workspace-agent-projection.test.tsx','apps/desktop/test/focus-speaker-retention.test.tsx','apps/desktop/test/focus-work-history.test.tsx','apps/desktop/test/focus-timeline-hover-inspection.test.tsx']:['apps/desktop/test/focus-session-cache-retention.test.tsx'],exclude:[],pool:'forks',poolOptions:{forks:{execArgv:['--expose-gc']}},testNamePattern:process.env.FOCUS_SESSION_CACHE_PATTERN??undefined,testTimeout:20000}})
