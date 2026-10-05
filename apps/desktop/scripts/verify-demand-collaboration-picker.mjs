import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../../..'), evidence = path.join(root, '.tmp/demand-picker', String(globalThis.crypto.randomUUID()))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const base = 'apps/desktop/src/renderer/src/'
const files = ['components/GoalAgentPicker.tsx','components/GoalDetail.tsx','components/GoalProperties.tsx','components/GoalExecution.tsx','lib/goal-agent-selection.ts','styles/goals.css'].map(file => base+file)
files.push(base+'components/GlobalBoardSurface.tsx',base+'styles/goal-agent-picker.css',base+'styles/index.css',base+'components/SelectionField.tsx',base+'styles/selection-field.css','apps/desktop/test/helpers/injected-context-core.ts','apps/desktop/scripts/fixtures/demand-picker/vitest.config.mts','apps/desktop/scripts/verify-demand-collaboration-picker.mjs')
async function hashes() {
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await fs.readFile(path.join(root,file)))])))
  const tests = await fs.readFile(path.join(root,'apps/desktop/test/mote-daily-goal.test.tsx'),'utf8')
  hashes['actual-owning-picker-cases'] = digest(tests.slice(tests.indexOf('// T003: actual Goal detail/picker')))
  const store = await fs.readFile(path.join(root,base+'store.ts'),'utf8')
  hashes['actual-store-picker-intent'] = digest(store.slice(store.indexOf('export async function retainGoalAgentSelectionDraft'),store.indexOf('function agentDisplayOverride')) + store.split('\n').filter(line => /goalAgent(Creation|Selection)Drafts/.test(line)).join('\n'))
  return hashes
}
const mutations = [
 {id:'hidden-assignee-directory',file:base+'components/GlobalBoardSurface.tsx',before:"if (!filtersOpen && assigneeFilter === 'all') return [] as string[]",after:''},
 {id:'accurate-canonical-id',file:files[4],before:'const id = session.control.agentSessionId',after:'const id = session.id'},
 {id:'participation-priority',file:files[4],before:'(row.related || row.participated) && row.selectable ? 0',after:'row.related && row.selectable ? 0'},
 {id:'original-cas-consumer',file:files[1],before:'await updateDemand(demand.id, patch, undefined, expectedUpdatedAt)',after:'await updateDemand(demand.id, patch)'},
 {id:'slow-create-busy',file:files[0],before:"if (draft?.phase === 'may-have-dispatched' && creating.current !== draft.operationId) void inspectOriginal(draft)",after:"if (draft?.phase === 'may-have-dispatched') void inspectOriginal(draft)"},
 {id:'retained-selection-remount',file:files[0],before:'useAppStore.getState().goalAgentSelectionDrafts[goalCreationDraftKey(demand.id, role)] ??',after:'undefined ??'},
 {id:'unknown-inspect-only',file:files[0],before:"{ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `goal-agent-inspect-${crypto.randomUUID()}`, operation: 'space.inspect', target: { requestId: original.operationId } }",after:'original.request'},
 {id:'not-dispatched-first-recovery',file:files[0],before:"if (draft.phase === 'not-dispatched') void dispatchOriginal(draft); else void inspectOriginal(draft)",after:'void inspectOriginal(draft)'},
 {id:'mote-original-directory',file:files[0],before:"...(mode === 'agent' ? { executionWorkspaceId: workspace!.id } : {})",after:"...{ executionWorkspaceId: workspaceId || '__scratch__' }"}
]
await fs.mkdir(evidence,{recursive:true})
const receipt={schema:'agentmux.demand-picker.proof.v1',passed:false,candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),source:await hashes(),mutations:[],boundary:'Actual Source GoalDetail and picker -> Store -> original preload/Main -> durable Domain/Core creation and original operation inspection. Private controlled Native I/O and Electron IPC only; no installed App or user Run. Visual and real Native process proof are separate.'}
async function run(name,mutant) {
 const loaded=path.join(evidence,name+'.loaded.ndjson'),log=path.join(evidence,name+'.log')
 const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','apps/desktop/scripts/fixtures/demand-picker/vitest.config.mts','-t','Demand picker:'],{cwd:root,env:{...process.env,AGENTMUX_DAILY_GOAL_PROOF:loaded,...(mutant?{AGENTMUX_DAILY_GOAL_MUTANT:JSON.stringify(mutant)}:{})},stdio:['ignore','pipe','pipe']})
 let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes)
 const timer=setTimeout(()=>child.kill('SIGTERM'),60_000),[exitCode,signal]=await once(child,'exit');clearTimeout(timer)
 await fs.writeFile(log,output)
 const rows=(await fs.readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.ok(rows.length,'Nonempty loaded product graph')
 return {exitCode,signal,assertionRed:/AssertionError|expected .* to/.test(output),testsPassed:Number(/Tests\s+(\d+) passed/.exec(output)?.[1]??0),log:path.relative(root,log),loaded:path.relative(root,loaded),rows}
}
try {
 const baseline=await run('baseline');receipt.baseline={...baseline};delete receipt.baseline.rows
 assert.equal(baseline.exitCode,0);assert.equal(baseline.signal,null);assert.ok(baseline.testsPassed>=5)
 for(const file of [...files.slice(0,5),base+'store.ts','apps/desktop/src/preload/index.ts','apps/desktop/src/main/ipc.ts','packages/core/src/client.ts','packages/demand/src/demand-store.ts']) assert.ok(baseline.rows.some(row=>row.file===file),'Actual loaded consumer '+file)
 for(const mutant of mutations) {
  assert.equal((await fs.readFile(path.join(root,mutant.file),'utf8')).split(mutant.before).length,2,'One anchor '+mutant.id)
  const result=await run(mutant.id,mutant);receipt.mutations.push({id:mutant.id,...result});delete receipt.mutations.at(-1).rows
  assert.notEqual(result.exitCode,0);assert.equal(result.signal,null);assert.equal(result.assertionRed,true,mutant.id+' actual assertion must be RED')
  assert.ok(result.rows.some(row=>row.file===mutant.file && row.consumer==='actual-loaded-mutant' && row.beforeSha256!==row.afterSha256))
  console.log(mutant.id+': actual assertion RED')
 }
 const final=await run('final-current');receipt.final={...final};delete receipt.final.rows;assert.equal(final.exitCode,0);assert.equal(final.signal,null);assert.ok(final.testsPassed>=5)
 assert.deepEqual(await hashes(),receipt.source,'Owning source changed during proof');receipt.passed=true
}catch(error){receipt.error={message:error.message,stack:error.stack}}
await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
console.log(JSON.stringify({passed:receipt.passed,evidence:path.relative(root,path.join(evidence,'receipt.json')),mutations:receipt.mutations.length}))
assert.equal(receipt.passed,true,receipt.error?.message)
