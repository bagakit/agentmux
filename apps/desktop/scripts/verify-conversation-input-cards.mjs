import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
function artifact(ref,json=true){const b=readFileSync(ref.path);assert.ok(b.length>0,`Empty ${ref.path}`);assert.equal(sha(b),ref.sha256,`Changed ${ref.path}`);return json?JSON.parse(b):b.toString()}
const {parseAgentMuxMessagePrefix}=await import('@agentmux/core/agent-message-render');assert.deepEqual(parseAgentMuxMessagePrefix('[Message from Agent native-source]\nraw body'),{sourceLabel:'Agent native-source',declaredAgentSessionId:'native-source',body:'raw body'});
const option=process.argv.indexOf('--proof');assert.ok(option>=0&&process.argv[option+1]);const q=JSON.parse(readFileSync(process.argv[option+1]));assert.equal(q.task,'T-001')
for(const [path,hash] of Object.entries(q.source))assert.equal(sha(readFileSync(path)),hash,`Source ${path}`)
for(const [name,run] of Object.entries(q.runs)){
 const receipt=artifact(run.receipt),report=artifact(run.report),loaded=artifact(run.loaded,false).trim().split('\n').map(JSON.parse)
 const green=name==='own'||name==='exact-restore';assert.equal(receipt.exitCode,green?0:1);assert.ok(receipt.argv.includes('apps/desktop/scripts/fixtures/conversation-input-cards/vitest.owning.config.mts'))
 const assertions=report.testResults.flatMap(x=>x.assertionResults);assert.equal(assertions.length,6);assert.equal(report.numTotalTests,6);assert.equal(report.success,green)
 if(green)assert.equal(report.numPassedTests,6);else{const failed=assertions.filter(x=>x.status==='failed');assert.ok(failed.length>0);for(const x of failed)assert.ok(x.failureMessages.some(s=>s.includes('AssertionError')),`Setup error ${name}`)}
 assert.ok(loaded.length>0);const owner=loaded.filter(x=>x.path==='apps/desktop/src/renderer/src/components/ConversationMessage.tsx');assert.ok(owner.length>0)
 for(const x of owner){assert.equal(x.originalSHA256,q.source[x.path]);assert.ok(x.bytes>0);if(green)assert.equal(x.sha256,x.originalSHA256);else assert.ok(x.mutation===name&&x.sha256!==x.originalSHA256)}
 for(const path of ['packages/core/src/agent-message-render.ts','apps/desktop/src/renderer/src/components/ConversationMessage.tsx']){assert.equal(receipt.sourceBefore[path],q.source[path]);assert.equal(receipt.sourceAfter[path],q.source[path])}
}
const adjacent=artifact(q.adjacent);assert.equal(adjacent.success,true);assert.equal(adjacent.numTotalTests,27);assert.equal(adjacent.numPassedTests,27)
for(const [kind,ref]of Object.entries(q.types)){const r=artifact(ref);assert.equal(r.exitCode,0);assert.ok(r.argv.includes('--noEmit'));assert.ok(r.argv.includes(kind==='production'?'apps/desktop/tsconfig.json':'apps/desktop/scripts/fixtures/conversation-input-cards/tsconfig.owning.json'));assert.equal(r.sourceBefore['apps/desktop/src/renderer/src/components/ConversationMessage.tsx'],q.source['apps/desktop/src/renderer/src/components/ConversationMessage.tsx'])}
const css=artifact(q.cssScope),actual=artifact(q.actualCss);assert.ok(css.scope.length>0&&css.rules.length>0&&actual.rules.length>0)
const current=readFileSync('apps/desktop/src/renderer/src/styles/activity-conversation.css','utf8'),start=current.indexOf('/* Inputs share'),end=current.indexOf('\n.observation-sample--conversation',start);assert.ok(start>=0&&end>start);assert.equal(current.slice(start,end),css.scope)
const normalize=s=>s.replace(/'/g,'"').replace(/\s+/g,'');for(const selector of css.rules)assert.ok(actual.rules.some(x=>normalize(x.selector)===normalize(selector)),`Unloaded CSS ${selector}`)
artifact(q.compiledCss,false);const inputs=artifact(q.compiledInputs);assert.ok(inputs.length>0)
for(const path of ['packages/core/dist/agent-message-render.js','apps/desktop/src/renderer/src/components/ConversationMessage.tsx'])assert.ok(inputs.some(x=>x.path===path&&x.sha256===q.source[path]&&x.bytes>0))
for(const [path,needle]of [['apps/desktop/src/renderer/src/components/ConversationMessage.tsx','parseAgentMuxMessagePrefix('],['apps/desktop/src/renderer/src/components/ActivityView.tsx','<ConversationMessage'],['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx','<ConversationMessage']])assert.ok(readFileSync(path,'utf8').includes(needle),`No actual caller ${path}`)
const review=artifact(q.visualReview);assert.equal(review.status,'pass');assert.ok(review.independent_of_product_implementation);assert.equal(review.images.length,4)
for(const x of review.images){assert.ok(x.actual_opened_by_reviewer);artifact(x,false)}
for(const [name,ref]of Object.entries(q.geometry)){const d=artifact(ref);assert.equal(d.viewport[0],name.includes('332')?332:1000);assert.ok(d.turns.length>=2);const incoming=d.turns.filter(x=>x.direction==='incoming');assert.ok(incoming.length>0);for(const x of incoming){assert.ok(x.bodyWidth>200);if(name.includes('1000'))assert.ok(x.left-x.parentLeft>200&&x.parentRight-x.right<15)}}
console.log(JSON.stringify({task:'T-001',passed:true,own:6,adjacent:27,mutations:5,actualImages:4,scope:'Source/public records; no installation'}))
