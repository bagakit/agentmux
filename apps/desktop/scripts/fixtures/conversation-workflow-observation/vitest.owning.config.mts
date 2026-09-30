import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import original from '../../../../../vitest.config'
const root=resolve(import.meta.dirname,'../../../../..')
export default defineConfig({...original,root,esbuild:{jsx:'automatic',jsxImportSource:'react'},cacheDir:resolve(root,'.bagakit/feature-tracker/conversation-input-cards-artifacts/T005/cache'),plugins:[...(original.plugins??[]),{name:'actual-workflow-observation-consumption',enforce:'pre',transform(code,id){
 const file=id.split('?')[0]!;if(!file.startsWith(root+'/apps/desktop/src/')&&!file.startsWith(root+'/packages/core/src/'))return
 const originalCode=code,mutation=process.env.AGENTMUX_WORKFLOW_OBSERVATION_MUTATION
 const replacements:Record<string,[string,string,string]>={
  'card-bypass':['components/workflow/WorkflowCard.tsx','? <RecordedStepsCard {...props} />','? null'],
  'tool-bypass':['components/workflow/WorkflowToolRow.tsx',"'observation' in props ? <RecordedToolRow {...props} />", "'observation' in props ? null"],
  'streaming-as-complete':['components/ActivityView.tsx','status: item.status,',"status: item.status === 'streaming' ? 'complete' : item.status,"],
  'hide-failure':['components/workflow/WorkflowToolRow.tsx',"status === 'failed' ? <span", "false ? <span"],
  'drop-payload':['components/ActivityView.tsx','{open && !diff && payload ? <pre','{false ? <pre'],
  'merge-equal-steps':['components/ActivityView.tsx','{items.map((item, index) => visible(item, index) ? <Row',"{items.filter((item, index) => items.findIndex((other) => other.title === item.title && other.toolInput === item.toolInput) === index).map((item, index) => visible(item, index) ? <Row"],
  'lose-read-row':['components/ActivityView.tsx',' || presentedIds.has(item.id)',''],
  'hide-failed-step':['components/ActivityView.tsx',"showAll || items.length <= 10 || presentedIds.has(item.id) || index >= items.length - 6 || item.status !== 'complete'","showAll || items.length <= 10 || presentedIds.has(item.id) || index >= items.length - 6"],
  'eager-diff':['components/ActivityView.tsx','if (!open || !payload) return null','if (!payload) return null'],
  'lose-disclosure':['components/workflow/WorkflowCard.tsx','{expanded || readOnce ? children : null}','{expanded ? children : null}']
 }
 const r=mutation?replacements[mutation]:null;if(r&&file===root+'/apps/desktop/src/renderer/src/'+r[0]){if(code.split(r[1]).length!==2)throw Error('Missing unique target '+mutation);code=code.replace(r[1],r[2])}
 if(mutation==='hide-failed-step'&&file===root+'/apps/desktop/src/renderer/src/components/ActivityView.tsx'){const a="if (items.length <= 10 || index >= items.length - 6 || item.status !== 'complete') next.add(item.id)";if(code.split(a).length!==2)throw Error('Missing retention target');code=code.replace(a,"if (items.length <= 10 || index >= items.length - 6) next.add(item.id)")}
 if(file.endsWith('/components/ActivityView.tsx')&&(!(originalCode.indexOf('function Row(')>=0)||!(originalCode.indexOf('/** A segment')>originalCode.indexOf('function Row('))))throw Error('Empty owning Row/Run source span');
 const log=process.env.AGENTMUX_WORKFLOW_OBSERVATION_LOADED_SOURCE;if(log)appendFileSync(log,JSON.stringify({path:relative(root,file),originalSHA256:createHash('sha256').update(originalCode).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(file.endsWith('/components/ActivityView.tsx')?{ownedSHA256:createHash('sha256').update(originalCode.slice(originalCode.indexOf('function Row('),originalCode.indexOf('/** A segment'))).digest('hex')}:{}),...(code!==originalCode?{mutation}:{})})+'\n')
 if(code!==originalCode)return {code,map:null}
}}],test:{...original.test,include:['apps/desktop/test/conversation-workflow-observation.integration.test.tsx'],passWithNoTests:false,fileParallelism:false}})
