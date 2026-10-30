import { defineConfig } from 'vitest/config'
import original from './a2a-resumed-inbox.config.mts'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const variants = {
  'wrong-role': ['apps/host/src/mote-dialogue.ts', "main.roleRevision !== input.expectedRoleRevision", 'false'],
  'wrong-host': ['apps/host/src/mote-dialogue.ts', 'input.source.messageHostId !== main.current.hostId', 'false'],
  'drop-before-source': ['apps/host/src/mote-dialogue.ts', 'mainSource(before, Date.now()), mainSource(after, Date.now())', 'mainSource(after, Date.now())'],
  'foreign-cursor': ['packages/core/src/mote-dialogue-store.ts', '!sameMoteDialogue(query.cursor.identity, identity) || ', ''],
  'main-input-stale': ['packages/core/src/public-rpc-service.ts', 'main.roleRevision !== expectedRoleRevision', 'false'],
  'main-input-replay': ['packages/core/src/public-rpc-service.ts', 'if (!submit || !firstIntake && !explicitPreparationRetry || (observed.input || observed.record) && !explicitPreparationRetry)', 'if (!submit)'],
  'main-route-missing': ['packages/core/src/agent-global-message-queue.ts', "await this.appendRecord({kind:'mote-main-input-route',sequence:this.nextSequence,route:structuredClone(candidate)})", 'void candidate'],
  'guidance-missing': ['packages/core/src/public-rpc-service.ts', '...(moteGuidance ? {agentMuxNote:MOTE_INPUT_GUIDANCE,authorHuman:true} : {})', '...{}'],
  'guidance-agent-author': ['packages/core/src/public-rpc-service.ts', "if (context.caller !== undefined) throw new AgentMuxError('Managed Agents must use agent.send for cross-Session input;", "if (false) throw new AgentMuxError('Managed Agents must use agent.send for cross-Session input;"],
  'legacy-reclassify': ['packages/core/src/public-rpc-service.ts', 'if (prior.input || prior.record || priorRecovery)', 'if (false)'],
  'route-gap-replay': ['packages/core/src/public-rpc-service.ts', '!firstIntake && !explicitPreparationRetry', 'false'],
  'capture-note-replaced': ['packages/core/src/agent-input-context-capture-resolve.ts', 'JSON.stringify(proof) !== JSON.stringify({ reference: expected.reference, binding: expected.binding, intentDigest: expected.intentDigest })', 'false'],
  'recovery-replay': ['packages/core/src/public-rpc-service.ts', 'if (submit && (firstIntake || recovery?.reconcile === true))', 'if (submit)'],
  'recovery-wrong-carrier': ['packages/core/src/public-rpc-service.ts', 'const key = retained?.launchInput?.key', 'const key = route.key'],
  'recovery-reconcile-missing': ['packages/core/src/public-rpc-service.ts', 'firstIntake || recovery?.reconcile === true', 'firstIntake'],
  'recovery-drop-source-fence': ['packages/core/src/mote-dialogue-contract.ts', "input.admissionIntent?.kind !== 'manual-actor' || input.execution !== 'immediate'", 'false'],
  'record-payload-only': ['packages/core/src/agent-input-wait.ts', 'phases.payload.acknowledged && phases.submit.acknowledged', 'phases.payload.acknowledged'],
  'record-launch-as-native': ['packages/core/src/agent-input-wait.ts', "? 'launch-carried' : 'unknown'", "? 'admitted' : 'unknown'"],
  'capture-result-disconnect': ['packages/core/src/rpc-native-codec.ts', 'const expectedContext = packet ? message?.inputContext : submitted.inputContext', 'const expectedContext = submitted.inputContext'],
  'rpc-disconnect': ['packages/core/src/public-rpc-service.ts', 'await this.ports.moteDialogue.read(parseMoteDialogueParams(method, params), original)', "await (async () => { throw new AgentMuxError('Disconnected original dialogue owner', 'CONTROL_UNAVAILABLE') })()"]
} as const
const name=process.env.MOTE_DIALOGUE_MUTANT as keyof typeof variants | undefined
if(name&&!variants[name])throw Error('Unknown Mote dialogue production mutation')
export default defineConfig({...original,plugins:[{name:'mote-dialogue-owner-proof',enforce:'pre',transform(source,id){
  const path=relative(original.root!,id.split('?')[0]!)
  if(!path.endsWith('.ts') || !path.startsWith('packages/core/src/')&&!path.startsWith('apps/host/src/'))return
  let loaded=source
  const selected=name&&variants[name]
  if(selected&&path===selected[0]){if(source.split(selected[1]).length!==2)throw Error('The selected exact production expression did not load once');loaded=source.replace(selected[1],selected[2])}
  if(process.env.MOTE_DIALOGUE_LOADED){const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),entry=JSON.stringify({path,originalSHA256:hash(source),loadedSHA256:hash(loaded),...(loaded!==source?{mutation:name}:{})})+'\n';loaded="import {appendFileSync as __moteDialogueRuntimeLoaded} from 'node:fs';\n__moteDialogueRuntimeLoaded("+JSON.stringify(process.env.MOTE_DIALOGUE_LOADED)+','+JSON.stringify(entry)+');\n'+loaded}
  if(loaded!==source)return{code:loaded,map:null}
}},...original.plugins!],test:{...original.test,include:['packages/core/test/mote-dialogue.test.ts'],passWithNoTests:false,testTimeout:45_000}})
