import {defineConfig} from 'vitest/config'
import original from '../../../../../vitest.config'
import {resolve} from 'node:path'
import {appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({...original,root,esbuild:{jsx:'automatic',jsxImportSource:'react'},cacheDir:resolve(root,'.bagakit/feature-tracker/conversation-pending-interaction-artifacts/cache'),plugins:[...(original.plugins??[]),{name:'pending-interaction-source',enforce:'pre',transform(code,id){
  const file=id.split('?')[0]!;if(!file.startsWith(`${root}/apps/desktop/src/`))return
  const originalCode=code;const mutant=process.env.AGENTMUX_PENDING_INTERACTION_MUTANT
  if(mutant&&file.endsWith('/AgentInteractionCard.tsx')){
    const changes={readonly:["readOnly || disabled || phase !== 'idle'","disabled || phase !== 'idle'"],wrongOption:['onRespond(response)','onRespond(response.kind === \'question\' && response.outcome === \'answered\' ? {...response,answers:[{...response.answers[0]!,optionId:\'option-1\'}]} : response)'],earlyUnlock:["setPhase('awaiting')","submission.current = false; setPhase('idle')"]} as const
    const change=changes[mutant as keyof typeof changes];if(change){if(code.split(change[0]).length!==2)throw new Error(`Mutation anchor not unique: ${mutant}`);code=code.replace(change[0],change[1])}
  }
  if(mutant==='detachConversation'&&file.endsWith('/SessionPane.tsx')){const from="session.kind === 'agent' && session.pendingInteraction ? (";if(code.split(from).length!==2)throw new Error('Mutation anchor not unique');code=code.replace(from,'false ? (')}
  const output=process.env.AGENTMUX_PENDING_INTERACTION_LOADED;if(output)appendFileSync(output,`${JSON.stringify({path:file.slice(root.length+1),originalSHA256:createHash('sha256').update(originalCode).digest('hex'),sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code),...(code!==originalCode?{mutant}:{})})}\n`)
  if(code!==originalCode)return{code,map:null}
}}],test:{...original.test,include:['apps/desktop/test/conversation-pending-interaction.integration.test.tsx'],passWithNoTests:false,fileParallelism:false}})
