import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
const mutations={
 'ignore-choice':['/components/FocusToolbar.tsx','const topicId = choice.focusChatTopicId === undefined ? pmoTeamsTopicFloatingTargetTopicId(choice, state.tabs) : choice.focusChatTopicId','const topicId = pmoTeamsTopicFloatingTargetTopicId(choice, state.tabs)'],
 'drop-durable-choice':['/lib/pmo-teams-topic-floating.ts',', focusChatTopicId: resolved.focusChatTopicId',''],
 'selection-sends':['/components/FocusToolbar.tsx','onSelect={() => setFloating({ focusChatTopicId: mote.id })}','onSelect={() => { setFloating({ focusChatTopicId: mote.id }); void chatAboutTab() }}']
} as const
const key=process.env.AGENTMUX_FOCUS_CHAT_MUTATION as keyof typeof mutations
if(!Object.hasOwn(mutations,key))throw new Error('Select one bounded Chat mutation.')
const [file,from,to]=mutations[key]
export default defineConfig({...original,plugins:[{name:'focus-chat-loaded-mutation',enforce:'pre',transform(code,id){
 if(!id.replaceAll('\\','/').endsWith(file))return
 if(!code.includes(from)||code.indexOf(from)!==code.lastIndexOf(from))throw new Error('Mutation must match one owning expression.')
 const changed=code.replace(from,to),sha=(text:string)=>createHash('sha256').update(text).digest('hex')
 if(!process.env.AGENTMUX_FOCUS_CHAT_MUTATION_LOG)throw new Error('Loaded mutation receipt is required.')
 appendFileSync(process.env.AGENTMUX_FOCUS_CHAT_MUTATION_LOG,JSON.stringify({mutation:key,file,originalSha:sha(code),transformedSha:sha(changed),from,to})+'\n')
 return{code:changed,map:null}
}}]})
