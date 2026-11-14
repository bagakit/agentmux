import {appendFileSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
const root=resolve(import.meta.dirname,'../../..')
const core='packages/core/src/mote-preferences.ts',host='apps/host/src/mote-quick-preferences.ts',ui='apps/desktop/src/renderer/src/lib/mote-quick-mode.ts',binding='packages/core/src/spatial-agent-open-contract.ts'
const coreRole="if (!destination && !sameMoteDefaultConversation(baseline.defaults.conversation, values.conversation)) fail('Changing the original Main requires its exact legitimate destination.', code)"
export const moteSettingsVariants={
 'require-display':[{file:ui,before:'if (!sameMain && !pending && !chosen)',after:'if (!chosen)'}],
 'core-unplaced-role':[{file:core,before:coreRole,after:'/* missing Core role boundary */'}],
 'host-unplaced-role':[{file:core,before:coreRole,after:'/* expose direct Host backstop independently */'},{file:host,before:"if (roleChanged && !input.destination) throw new Error('Changing the original Main requires its exact legitimate destination.')",after:'/* missing authoritative Host role boundary */'}],
 'baseline-marker':[{file:host,before:' || !isDeepStrictEqual(read.defaults.conversationTransition, baseline.defaults.conversationTransition)',after:''}],
 'resource-scope':[{file:ui,before:"if (workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || scratchTopicLogicalPath(scope.workspace, scope.topic) !== scope.rootPath)",after:'if (false)'}],
 'replace-frozen-request':[{file:ui,before:'pending ?? { kind:',after:'{ kind:'}],
 'unplaced-binding':[{file:binding,before:"return destination?.kind === 'occurrence'",after:"return !destination || destination.kind === 'occurrence'"}]
}
export function transformMoteSettingsSource(source,path,loader){
 if(![core,host,ui,binding].includes(path))return source
 let loaded=source
 const mutation=process.env.MOTE_SETTINGS_MUTATION
 if(mutation&&!moteSettingsVariants[mutation])throw Error('Unknown settings mutation')
 for(const selected of moteSettingsVariants[mutation]??[]){if(selected.file!==path)continue;if(loaded.split(selected.before).length!==2)throw Error('One original settings source anchor required: '+mutation);loaded=loaded.replace(selected.before,selected.after)}
 if(process.env.MOTE_SETTINGS_LOADED){const sha=v=>createHash('sha256').update(v).digest('hex');appendFileSync(process.env.MOTE_SETTINGS_LOADED,JSON.stringify({path,loader,sourceSHA256:sha(source),rawSHA256:sha(readFileSync(resolve(root,path))),loadedSHA256:sha(loaded),...(source===loaded?{}:{mutation})})+'\n')}
 return loaded
}
