import { createHash } from 'node:crypto'
export const mutations = {
 entry: ["packages/core/src/public-rpc-service.ts", "read({ kind:'quick', target:input.target, includeChoices:false })", "read({ kind:'quick', target:input.target })", "^Main entry"],
 evaluator: ["packages/core/src/public-rpc-service.ts", "read({kind:'quick',target:main.target,includeChoices:false})", "read({kind:'quick',target:main.target})", "^new Query evaluation"]
}
const sources = new Set(['packages/core/src/public-rpc-service.ts','apps/host/src/mote-quick-preferences.ts','apps/host/src/mote-dialogue.ts','apps/host/test/helpers/mote-conversation-start-fixture.ts'])
export function instrumentProjection(source, file) {
 if(!sources.has(file))return source
 let loaded=source
 const name=process.env.MOTE_PROJECTION_MUTATION,entry=name&&mutations[name]
 if(name&&!entry)throw Error('Unknown exact projection mutation')
 if(entry?.[0]===file){if(source.split(entry[1]).length!==2)throw Error('Exact projection flag anchor required');loaded=source.replace(entry[1],entry[2])}
 if(!process.env.MOTE_PROJECTION_LOADED)return loaded
 const hash=value=>createHash('sha256').update(value).digest('hex'),row=JSON.stringify({file,originalSHA256:hash(source),loadedSHA256:hash(loaded),mutation:loaded===source?null:name})+'\n'
 return "import {appendFileSync as __projectionLoaded} from 'node:fs';\n__projectionLoaded("+JSON.stringify(process.env.MOTE_PROJECTION_LOADED)+','+JSON.stringify(row)+');\n'+loaded
}
