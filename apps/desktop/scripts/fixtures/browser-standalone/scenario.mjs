import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export async function standaloneScenario({ repo, bundle, work, executablePath, receipt, persist, holdOnly = false, endpointRecovery = false, markerBundle, failureBundle, exercise }) {
  const require = createRequire(join(repo, 'apps/desktop/package.json'))
  const { connectAgentMuxRpc } = await import('@agentmux/core')
  const { WebSocketServer } = require('ws')
  const puppeteer = createRequire(join(repo, 'packages/browser/package.json'))('puppeteer-core').default
  const socketPath = join(work, 'host.sock'), directory = join(work, 'state')
  let posts = 0, child, client, engineEndpoint
  const waitedRequests = []
  const http = createServer((req, res) => {
    if (req.method === 'POST') { posts++; res.end('accepted'); return }
    if (req.url?.startsWith('/network-wait/')) {
      waitedRequests.push(req.url)
      if (req.url === '/network-wait/start' || req.url === '/network-wait/redirect') {
        res.writeHead(302, { Location: req.url === '/network-wait/start' ? '/network-wait/redirect' : '/network-wait/final' })
        res.end()
      } else if (req.url === '/network-wait/final') {
        setTimeout(() => res.end('original final response'), 650)
      } else {
        const response = setTimeout(() => res.end('slow response'), 3_000)
        res.once('close', () => clearTimeout(response))
      }
      return
    }
    const push = req.url === '/push'
    res.setHeader('content-type', 'text/html')
    res.end(`<title>${push ? 'Push fixture' : 'Form fixture'}</title><label>Draft<input aria-label="Draft"></label><button aria-label="Submit">Submit</button><div id="count">0</div><div id="push">pending</div><script>
      window.trustedTouchStarts=0;document.addEventListener('touchstart',event=>{if(event.isTrusted)window.trustedTouchStarts++});let count=0;document.querySelector('button').onclick=()=>{count++;document.querySelector('#count').textContent=count;fetch('/submit',{method:'POST'})};
      ${push ? `new WebSocket('ws://'+location.host).onmessage=e=>document.querySelector('#push').textContent=e.data;` : ''}
    </script>`)
  })
  const ws = new WebSocketServer({ server: http }); ws.on('connection', socket => socket.send('native-websocket-message'))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const base = `http://127.0.0.1:${http.address().port}`
  const observe = async (label, action) => { receipt.current = label; await persist(); const value = await action(); receipt.cases.push({ label, passed: true }); await persist(); return value }
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_'))),
    AGENTMUX_RUNTIME_DIRECTORY:join(work,'runtime'),AGENTMUX_STATE_DIRECTORY:join(work,'core-state'),AGENTMUX_AGENT_SESSION_STORE:join(work,'sessions.json'),AGENTMUX_MESSAGE_QUEUE_PATH:join(work,'messages.json'),AGENTMUX_RPC_ENDPOINT:'unix:'+socketPath }
  const cli = (args,stdin='') => new Promise((resolve,reject)=>{const processHandle=spawn(process.execPath,[join(repo,'packages/core/bin/amux'),...args],{cwd:repo,env:environment,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';processHandle.stdout.on('data',data=>stdout+=data);processHandle.stderr.on('data',data=>stderr+=data);processHandle.once('error',reject);processHandle.once('close',code=>{try{assert.equal(code,0,stderr);const envelope=JSON.parse(stdout);assert.equal(envelope.ok,true,stdout);resolve(envelope.result)}catch(error){reject(error)}});processHandle.stdin.end(stdin)})
  async function start(selectedBundle=bundle) {
    child = spawn(process.execPath, [selectedBundle, '--directory', directory, '--socket', socketPath, '--executable', executablePath], { cwd: repo, env: environment, stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; receipt.hostStdout = stdout }); child.stderr.on('data', data => { stderr += data; receipt.hostStderr = stderr })
    receipt.hostPid = child.pid; await persist()
    const deadline = Date.now() + 45_000
    while (!stdout.includes('"ready":true')) { if (child.exitCode !== null) throw new Error(`Host exited before readiness: ${stderr}`); if (Date.now() > deadline) throw new Error(`Host startup was not observed: ${stderr}`); await delay(25) }
    client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const run = (browserId, code, operationId) => client.call('browser.run', { browserId, code, ...(operationId ? { operationId } : {}) })
  const state = id => run(id, 'return await js('+JSON.stringify('({draft:document.querySelector("input").value,count:Number(document.querySelector("#count").textContent),push:document.querySelector("#push").textContent,url:location.href})')+')')
  try {
    if(endpointRecovery) {
      await start(markerBundle)
      const pending=client.call('browser.create',{operationId:'before-endpoint-ack',url:base+'/form'}).catch(error=>({error:String(error)}))
      await observe('crash-after-native-endpoint-before-retention',async()=>{
        const deadline=Date.now()+45_000
        while(!receipt.hostStdout?.includes('native-endpoint-not-retained')){if(child.exitCode!==null)throw new Error(receipt.hostStderr);if(Date.now()>deadline)throw new Error('Original pre-retention checkpoint was not observed');await delay(20)}
        const saved=JSON.parse(await readFile(join(directory,'browser-targets.json'),'utf8'))
        assert.equal(saved.engine.endpoint,undefined);assert.equal(saved.targets.length,1);assert.equal(saved.targets[0].targetId,null)
        const [port,path]=(await readFile(join(directory,'engine-profile','DevToolsActivePort'),'utf8')).trim().split('\n');engineEndpoint=`ws://127.0.0.1:${port}${path}`
        receipt.beforeRetention={browserId:saved.targets[0].id,endpoint:engineEndpoint,targetId:null}
        child.kill('SIGKILL');await once(child,'exit');await pending;await client.dispose()
      })
      await start(bundle)
      const original=receipt.beforeRetention.browserId
      await observe('reobserve-original-engine-without-spawn-or-url-adoption',async()=>{
        const saved=JSON.parse(await readFile(join(directory,'browser-targets.json'),'utf8'))
        assert.equal(saved.engine.endpoint,engineEndpoint)
        const target=(await client.call('browser.targets',{})).targets.find(target=>target.id===original)
        assert.equal(target.status,'unavailable');assert.equal(target.navigationId,undefined);assert.deepEqual(target.capabilities,[])
        assert.equal(saved.targets.find(target=>target.id===original).targetId,null,'A lost target acknowledgement must not select the bootstrap page by URL')
        const operation=await client.call('browser.inspect',{operationId:'before-endpoint-ack'});assert.equal(operation.runOperation.phase,'indeterminate')
        const native=await puppeteer.connect({browserWSEndpoint:engineEndpoint,protocolTimeout:15000,defaultViewport:null})
        const before=native.targets().filter(target=>target.type()==='page').length
        await assert.rejects(client.call('browser.create',{operationId:'before-endpoint-ack',url:base+'/form'}),/already|retained|rerun/i)
        assert.equal(native.targets().filter(target=>target.type()==='page').length,before,'Original unknown create must not launch a second page')
        await native.disconnect()
      })
      const first=await client.call('browser.create',{operationId:'new-independent-create',url:base+'/form'})
      assert.equal(first.receipt.status,'created',first.receipt.message)
      const id=first.target.id
      await run(id,`const page=await snapshot();await fillInput(page.nodes.find(n=>n.ref&&n.name==='Draft').ref,'marker preserved input');return true`)
      await observe('known-target-reconnects-from-original-endpoint-file-with-unsaved-input',async()=>{
        const before=JSON.parse(await readFile(join(directory,'browser-targets.json'),'utf8'))
        child.kill('SIGKILL');await once(child,'exit');await client.dispose();delete before.engine.endpoint;await writeFile(join(directory,'browser-targets.json'),JSON.stringify(before)+'\n');await start(bundle)
        const after=JSON.parse(await readFile(join(directory,'browser-targets.json'),'utf8'))
        assert.equal(after.engine.endpoint,engineEndpoint);assert.equal(after.targets.find(target=>target.id===id).targetId,before.targets.find(target=>target.id===id).targetId)
        assert.equal((await state(id)).result.draft,'marker preserved input')
        assert.equal(after.targets.find(target=>target.id===original).targetId,null)
      })
      const other=await client.call('browser.create',{operationId:'other-healthy-page',url:base+'/form'});assert.equal(other.receipt.status,'created')
      await run(other.target.id,`const page=await snapshot();await fillInput(page.nodes.find(n=>n.ref&&n.name==='Draft').ref,'other healthy input');return true`)
      child.kill('SIGTERM');await once(child,'exit');await client.dispose();await start(failureBundle)
      await observe('native-close-with-lost-receipt-reports-unknown-and-keeps-other-page',async()=>{
        const target=(await client.call('browser.targets',{})).targets.find(target=>target.id===id)
        const closed=await client.call('browser.close',{operationId:'close-receipt-unconfirmed',browserId:id,navigationId:target.navigationId})
        assert.equal(closed.receipt.status,'unknown');assert.match(closed.receipt.message,/durable receipt is unconfirmed/)
        assert.equal((await client.call('browser.targets',{})).targets.find(target=>target.id===id).status,'closed','Actual original native close fact must remain observable')
        assert.equal((await state(other.target.id)).result.draft,'other healthy input')
        await assert.rejects(client.call('browser.close',{operationId:'close-receipt-unconfirmed',browserId:id,navigationId:target.navigationId}),/already|retained|rerun/i)
      })
      child.kill('SIGTERM');await once(child,'exit');await client.dispose();await start(bundle)
      await observe('unconfirmed-close-is-not-replayed-after-real-host-restart',async()=>{
        const operation=await client.call('browser.inspect',{operationId:'close-receipt-unconfirmed'});assert.equal(operation.runOperation.phase,'indeterminate')
        assert.equal((await client.call('browser.targets',{})).targets.find(target=>target.id===id).status,'closed')
        assert.equal((await state(other.target.id)).result.draft,'other healthy input')
        assert.equal(JSON.parse(await readFile(join(directory,'browser-targets.json'),'utf8')).engine.endpoint,engineEndpoint)
      })
      receipt.passed=true;return
    }
    await start()
    const one = await observe('public-create-original-receipt', async () => {
      const result = await client.call('browser.create', { operationId: 'standalone-create-one', url: base+'/form' })
      assert.equal(result.receipt.status, 'created', result.receipt.message); assert.equal(result.target.source, 'standalone'); assert.equal(result.target.workspaceId, null)
      assert.ok(!result.target.capabilities.some(name => ['download','uploadFiles','readDownload'].includes(name)), 'No Workspace means no advertised file grant')
      return result.target
    })
    engineEndpoint = JSON.parse(await readFile(join(directory, 'browser-targets.json'), 'utf8')).engine.endpoint
    if (exercise) { await exercise({one, run, cli, client, base, observe, posts: () => posts, restartHost: async () => {
      const originalPid = child.pid, before = JSON.parse(await readFile(join(directory, 'browser-targets.json'), 'utf8'))
      child.kill('SIGKILL'); await once(child, 'exit'); await client.dispose(); await start()
      const after = JSON.parse(await readFile(join(directory, 'browser-targets.json'), 'utf8'))
      assert.equal(after.engine.endpoint, before.engine.endpoint)
      assert.equal(after.targets.find(target => target.id === one.id).targetId, before.targets.find(target => target.id === one.id).targetId)
      receipt.hostRestarts = [...(receipt.hostRestarts ?? []), {originalPid, exitConfirmed: true, signal: 'SIGKILL', replacementHostPid: child.pid, sameEngineEndpoint: true, sameNativeTarget: true}]
      await persist(); return client
    }}); receipt.passed=true;return }
    if(holdOnly) {
      await observe('original-runner-budget-refuses-overflow-hold-before-native-contact',async()=>{
        const held=await run(one.id,`const page=await snapshot();try{await longPress(page.nodes.find(n=>n.ref&&n.name==='Draft').ref,{durationMs:2147483648});return 'completed'}catch(error){return error.message}`)
        assert.equal(held.outcome.kind,'completed',held.outcome.message);assert.match(held.result,/remaining execution time/)
        const native=await run(one.id,'return await js("window.trustedTouchStarts")');assert.equal(native.result,0,'Oversized hold must send no original native contact')
      })
      await observe('ordinary-native-hold-keeps-original-page-capability',async()=>{
        const held=await run(one.id,`const page=await snapshot();await longPress(page.nodes.find(n=>n.ref&&n.name==='Draft').ref,{durationMs:30});return await js('window.trustedTouchStarts')`)
        assert.equal(held.outcome.kind,'completed',held.outcome.message);assert.equal(held.result,1,'A normal hold must still reach the original native page as trusted input')
      })
      receipt.passed=true;return
    }
    const two = await observe('independent-target-create', async () => {
      const result = await cli(['browser','create','--operation-id','standalone-create-two','--url',base+'/push']); assert.equal(result.receipt.status, 'created', result.receipt.message); assert.notEqual(result.target.id, one.id); return result.target
    })
    const nativeBefore = JSON.parse(await readFile(join(directory, 'browser-targets.json'), 'utf8'))
    await observe('original-operation-id-never-creates-twice', async () => {
      await assert.rejects(client.call('browser.create', { operationId: 'standalone-create-one', url: base+'/form' }), /already|retained|rerun/i)
      assert.equal((await client.call('browser.targets', {})).targets.length, 2)
      const original = await client.call('browser.inspect', { operationId: 'standalone-create-one' }); assert.equal(original.runOperation.lifecycleReceipt.status, 'created'); assert.equal(original.runOperation.browserId, one.id)
    })
    await observe('http-form-native-ref-and-exact-target', async () => {
      const result = await run(one.id, `const tree=await snapshot();const input=tree.nodes.find(n=>n.ref&&n.name==='Draft');const button=tree.nodes.find(n=>n.ref&&n.name==='Submit');await fillInput(input.ref,'unsaved original');await click(button.ref);return await js("Number(document.querySelector('#count').textContent)")`, 'standalone-form-operation')
      assert.equal(result.outcome.kind, 'completed', result.outcome.message); assert.equal(result.result, 1)
      assert.equal((await state(two.id)).result.count, 0, 'Driving the first Browser must not touch the second target')
      assert.equal(posts, 1)
    })
    await observe('websocket-page-and-independent-native-input', async () => {
      const result = await run(two.id, `const tree=await snapshot();await fillInput(tree.nodes.find(n=>n.ref&&n.name==='Draft').ref,'second-page draft');return await js("document.querySelector('#push').textContent")`)
      assert.equal(result.outcome.kind,'completed',result.outcome.message); assert.equal(result.result,'native-websocket-message')
      assert.equal((await state(one.id)).result.draft, 'unsaved original', 'Accurate Browser routing must retain the first input')
    })
    await observe('network-idle-after-redirect-and-overlapping-cancel', async () => {
      const startFetches = `void setTimeout(() => {
        const slow = new AbortController();
        fetch('/network-wait/slow', { signal: slow.signal }).catch(error => { window.slowOutcome = error.name });
        setTimeout(() => slow.abort(), 170);
        fetch('/network-wait/start').then(response => response.text()).then(text => { window.waitOutcome = text });
      }, 100)`
      const result = await run(one.id, `await js(${JSON.stringify(startFetches)}); await waitForNetworkIdle(2500);
        return await js('({final: window.waitOutcome, slow: window.slowOutcome})')`)
      assert.equal(result.outcome.kind, 'completed', 'Network idle must accept the original finished redirect chain: ' + result.outcome.message)
      assert.deepEqual(result.result, { final: 'original final response', slow: 'AbortError' })
      assert.deepEqual(waitedRequests.filter(url => url !== '/network-wait/slow'),
        ['/network-wait/start', '/network-wait/redirect', '/network-wait/final'])
      assert.equal(waitedRequests.filter(url => url === '/network-wait/slow').length, 1)
    })
    await observe('explicit-stop-fences-pending-native-action', async () => {
      const pending = run(one.id, `const tree=await snapshot();await wait(2000);await click(tree.nodes.find(n=>n.ref&&n.name==='Submit').ref);return true`, 'standalone-held-operation')
      const deadline = Date.now()+10_000
      while(Date.now()<deadline) { const result=await client.call('browser.inspect',{operationId:'standalone-held-operation'});if(result.runOperation?.steps.some(s=>s.method==='wait'))break;await delay(20) }
      await client.call('browser.stop', {operationId:'standalone-held-operation'})
      const result=await pending;assert.equal(result.outcome.kind,'stopped');await delay(2100);assert.equal(posts,1,'Stop must prevent the pending original click');assert.equal((await state(two.id)).result.draft,'second-page draft')
    })
    await observe('real-host-restart-preserves-browser-target-and-unsaved-input', async () => {
      await client.dispose(); child.kill('SIGKILL'); await once(child, 'exit'); await start()
      const nativeAfter=JSON.parse(await readFile(join(directory,'browser-targets.json'),'utf8'))
      assert.equal(nativeAfter.engine.endpoint,nativeBefore.engine.endpoint)
      for(const old of nativeBefore.targets)assert.equal(nativeAfter.targets.find(t=>t.id===old.id).targetId,old.targetId,'Restart must reconnect the same native target by its original Browser id')
      assert.equal((await state(one.id)).result.draft,'unsaved original');assert.equal((await state(two.id)).result.draft,'second-page draft')
      assert.equal(posts,1,'A host restart must not replay a retained program')
      const operation=await client.call('browser.inspect',{operationId:'standalone-create-one'});assert.equal(operation.runOperation.lifecycleReceipt.status,'created')
    })
    await observe('wrong-document-close-keeps-both-targets', async () => {
      await assert.rejects(client.call('browser.close',{operationId:'standalone-wrong-close',browserId:one.id,navigationId:'not-the-original-document'}),/document|available/i)
      assert.equal((await state(one.id)).result.draft,'unsaved original');assert.equal((await state(two.id)).result.draft,'second-page draft')
    })
    await observe('ordinary-alert-confirm-raw-and-prompt-owner-answers', async () => {
      for(const [kind,answer,expected] of [['alert',"await cdp('Page.handleJavaScriptDialog',{accept:true})",true],['confirm',"await cdp('Page.handleJavaScriptDialog',{accept:true})",true],['prompt',"await acceptDialog('typed prompt')",'typed prompt']]) {
        const expression=kind==='alert'?"window.dialogValue=(()=>{alert('ordinary fixture dialog');return true})()":`window.dialogValue=${kind}('ordinary fixture dialog')`
        const code=`try{await js(${JSON.stringify(expression)})}catch{};${answer};return await js('window.dialogValue')`
        const result=await run(one.id,code)
        assert.equal(result.outcome.kind,'completed',result.outcome.message)
        assert.equal(result.result,expected)
      }
      const described=await client.call('system.endpoint',{});assert.ok(described.methods.includes('browser.create'));assert.ok(!described.methods.some(method=>method.startsWith('file.')||method.startsWith('notebook.')))
      const unavailable=await client.call('file.list',{zoneId:'ungranted',path:'.'}).then(()=>false,error=>error.code==='HOST_CAPABILITY_UNAVAILABLE')
      assert.equal(unavailable,true,'A Browser-only endpoint cannot acquire the default file owner')
    })
    await observe('beforeunload-retains-original-input-and-other-target', async () => {
      const prepared=await run(one.id,`await js("window.onbeforeunload=e=>{e.preventDefault();e.returnValue=''}");const tree=await snapshot();await click(tree.nodes.find(n=>n.ref&&n.name==='Draft').ref);return true`);assert.equal(prepared.outcome.kind,'completed',prepared.outcome.message)
      const attempted=await run(one.id,`try{await gotoUrl(${JSON.stringify(base+'/form?replacement')})}catch{};let reason,approved=false;try{await cdp('Page.handleJavaScriptDialog',{accept:true});approved=true}catch(error){reason=error.message};try{await cdp('Page.handleJavaScriptDialog',{accept:false})}catch{};return {reason,approved}`)
      assert.equal(attempted.result?.approved,false,'Raw beforeunload accept cannot impersonate the person');assert.match(attempted.result.reason,/only the person|person decides/i)
      assert.equal((await state(one.id)).result.draft,'unsaved original','Raw refusal and cancellation preserve original input')
      const target=(await client.call('browser.targets',{})).targets.find(t=>t.id===one.id)
      const result=await client.call('browser.close',{operationId:'standalone-beforeunload',browserId:one.id,navigationId:target.navigationId});assert.equal(result.receipt.status,'kept',result.receipt.message)
      assert.equal((await state(one.id)).result.draft,'unsaved original');assert.equal((await state(two.id)).result.draft,'second-page draft')
    })
    await observe('exact-entity-close-keeps-other-browser-healthy', async () => {
      await run(one.id,'await js("window.onbeforeunload=null");return true')
      const target=(await client.call('browser.targets',{})).targets.find(t=>t.id===one.id)
      const result=await cli(['browser','close','--operation-id','standalone-final-close','--browser',one.id,'--navigation',target.navigationId]);assert.equal(result.receipt.status,'closed',result.receipt.message)
      assert.equal((await state(two.id)).result.draft,'second-page draft')
      assert.equal((await client.call('browser.targets',{})).targets.find(t=>t.id===one.id).status,'closed')
    })
    receipt.passed=true
  } catch(error) { receipt.error=String(error?.stack??error);await persist();throw error
  } finally {
    await persist()
    await client?.dispose?.().catch(()=>{})
    if(child && child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit')}}
    receipt.hostProcess = child ? { originalPid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, exitConfirmed: child.exitCode !== null || child.signalCode !== null } : null
    // Only this proof's exact owned engine endpoint is closed. User App and all other engines are outside scope.
    if(!engineEndpoint)try{engineEndpoint=JSON.parse(await readFile(join(directory,'browser-targets.json'),'utf8')).engine?.endpoint}catch{}
    if(!engineEndpoint)try{const[port,path]=(await readFile(join(directory,'engine-profile','DevToolsActivePort'),'utf8')).trim().split('\n');if(/^\d+$/.test(port)&&path?.startsWith('/devtools/browser/'))engineEndpoint=`ws://127.0.0.1:${port}${path}`}catch{}
    if(engineEndpoint){try{const browser=await puppeteer.connect({browserWSEndpoint:engineEndpoint,protocolTimeout:15000});await browser.close()}catch{}}
    for(const socket of ws.clients)socket.terminate();await new Promise(resolve=>ws.close(resolve));await new Promise(resolve=>http.close(resolve))
  }
}
