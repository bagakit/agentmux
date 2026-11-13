import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
export async function exerciseNetwork({one,run,cli,client,base,observe,posts}) {
  await observe('public-cli-native-click-and-fast-http-response',async()=>{
    const result=await cli(['browser','run','--browser',one.id,'--operation-id','network-click'],`const reader=await watchRequests();try{const p=await snapshot();await click(p.nodes.find(n=>n.name==='Submit').ref);let response,error;try{response=await waitForResponse(reader,{url:{contains:'/submit'},method:'POST',status:200},{timeoutMs:1500})}catch(e){error=e.message}return {response,error,traffic:await readRequests(reader),frame:await cdp('Page.getFrameTree')}}finally{await stopWatchingRequests(reader)}`)
    assert.equal(result.outcome.kind,'completed',result.outcome.message)
    assert.equal(result.result.response?.status,200,'The original native HTTP response must be observed: '+JSON.stringify(result.result))
    assert.equal(posts(),1);assert.ok(result.result.traffic.observations.some(row=>row.event==='request'&&row.method==='POST'))
  })
  await observe('xhr-response-buffered-before-wait-and-sibling-reader-survives',async()=>{
    const result=await run(one.id,`const first=await watchRequests();const reader=await watchRequests();await stopWatchingRequests(first);await js("new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('POST','/submit');x.setRequestHeader('X-Private-Proof','private-header-marker');x.onload=()=>resolve(true);x.onerror=reject;x.send('private-body-marker')})");const response=await waitForResponse(reader,{status:200},{timeoutMs:1500});const traffic=await readRequests(reader);await stopWatchingRequests(reader);return {response,traffic}`,'network-xhr')
    assert.equal(result.outcome.kind,'completed',result.outcome.message);assert.equal(result.result.response.status,200);assert.equal(posts(),2)
    assert.ok(!JSON.stringify(result).includes('private-body-marker'));assert.ok(!JSON.stringify(result).includes('private-header-marker'))
    for(const step of result.runOperation.steps.filter(step=>['watchRequests','readRequests','waitForResponse','stopWatchingRequests'].includes(step.method))){assert.deepEqual(step.replay.args,[]);assert.match(step.replay.blockedReason,/original program/)}
  })
  await observe('document-navigation-ends-reader-and-keeps-healthy-next-program',async()=>{
    const result=await run(one.id,`const reader=await watchRequests();await gotoUrl(${JSON.stringify(base+'/form?next')});let rejected=false;try{await readRequests(reader)}catch{rejected=true}await stopWatchingRequests(reader);return rejected`,'network-navigation')
    assert.equal(result.outcome.kind,'completed',result.outcome.message);assert.equal(result.result,true,'A prior document reader must not read a later document')
    const fresh=await run(one.id,'return await pageInfo()','network-after-navigation');assert.equal(fresh.outcome.kind,'completed')
  })
  let expired
  await observe('reader-does-not-survive-program-completion',async()=>{
    const result=await run(one.id,'return await watchRequests()','network-expired');assert.equal(result.outcome.kind,'completed',result.outcome.message);expired=result.result
    const later=await run(one.id,`try{await readRequests(${JSON.stringify(expired)});return false}catch{return true}`,'network-later')
    assert.equal(later.result,true,'A later program must not adopt an old reader')
  })
  await observe('stop-cancels-pending-response-without-repeating-native-action',async()=>{
    const before=posts(),pending=run(one.id,`const reader=await watchRequests();await waitForResponse(reader,{url:{contains:'/never'}},{timeoutMs:20000});const p=await snapshot();await click(p.nodes.find(n=>n.name==='Submit').ref);return true`,'network-stop')
    const deadline=Date.now()+10000;let waiting=false
    while(Date.now()<deadline){const operation=await client.call('browser.inspect',{operationId:'network-stop'});if(operation.runOperation?.steps.some(step=>step.method==='waitForResponse')){waiting=true;break}await delay(20)}
    assert.equal(waiting,true);await client.call('browser.stop',{operationId:'network-stop'});const stopped=await pending;assert.equal(stopped.outcome.kind,'stopped');assert.equal(posts(),before)
    const fresh=await run(one.id,`const reader=await watchRequests();await js("fetch('/submit',{method:'POST'})");const response=await waitForResponse(reader,{status:200},{timeoutMs:1500});await stopWatchingRequests(reader);return response.status`,'network-after-stop');assert.equal(fresh.outcome.kind,'completed',fresh.outcome.message);assert.equal(fresh.result,200)
  })
}
