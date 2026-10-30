import { defineConfig } from 'vitest/config'
import original from './a2a-resumed-inbox.config.mts'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const variants={
 'entry-stale-role':['packages/core/src/public-rpc-service.ts','main.roleRevision !== input.expectedRoleRevision || !isDeepStrictEqual(main.current, input.reference)','!isDeepStrictEqual(main.current, input.reference)'],
 'entry-full-reference':['packages/core/src/public-rpc-service.ts','|| !isDeepStrictEqual(main.current, input.reference)', ''],
 'entry-unknown-replay':['packages/core/src/public-rpc-service.ts','const unresolved = original.continuity','const unresolved = undefined'],
 'entry-source-drop':['packages/core/src/agent-session-recovery/continuity-attempt.ts',"trigger: input.trigger ?? 'manual',\n    ...(input.moteMainEntry ? { moteMainEntry: structuredClone(input.moteMainEntry) } : {}),","trigger: input.trigger ?? 'manual',"],
 'entry-ignore-pause':['packages/core/src/public-rpc-service.ts','prefs.defaults?.presence?.enabled === false','false'],
 'entry-wrong-host':['packages/core/src/public-rpc-service.ts','scope.hostId === input.reference.hostId','scope.hostId === input.target.expectedResource.hostId'],
 'entry-inspect-writes':['packages/core/src/public-rpc-service.ts',"if (method === 'space.mote.dialogue.recovery.inspect') return { operation: prior ?? null }",'if (false) return { operation: prior ?? null }'],
 'entry-agent-author':['packages/core/src/public-rpc-service.ts',"if (caller) throw new AgentMuxError('Opening a Mote main dialogue requires", "if (false) throw new AgentMuxError('Opening a Mote main dialogue requires"]
} as const
const name=process.env.MOTE_ENTRY_MUTATION as keyof typeof variants|undefined
if(name&&!variants[name])throw Error('Unknown exact Core entry mutation')
export default defineConfig({...original,plugins:[{name:'mote-main-entry-owner-proof',enforce:'pre',transform(source,id){
 const path=relative(original.root!,id.split('?')[0]!);if(!path.endsWith('.ts')||!path.startsWith('packages/core/src/')&&!path.startsWith('apps/host/src/'))return
 let loaded=source;const selected=name&&variants[name]
 if(selected&&path===selected[0]){if(source.split(selected[1]).length!==2)throw Error('Exact entry source mutation missing or nonunique');loaded=source.replace(selected[1],selected[2])}
 if(process.env.MOTE_ENTRY_LOADED){const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),entry=JSON.stringify({path,originalSHA256:hash(source),loadedSHA256:hash(loaded),...(loaded!==source?{mutation:name}:{})})+'\n';loaded="import {appendFileSync as __entryLoaded} from 'node:fs';\n__entryLoaded("+JSON.stringify(process.env.MOTE_ENTRY_LOADED)+','+JSON.stringify(entry)+');\n'+loaded}
 if(loaded!==source)return{code:loaded,map:null}
}},...(original.plugins??[])],test:{...original.test,include:['packages/core/test/mote-dialogue.test.ts'],testNamePattern:'explicit main entry',testTimeout:45000}})
