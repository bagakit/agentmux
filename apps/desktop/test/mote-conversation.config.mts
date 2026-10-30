import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'
const root=resolve(import.meta.dirname,'../../..')
const mutations:Record<string,[string,string,string]>={
 'main-role-selection':['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx','main.current.sessionId === session.control.agentSessionId',"main.current.sessionId === 'unselected-original-role'"],
 'frozen-main-role':['apps/desktop/src/renderer/src/store.ts','JSON.stringify(existing.moteMain) === JSON.stringify(options?.moteMain)','true'],
 'presence-interval':['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx','intervalMs: Number(value) * 60000','intervalMs: DEFAULT_MOTE_PRESENCE.intervalMs'],
 'invalid-interval':['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx',"if (!minutes.trim() || !Number.isSafeInteger(Number(minutes)) || Number(minutes) < 1 || !Number.isSafeInteger(Number(minutes) * 60000))",'if (false)'],
 'main-missing-receipt':['apps/desktop/src/main/runtime-controller.ts','if (!result.input) throw new AgentMuxError','if (false) throw new AgentMuxError'],
 'recovery-provenance':['apps/desktop/src/main/ipc.ts','if (request?.moteMain) assertManualPromptSenderTrusted','if (false) assertManualPromptSenderTrusted'],
 'resource-host':['apps/desktop/src/main/mote-dialogue-ipc.ts','input.target.expectedResource.hostId',"'local'"],
 'host-guidance-owner':['apps/desktop/src/renderer/src/store.ts','(!(entry.moteMain && !original.input.inputContextCapture) && receipt.input.agentMuxNote !== entry.agentMuxNote)','receipt.input.agentMuxNote !== entry.agentMuxNote'],
 'resume-unknown-replay':['apps/desktop/src/renderer/src/components/MoteQuickMode.tsx','const result = existing ? await api.schedule.inspect','const result = false ? await api.schedule.inspect'],
 'recovery-body':['apps/desktop/src/renderer/src/store.ts',"!matchesBrowserInputMessage(entry.browserInput, receipt.message) || receipt.message.userContent !== (entry.text.trim() ? entry.text : undefined) ||\n      receipt.input.submissionId !== entry.operationId || receipt.input.prompt !== entry.text ||","!matchesBrowserInputMessage(entry.browserInput, receipt.message) || receipt.input.submissionId !== entry.operationId ||"],
 'retained-reader':['packages/client-ui/src/lib/use-mote-dialogue.ts','if (!value) { value = createProjection','if (true) { value = createProjection']
}
const name=process.env.AGENTMUX_MOTE_CONVERSATION_MUTATION
if(name&&!mutations[name])throw Error('Unknown conversation mutation')
export default defineConfig({ ...base, plugins:[...base.plugins??[],{name:'loaded-mote-conversation-counterexample',enforce:'pre',transform(original,id){
 if(!name)return;const [file,before,after]=mutations[name]!
 if(relative(root,id.split('?')[0]!)!==file)return
 if(original.split(before).length!==2)throw Error('Mutation anchor must name one original production branch: '+name)
 const changed=original.replace(before,after),trace=process.env.AGENTMUX_MOTE_CONVERSATION_TRACE
 if(!trace)throw Error('Production loading receipt is required')
 const sha=(v:string)=>createHash('sha256').update(v).digest('hex')
 appendFileSync(trace,JSON.stringify({name,file,before:sha(original),after:sha(changed)})+'\n');return{code:changed,map:null}
 }}], resolve: { ...base.resolve, alias: [...(base.resolve!.alias as []), ...Object.entries(radixOverlayAliases).map(([find,replacement]) => ({find,replacement}))] }, test: { ...base.test,
 include: ['apps/desktop/test/mote-conversation-consumer.test.tsx','apps/desktop/test/mote-main-ipc.test.ts'], passWithNoTests: false, testTimeout: 20000 } })
