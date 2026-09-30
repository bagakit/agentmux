import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
const changes = {
  'local-rows': ['FocusDisconnectedGroup.tsx', '{open ? <WindowOverlayPortal', '{contexts.map(context => <button key={context.id} className="focus-context" data-session-id={context.id}>{context.name}</button>)}{open ? <WindowOverlayPortal'],
  'wrong-lane': ['FocusDisconnectedProjects.tsx', 'node.dataset.laneId === activeReveal.laneId', 'node.dataset.projectId === activeReveal.laneId'],
  'empty-summary': ['FocusDisconnectedGroup.tsx', 'contexts.slice(0, 3)', 'contexts.slice(0, 0)'],
  'healthy-lost': ['GlobalFocusSurface.tsx', " && context.processState !== 'running'", '']
} as const
const key = process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_MUTATION as keyof typeof changes
if (!Object.hasOwn(changes,key)) throw new Error('Explicit actual lane mutation required')
const [file, from, to] = changes[key]
export default defineConfig({...original,plugins:[{name:'focus-lane-adaptive-loaded',enforce:'pre',transform(code,id){
 if(!id.replaceAll('\\\\','/').endsWith('/components/'+file))return
 if(!code.includes(from)||code.indexOf(from)!==code.lastIndexOf(from))throw new Error('One actual source expression required')
 const changed=code.replace(from,to),sha=(s:string)=>createHash('sha256').update(s).digest('hex')
 if(!process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_LOADED_LOG)throw new Error('Exact loaded log required')
 appendFileSync(process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_LOADED_LOG,JSON.stringify({mutation:key,id,sourceSHA256:sha(code),loadedSHA256:sha(changed),from,to})+'\n')
 return {code:changed,map:null}
}}]})
