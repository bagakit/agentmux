import {createHash} from 'node:crypto'
import {relative} from 'node:path'
import current from './vitest.goal-current-work.config.mts'
const root=process.cwd()
const owners=new Set(['apps/desktop/src/renderer/src/components/GoalPlanRequest.tsx','apps/desktop/src/renderer/src/components/GoalPatrolControl.tsx',
  'apps/desktop/src/renderer/src/lib/goal-discussion-recipient.ts','apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx',
  'apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts','apps/desktop/src/renderer/src/store.ts'])
const mutation=process.env.GOAL_REQUEST_TARGET_MUTANT?JSON.parse(process.env.GOAL_REQUEST_TARGET_MUTANT):null
const hash=(source:string)=>createHash('sha256').update(source).digest('hex')
export default {...current,plugins:[...current.plugins??[],{name:'exact-goal-request-owner',enforce:'pre' as const,transform(source:string,id:string){
  const path=relative(root,id.split('?')[0]!)
  if(!owners.has(path))return
  const originalSHA256=hash(source)
  if(mutation?.path===path)for(const edit of mutation.edits){if(source.split(edit.anchor).length!==2)throw Error('An exact target mutation requires one original owner segment');source=source.replace(edit.anchor,()=>edit.replacement)}
  const loaded=process.env.GOAL_REQUEST_TARGET_LOADED
  if(!loaded)return source
  const row={path,originalSHA256,loadedSHA256:hash(source),...(mutation?.path===path?{mutant:mutation.id}:{})}
  return `import {appendFileSync as __exactGoalTargetLoaded} from 'node:fs';__exactGoalTargetLoaded(${JSON.stringify(loaded)},${JSON.stringify(JSON.stringify(row)+'\n')});\n`+source
}}],test:{...current.test,include:['apps/desktop/test/goal-exact-request-target.test.tsx','apps/desktop/test/goal-plan-discovery-product.test.tsx','apps/desktop/test/goal-plan-graph.test.tsx','apps/desktop/test/goal-related-consumer-cost.test.tsx'],maxWorkers:1,fileParallelism:false,passWithNoTests:false}}
