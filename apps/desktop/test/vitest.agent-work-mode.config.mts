import { defineConfig } from 'vitest/config'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import original, { executionUiAliases } from './vitest.tool-execution-ui.config.mts'
import { aliases, installedDependency } from '../scripts/fixtures/settings-resource-library/environment.mjs'
const root = resolve(import.meta.dirname, '../../..'), evidence = process.env.AGENT_WORK_MODE_EVIDENCE, mutant = process.env.AGENT_WORK_MODE_MUTANT
const mutations: Record<string, [string,string,string]> = {
  'composer-route-cache': ['components/AgentSessionComposer.tsx', ", session?.kind === 'agent' ? session.workPlacement?.resourceHostId : undefined]", ']'],
  'file-route-cache': ['lib/session-project-file-context.ts', "session?.kind === 'agent' ? session.toolExecution?.workspacePath : undefined,\n      session?.kind === 'agent' ? session.workPlacement?.resourceHostId : undefined]", "session?.kind === 'agent' ? session.toolExecution?.workspacePath : undefined]"],
  'host-premature-launch': ['components/settings/HostProjectsPane.tsx', 'const tabId = state.openLauncher({ workspaceId: workspace.id, reveal: true })', "void state.launchAgent(startExecutor, '', layout.activeGroupId)\n        const tabId = state.openLauncher({ workspaceId: workspace.id, reveal: true })"],
  'raw-host-alias': ['lib/agent-work-mode.ts', 'source.workPlacement?.resourceHostId ?? null', 'source.toolExecution.resourceHostId'],
  'reverse-same-host': ['lib/agent-work-mode.ts', "return projectHostId === referenceHostId ? 'remote-agent' : 'remote-workspace'", "return 'remote-workspace'"],
  'discard-retained-placement': ['lib/focus-context.ts', '...(source.workPlacement ? { workPlacement: source.workPlacement } : {})', '...{}']
}
if (mutant && !mutations[mutant]) throw new Error('Unknown work mode mutant')
if (evidence) mkdirSync(evidence,{recursive:true})
export default defineConfig({ ...original, resolve:{alias:[...aliases,...executionUiAliases]},
 plugins:[...(original.plugins??[]), {name:'work-mode-source-consumer',enforce:'pre',resolveId:installedDependency,transform(code,id){
  if(!id.startsWith(root+'/')||id.includes('/node_modules/')||id.includes('?'))return
  if(evidence)appendFileSync(resolve(evidence,'consumed.jsonl'),JSON.stringify({file:relative(root,id),sha256:createHash('sha256').update(code).digest('hex')})+'\n')
  if(!mutant)return
  const [suffix,before,after]=mutations[mutant]!
  if(!id.endsWith('/'+suffix))return
  if(code.split(before).length!==2)throw new Error('Mutation anchor must match exactly once: '+mutant)
  if(evidence)appendFileSync(resolve(evidence,'mutation.jsonl'),JSON.stringify({mutant,file:relative(root,id)})+'\n')
  process.stderr.write('WORK_MODE_MUTANT_HIT '+mutant+'\n')
  return{code:code.replace(before,after),map:null}
 }}], test:{...original.test,include:['apps/desktop/test/launcher-tool-execution.test.tsx','apps/desktop/test/host-project-executors.test.tsx','apps/desktop/test/agent-work-mode.test.tsx','apps/desktop/test/session-resource-context.test.tsx','apps/desktop/test/workbench-tab-marks.test.ts','apps/desktop/test/focus-context-cost.test.ts'],passWithNoTests:false,maxWorkers:1,fileParallelism:false},cacheDir:resolve(root,'.tmp/remote-work-modes-tests') })
