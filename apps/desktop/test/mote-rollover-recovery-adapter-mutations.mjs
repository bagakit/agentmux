import { createHash } from 'node:crypto'
export const mutations = {
 'recovery-handoff-removed':['apps/desktop/src/main/runtime-controller.ts','      this.handoffMoteMainRollover(result)\n      const recovery = result.recovery','      const recovery = result.recovery','^actual Main recovery'],
 'recovery-ipc-carrier-removed':['apps/desktop/src/main/session-recovery-operation.ts',"...(reply === 'received' && source?.moteMainRollover ? { moteMainRollover: source.moteMainRollover } : {})",'', '^registered recovery IPC|^the received recovery serializer']
}
const sources = new Set(['apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/session-recovery-operation.ts','apps/desktop/src/shared/session-recovery-result.ts','apps/desktop/src/shared/session-input-result.ts','apps/desktop/src/renderer/src/lib/session-recovery-api.ts','apps/desktop/src/renderer/src/lib/mote-main-rollover.ts'])
export function instrumentAdapter(source, file) {
 if(!sources.has(file))return source
 const name=process.env.MOTE_ADAPTER_MUTATION,entry=name&&mutations[name]
 if(name&&!entry)throw Error('Unknown exact adapter mutation')
 let loaded=source
 if(entry?.[0]===file){if(source.split(entry[1]).length!==2)throw Error('Exact production adapter anchor required: '+name);loaded=source.replace(entry[1],entry[2])}
 if(!process.env.MOTE_ADAPTER_LOADED)return loaded
 const hash=value=>createHash('sha256').update(value).digest('hex'),row=JSON.stringify({file,originalSHA256:hash(source),loadedSHA256:hash(loaded),mutation:loaded===source?null:name})+'\n'
 return "import {appendFileSync as __adapterLoaded} from 'node:fs';\n__adapterLoaded("+JSON.stringify(process.env.MOTE_ADAPTER_LOADED)+','+JSON.stringify(row)+');\n'+loaded
}
