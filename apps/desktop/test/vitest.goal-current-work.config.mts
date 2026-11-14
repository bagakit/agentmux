import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.GOAL_CURRENT_WORK_MUTATION ? JSON.parse(process.env.GOAL_CURRENT_WORK_MUTATION) : null
const ownerPaths = ['GoalDetail','GoalWorkArea','GoalAlignment','GoalDelegationWork','GoalFiniteStartControl','GoalStartWork','GoalResponsibilitySummary','GoalPatrolControl'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)
ownerPaths.push('apps/desktop/src/renderer/src/lib/goal-presentation.ts','apps/desktop/src/renderer/src/lib/goal-groups.tsx')
export default {...original, resolve:{...original.resolve,alias:[{find:/^@agentmux\/host\/author-profile$/,replacement:resolve(root,'apps/host/src/public-author-profile.ts')},...(original.resolve?.alias as Array<{find:RegExp;replacement:string}>??[])]}, plugins:[...original.plugins??[],{name:'actual-current-work-owners',enforce:'pre' as const,transform(source:string,id:string){
  if(id.split('?')[0]===resolve(root,'packages/browser/scripts/source-build.mjs')) return source.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(id.split('?')[0]!).href))
  const path=relative(root,id.split('?')[0]!)
  if(!ownerPaths.includes(path))return
  const sha=(value:string)=>createHash('sha256').update(value).digest('hex'), originalSHA256=sha(source)
  if(mutation?.path===path){if(source.split(mutation.anchor).length!==2)throw Error('Current-work mutation needs one exact owner segment');source=source.replace(mutation.anchor,()=>mutation.replacement)}
  const output=process.env.GOAL_CURRENT_WORK_LOADED
  if(!output)return source
  const row={path,originalSHA256,loadedSHA256:sha(source),...(mutation?.path===path?{mutant:mutation.id}:{})}
  return `import {appendFileSync as __currentWorkLoaded} from 'node:fs';__currentWorkLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row)+'\n')});\n`+source
}}],test:{...original.test,env:{...original.test?.env,AGENTMUX_DAILY_GOAL_REPOSITORY:root},include:['apps/desktop/test/goal-current-work-product.test.tsx','apps/desktop/test/goal-current-work-report-product.test.tsx','apps/desktop/test/goal-next-step-stage.test.ts','apps/desktop/test/goals-alignment-workflow.test.tsx','apps/desktop/test/goal-delegation-work.test.tsx'],sequence:{...original.test?.sequence,hooks:'stack'},passWithNoTests:false}}
