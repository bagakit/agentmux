import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const changes = {
 'allow-custom-svg': ['apps/desktop/src/main/config-store.ts', '    reactionIcon: z.enum(PROMPT_REACTION_ICONS).optional()', '    reactionIcon: z.string().optional()'],
 'keyword-as-id': ['apps/desktop/src/main/settings-resources-control.ts','candidate.value.keyword === request.keyword','candidate.id === request.keyword'],
 'unchecked-result': ['packages/core/src/rpc-business-codec.ts', '(item.value as Record<string, unknown>).keyword !== request.keyword', 'false'],
 'reinterpret-body': ['packages/core/dist/prompt-reaction.js','a.body === b.body', 'true'],
 'block-disconnected': ['apps/desktop/src/renderer/src/lib/conversation-reactions.tsx', "original.processState !== 'running'", "original.processState !== 'running' || original.status.state === 'disconnected'"],
 'unfence-unavailable': ['apps/desktop/src/renderer/src/store.ts', "(session.status.state !== 'disconnected' || options?.reaction !== undefined)", "session.status.state !== 'disconnected'"],
 'replace-run': ['apps/desktop/src/renderer/src/lib/conversation-reactions.tsx','current.control.run.runId !== original.control.run.runId', 'false'],
 'skip-permission-gate': ['apps/desktop/src/renderer/src/lib/agent-steer-queue-drain.ts', '&& !session.pendingInteraction',''],
 'drop-marker': ['packages/core/dist/prompt-reaction.js','`<amux:reaction ${definition.keyword} />`',"'User feedback'"],
 'drop-reference': ['packages/core/dist/prompt-reaction.js','JSON.stringify(source)',"JSON.stringify({kind:source.kind,agentSessionId:source.agentSessionId,recordId:source.recordId})"],
 'hide-progress-actions': ['packages/client-ui/src/components/ConversationView.tsx',"renderMessageActions && item.kind === 'assistant-message'", "renderMessageActions && item.kind === 'assistant-message' && item.messagePhase !== 'progress'"],
 'hide-resource-actions': ['packages/client-ui/src/components/ConversationView.tsx',"renderMessageActions && item.kind === 'assistant-message'", "renderMessageActions && item.kind === 'assistant-message' && item.contentParts.some(part => part.kind === 'text' && part.text.trim())"],
 'primary-only-actions': ['apps/desktop/src/renderer/src/components/SessionPane.tsx',"useConversationReactions(sessionId, observationVisible && !readOnly", "useConversationReactions(sessionId, visible && !readOnly"],
 'complete-captured-actions': ['apps/desktop/src/renderer/src/components/ActivityView.tsx',"entry.item.source !== 'user'\n", "entry.item.source !== 'user' && entry.item.status === 'complete'\n"],
 'human-as-assistant-actions': ['apps/desktop/src/renderer/src/components/ActivityView.tsx',"entry.item.authorHuman !== true && entry.item.authorExternal === undefined && ", ""],
 'forget-reply-identity': ['apps/desktop/src/renderer/src/store.ts','reaction: structuredClone(options.reaction)','reaction: { code: options.reaction.code, replySource: {kind: \'captured\', agentSessionId: sessionId, recordId: \'wrong\'} }'],
 'auto-repeat': ['apps/desktop/src/renderer/src/store.ts','if (!explicitAttempt && entry.promptCondition !== null)', 'if (false)']
} as const
export default defineConfig({root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: {conditions:['browser','import','default']},
 esbuild:{jsx:'automatic'},ssr:{noExternal:['@agentmux/client-ui']},
 plugins:[{name:'actual-reaction-source',enforce:'pre',transform(source,id){
  const path=id.split('?')[0]!
  if(!path.startsWith(root+'/apps/desktop/src/')&&!path.startsWith(root+'/packages/'))return
  let code=source
  const name=process.env.AGENTMUX_REACTION_MUTATION as keyof typeof changes|undefined
  if(name){const change=changes[name];assert.ok(change,'Known reaction mutation');if(path===resolve(root,change[0])){
   assert.equal(source.split(change[1]).length-1,1,'Unique actual loaded mutation');code=source.replace(change[1],change[2])
  }}
  if(process.env.AGENTMUX_REACTION_LOADED)appendFileSync(process.env.AGENTMUX_REACTION_LOADED,JSON.stringify({path:relative(root,path),sourceSHA:createHash('sha256').update(source).digest('hex'),loadedSHA:createHash('sha256').update(code).digest('hex'),transformed:source!==code,mutation:name})+'\n')
  if(code!==source)return{code,map:null}
 }}],
 test:{include:process.env.AGENTMUX_REACTION_ADJACENT?['apps/desktop/test/settings-prompts-save.test.tsx','apps/desktop/test/composer-shortcut-library.test.ts','apps/desktop/test/prompt-uncertain-turn-continuation.test.tsx']:['apps/desktop/test/conversation-reactions.test.tsx','apps/desktop/test/conversation-reaction-ipc.test.tsx','apps/desktop/test/session-pane-reactions.integration.test.tsx'],server:{deps:{inline:['@agentmux/client-ui']}},environment:'happy-dom',passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:15000}})
