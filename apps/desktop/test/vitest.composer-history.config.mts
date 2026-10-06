import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root=resolve(import.meta.dirname,'../../..')
const mutations={
 'plain-arrow':['packages/client-ui/src/components/AgentComposer.tsx','const plainArrow = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey','const plainArrow = true'],
 'selection':['packages/client-ui/src/components/AgentComposer.tsx','&& plainArrow && selectionEmpty &&','&& plainArrow &&'],
 'multiline':['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',"if (!browsing && direction === 'older'", "if (direction === 'older'"],
 'draft-exit':['apps/desktop/src/renderer/src/store.ts','agentComposerHistoryNavigation: navigation })','agentComposerHistoryNavigation: state.agentComposerHistoryNavigation })'],
 'session-target':['apps/desktop/src/renderer/src/store.ts','recallAgentComposerHistory(sessionId, direction, draft, candidates) {','recallAgentComposerHistory(sessionId, direction, draft, candidates) { sessionId = "agent-2"'],
 'candidate-scope':['packages/client-ui/src/components/AgentComposer.tsx','onKeyDown={(event) => { suggestionKeyDown(event) }}','onKeyDown={() => {}}'],
 'candidate-close':['packages/client-ui/src/components/AgentComposer.tsx','setDismissedSuggestions(value)','setDismissedSuggestions(null)'],
 'fill-undo':['packages/client-ui/src/lib/composer-insertion.ts','closeHistory(editor.state.tr).replaceWith','editor.state.tr.replaceWith'],
 'undo-restore':['packages/client-ui/src/components/InlineComposer.tsx',"props.historyNavigation === 'restored' && origin?.editor === editor","false && origin?.editor === editor"],
 'restore-provenance':['packages/client-ui/src/components/InlineComposer.tsx',"props.historyNavigation === 'restored' && origin?.editor === editor","origin?.editor === editor"],
 'browse-snapshot':['apps/desktop/src/renderer/src/store.ts','const entries = browsing ? navigation.entries! : [...(candidates ?? state.agentComposerHistory[sessionId] ?? [])]','const entries = [...(candidates ?? state.agentComposerHistory[sessionId] ?? [])]'],
 'double-edit':['packages/client-ui/src/components/AgentComposer.tsx',"if (onHistoryRecall(event.key === 'ArrowUp' ? 'older' : 'newer', value, caret) !== null) event.preventDefault()", "const recalled = onHistoryRecall(event.key === 'ArrowUp' ? 'older' : 'newer', value, caret); if (recalled !== null) { event.preventDefault(); onChange(recalled) }"]
} as const

export default defineConfig({root,define:{__AGENTMUX_WEB_PREVIEW__:'true'},resolve:{conditions:['browser']},plugins:[{
 name:'composer-history-actual-source',enforce:'pre',transform(source,id){
  const path=id.split('?')[0]!
  if(!path.startsWith(root+'/apps/desktop/src/')&&!path.startsWith(root+'/packages/client-ui/src/'))return
  let code=source
  const name=process.env.AGENTMUX_COMPOSER_HISTORY_MUTANT as keyof typeof mutations|undefined
  if(name){const change=mutations[name];assert.ok(change,'Known history mutation');if(path===resolve(root,change[0])){assert.equal(source.split(change[1]).length-1,1,'Unique loaded production mutation');code=source.replace(change[1],change[2])}}
  if(process.env.AGENTMUX_COMPOSER_HISTORY_LOADS)appendFileSync(process.env.AGENTMUX_COMPOSER_HISTORY_LOADS,JSON.stringify({path:relative(root,path),sourceSHA:createHash('sha256').update(source).digest('hex'),loadedSHA:createHash('sha256').update(code).digest('hex'),mutation:name??null,transformed:source!==code})+'\n')
  if(code!==source)return{code,map:null}
 }
}],test:{include:['apps/desktop/test/composer-history.test.ts','apps/desktop/test/composer-history-recall.integration.test.tsx','apps/desktop/test/composer-input-ownership.test.tsx'],globalSetup:[resolve(root,'vitest.dist-freshness.ts')],setupFiles:[resolve(root,'vitest.setup.ts')],passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:15000}})
