import { it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { nativeHistoryFixture, jsonl } from '../../../../../packages/core/test/fixtures/native-history-session'
it('exports a genuine public Claude/FileStore page for the compiled reading scene', async () => {
 const records = [
  {sessionId:'native-main',uuid:'scene-input',type:'user',message:{role:'user',content:'Make the answer clear; preserve the original message and reading state.'}},
  {sessionId:'native-main',uuid:'scene-reasoning',type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'Compare the actual records first.\n\n**Keep the original message** and use the shared reading components.\n\n- Preserve selection and the unsent draft.\n- Read tool payloads only when requested.'}]}},
  {sessionId:'native-main',uuid:'scene-mixed',type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'The observed page already contains this thought. Show a quiet summary, then the recorded text on demand.'},{type:'text',text:'### A clear answer\n\nThe answer stays in the main conversation. Recorded thinking and tool details can be opened separately.'},{type:'tool_use',id:'scene-read',name:'Read',input:{file:'src/conversation.tsx'}},{type:'thinking',thinking:'Check the narrow reading surface, keyboard navigation and copying the exact original text.'}]}}
 ]
 const fixture = await nativeHistoryFixture('claude',jsonl(records))
 try {
  const page = await fixture.client.sessionHistoryPage(fixture.session.agentSessionId,{limit:30})
  expect(page.items.map(x=>[x.id,x.contentParts.map(p=>p.kind)])).toEqual([['scene-input',['text']],['scene-reasoning',['reasoning']],['scene-mixed',['reasoning','text','tool-call','reasoning']]])
  expect(fixture.controls.map(x=>x.mock.calls.length)).toEqual([0,0,0,0,0,0])
  writeFileSync('.bagakit/feature-tracker/conversation-input-cards-artifacts/T004/public-reader-page.json',JSON.stringify(page,null,2)+'\n')
 } finally { await fixture.close() }
})
