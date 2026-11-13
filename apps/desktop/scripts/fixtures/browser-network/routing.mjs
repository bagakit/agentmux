import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function exerciseRouting({one, run, cli, client: initialClient, base, observe, posts, restartHost}) {
  let client = initialClient
  const rule = [{match: {url: {contains: '/submit'}, method: 'POST'}, action: 'mock', status: 201,
    headers: {'Content-Type': 'application/json'}, body: '{"nativeMock":true}'}]
  const post = `return await js("fetch('/submit',{method:'POST'}).then(r=>r.text())")`
  const succeeded = report => {assert.equal(report.outcome.kind, 'completed', report.outcome.message); return report.result}
  async function waitAt(id, method) {
    const deadline = Date.now()+10000
    while (Date.now()<deadline) {
      const original = await client.call('browser.inspect', {operationId: id})
      if (original.runOperation?.steps.some(step => step.method === method)) return
      await delay(20)
    }
    assert.fail('The original operation must reach '+method)
  }
  await observe('public-cli-native-click-mock-and-configured-versus-acknowledged-hits', async () => {
    const before = posts()
    const result = succeeded(await cli(['browser','run','--browser',one.id,'--operation-id','routing-click'],
      `const configured=await routeRequests(${JSON.stringify(rule)});const reader=await watchRequests();const page=await snapshot();await click(page.nodes.find(n=>n.name==='Submit').ref);const response=await waitForResponse(reader,{url:{contains:'/submit'}},{timeoutMs:2000});await stopWatchingRequests(reader);return {configured,response,withdrawn:await unrouteRequests()}`))
    assert.equal(result.configured.status,'active'); assert.equal(result.configured.hits.matchedRequests,0)
    assert.equal(result.response.status,201,'The original intercepted native HTTP response must be mocked')
    assert.equal(result.withdrawn.status,'withdrawn'); assert.equal(result.withdrawn.hits.matchedRequests,1)
    assert.equal(result.withdrawn.hits.fulfilledRequests,1); assert.equal(result.withdrawn.hits.unconfirmedRequests,0)
    assert.equal(posts(),before,'A native mock must not dispatch the original request to the service')
  })
  await observe('xhr-abort-and-explicit-withdrawal-return-to-original-service', async () => {
    const before=posts()
    const result=succeeded(await run(one.id,`const configured=await routeRequests([{match:{url:${JSON.stringify(base+'/submit')},method:'POST'},action:'abort'}]);const aborted=await js("new Promise(resolve=>{const x=new XMLHttpRequest();x.open('POST','/submit');x.onerror=()=>resolve('blocked');x.onload=()=>resolve('unexpected');x.send('body')})");return {configured,aborted,withdrawn:await unrouteRequests()}`,'routing-xhr'))
    assert.equal(result.aborted,'blocked'); assert.equal(result.withdrawn.hits.abortedRequests,1); assert.equal(posts(),before)
    assert.equal(succeeded(await run(one.id,post,'routing-after-unroute')),'accepted')
    assert.equal(posts(),before+1,'Explicit withdrawal must restore the original service path')
  })
  await observe('native-offline-rules-withdraw-without-changing-navigator-or-another-target', async () => {
    const second=await client.call('browser.create',{operationId:'routing-other-create',url:base+'/form'})
    assert.equal(second.receipt.status,'created')
    const configured=run(one.id,`const baseline=await js('navigator.onLine');const receipt=await setNetworkConditions({offline:true});let blocked=false;try{await js("fetch('/submit',{method:'POST'})")}catch{blocked=true}await wait(1500);const cleared=await clearNetworkConditions();const after=await js("fetch('/submit',{method:'POST'}).then(r=>r.text())");return {receipt,blocked,baseline,online:await js('navigator.onLine'),cleared,after}`,'routing-offline')
    await waitAt('routing-offline','wait')
    const before=posts();assert.equal(succeeded(await run(second.target.id,post,'routing-other-post')),'accepted');assert.equal(posts(),before+1)
    const result=succeeded(await configured)
    assert.equal(result.receipt.status,'active');assert.equal(result.blocked,true,'Native offline transport must reject the original fetch')
    assert.equal(result.online,result.baseline);assert.equal(result.cleared.status,'withdrawn');assert.equal(result.after,'accepted','Cleared native conditions must restore HTTP within the same original program session')
    assert.equal(succeeded(await run(one.id,post,'routing-after-offline')),'accepted','Cleared native conditions must restore the original HTTP path')
  })
  await observe('native-latency-applies-to-real-http-and-clears-on-the-same-session', async () => {
    const result=succeeded(await run(one.id,`const receipt=await setNetworkConditions({latencyMs:200,downloadBytesPerSecond:65536,uploadBytesPerSecond:-1});const elapsed=await js("(async()=>{const start=performance.now();await fetch('/submit',{method:'POST'});return performance.now()-start})()");return {receipt,elapsed,cleared:await clearNetworkConditions()}`,'routing-latency'))
    assert.equal(result.receipt.status,'active');assert.ok(result.elapsed>=140,'The real HTTP response must incur the configured native latency: '+result.elapsed)
    assert.equal(result.cleared.status,'withdrawn')
  })
  await observe('navigation-withdraws-old-document-rules-and-preserves-next-document', async () => {
    const result=succeeded(await run(one.id,`await routeRequests(${JSON.stringify(rule)});await gotoUrl(${JSON.stringify(base+'/form?after-rule')});${post}`,'routing-navigation'))
    assert.equal(result,'accepted','A later document must not inherit the old mock')
  })
  await observe('stop-awaits-original-rule-and-condition-cleanup-before-next-operation', async () => {
    const pending=run(one.id,`await routeRequests(${JSON.stringify(rule)});await setNetworkConditions({offline:true});await wait(20000);throw Error('No late action after Stop')`,'routing-stop')
    await waitAt('routing-stop','wait');await client.call('browser.stop',{operationId:'routing-stop'})
    const stopped=await pending;assert.equal(stopped.outcome.kind,'stopped')
    assert.equal(succeeded(await run(one.id,post,'routing-after-stop')),'accepted','Stop must leave no original mock or offline rule')
  })
  await observe('normal-program-completion-awaits-withdrawal-without-a-global-rule-store', async () => {
    const result=succeeded(await run(one.id,`return {route:await routeRequests(${JSON.stringify(rule)}),conditions:await setNetworkConditions({offline:true})}`,'routing-complete'))
    assert.equal(result.route.status,'active');assert.equal(result.conditions.status,'active')
    assert.equal(succeeded(await run(one.id,post,'routing-after-complete')),'accepted')
  })
  await observe('real-host-crash-reconnects-same-browser-with-no-replayed-or-retained-rules', async () => {
    succeeded(await run(one.id,`const page=await snapshot();await fillInput(page.nodes.find(n=>n.ref&&n.name==='Draft').ref,'original crash draft');return true`,'routing-crash-draft'))
    const pending=run(one.id,`await routeRequests(${JSON.stringify(rule)});await setNetworkConditions({offline:true});await wait(20000);throw Error('No crash replay')`,'routing-crash').catch(error=>({transportError:String(error)}))
    await waitAt('routing-crash','wait');client=await restartHost();await pending
    const original=await client.call('browser.inspect',{operationId:'routing-crash'});assert.equal(original.runOperation.phase,'indeterminate')
    const fresh=succeeded(await run(one.id,`return {draft:await js("document.querySelector('input').value"),text:await js("fetch('/submit',{method:'POST'}).then(r=>r.text())")}`,'routing-after-crash'))
    assert.equal(fresh.draft,'original crash draft');assert.equal(fresh.text,'accepted','Ended native client rules must not survive the real Host process crash')
    const saved=JSON.stringify(await client.call('browser.inspect',{operationId:'routing-click'}))
    assert.ok(!saved.includes('nativeMock'),'Static mock bodies must not enter the retained operation journal')
  })
}
