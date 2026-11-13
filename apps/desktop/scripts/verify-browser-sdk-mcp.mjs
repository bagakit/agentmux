import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { connectBrowserSdk } from '@agentmux/core/browser-sdk'
import { standaloneScenario } from './fixtures/browser-standalone/scenario.mjs'

const repo = resolve(import.meta.dirname, '../../..'), require = createRequire(join(repo, 'packages/browser-mcp/package.json'))
const { Client } = require('@modelcontextprotocol/client'), { StdioClientTransport } = require('@modelcontextprotocol/client/stdio')
const output = await mkdtemp(join(repo, '.local/browser-sdk-mcp-')), work = await mkdtemp(join(tmpdir(), 'amux-sdk-mcp-'))
const files = ['packages/core/src/browser-sdk.ts','packages/core/src/public-rpc-client.ts','packages/core/src/agentmux.ts','packages/core/dist/browser-sdk.js','packages/core/dist/public-rpc-client.js',
  'packages/browser-mcp/src/index.ts','packages/browser-mcp/src/stdio.ts','packages/browser-mcp/dist/index.js','packages/browser-mcp/dist/stdio.js','packages/browser-mcp/package.json',
  'packages/browser/dist/bin.js','packages/browser/dist/browser-program-owner.js','packages/browser/dist/standalone.js','apps/desktop/scripts/fixtures/browser-standalone/scenario.mjs','apps/desktop/scripts/verify-browser-sdk-mcp.mjs']
const sha = value => createHash('sha256').update(value).digest('hex')
const row = { label: 'compiled-sdk-mcp-original-standalone', cases: [], passed: false }
const receipt = { schema: 'agentmux.browser-sdk-mcp.proof.v1', head: execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  diffSha256: sha(execFileSync('git',['diff','--binary'],{cwd:repo})), inputs: Object.fromEntries(await Promise.all(files.map(async file => [file,sha(await readFile(join(repo,file)))]))),
  actorFixture: 'isolated-private-user-device-no-managed-claim', runs: [row], passed: false }
const persist = () => writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
await persist()
try {
  assert.equal(process.env.AGENTMUX_AGENT_SESSION_ID, undefined, 'Run this private user/device fixture without the parent managed claim')
  assert.equal(process.env.AGENTMUX_AGENT_CAPABILITY, undefined)
  await standaloneScenario({ repo, bundle: join(repo,'packages/browser/dist/bin.js'), work,
    executablePath: process.env.AGENTMUX_BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', receipt: row, persist,
    exercise: async ({ one, base, observe, posts }) => {
      const endpoint = { transport: 'unix', path: join(work,'host.sock') }, sdk = await connectBrowserSdk({ endpoint })
      const client = new Client({name:'real-sdk-mcp-consumer',version:'0.1.0'})
      const env = Object.fromEntries(Object.entries(process.env).filter(([key,value]) => value !== undefined && !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo,'packages/browser-mcp/dist/stdio.js'),'--endpoint','unix:'+endpoint.path], env, stderr:'pipe' })
      let mcpPid
      const call = async (method,params) => {
        const result = await client.callTool({name:'browser_call',arguments:{method,params}})
        assert.notEqual(result.isError,true,JSON.stringify(result)); return result.structuredContent.result
      }
      const read = target => sdk.call('browser.run',{browserId:target,code:'return await js("({draft:document.querySelector(\'input\').value,count:document.querySelector(\'#count\').textContent})")'})
      const fill = value => `const tree=await snapshot();await fillInput(tree.nodes.find(node=>node.ref&&node.name==='Draft').ref,${JSON.stringify(value)});`
      try {
        await client.connect(transport); mcpPid=transport.pid; row.mcpProcess={originalPid:mcpPid}
        const two = await observe('compiled-sdk-explicit-target-preserves-other-page',async()=>{
          const created=await sdk.call('browser.create',{operationId:'sdk-second-create',url:base+'/form'});assert.equal(created.receipt.status,'created')
          const result=await sdk.call('browser.run',{browserId:created.target.id,code:fill('neighbor unsaved draft')+'return true'});assert.equal(result.outcome.kind,'completed')
          assert.equal((await read(one.id)).result.draft,'');assert.equal((await read(created.target.id)).result.draft,'neighbor unsaved draft')
          return created.target
        })
        await observe('official-mcp-stdio-discovers-original-targets-and-unsupported-task-owner',async()=>{
          const discovered=await client.callTool({name:'browser_discover',arguments:{}});assert.notEqual(discovered.isError,true)
          const facts=discovered.structuredContent;assert.equal(facts.availability,'advertised');assert.ok(facts.targets.targets.some(target=>target.id===one.id));assert.ok(facts.targets.targets.some(target=>target.id===two.id))
          assert.ok(!facts.methods.some(method=>method.startsWith('browser.task.')))
          const unsupported=await client.callTool({name:'browser_call',arguments:{method:'browser.task.source',params:{browserId:one.id}}})
          assert.equal(unsupported.isError,true);assert.equal(unsupported.structuredContent.error.code,'HOST_CAPABILITY_UNAVAILABLE')
          const result=await call('browser.run',{browserId:one.id,operationId:'mcp-original-click',code:fill('mcp original draft')+`;await click((await snapshot()).nodes.find(node=>node.ref&&node.name==='Submit').ref);return true`})
          assert.equal(result.outcome.kind,'completed');assert.equal(posts(),1);assert.equal((await read(two.id)).result.draft,'neighbor unsaved draft')
        })
        await observe('original-sdk-follow-and-mcp-stop-do-not-repeat-pending-native-click',async()=>{
          const id='mcp-original-pending', before=posts()
          let ready, failed
          const waiting=new Promise((accept,reject)=>{ready=accept;failed=reject}), timeout=setTimeout(()=>failed(new Error('Original operation never reached its waiting phase')),10000)
          const subscription=await sdk.follow({operationId:id},{onInitial:initial=>{if(initial.runOperation?.phase==='waiting')ready()},onEvent:event=>{if(event.type==='progress'&&event.data.event?.type==='phase-changed'&&event.data.event.phase==='waiting')ready()},onEnd:error=>{if(error)failed(error)}})
          const pending=call('browser.run',{browserId:one.id,operationId:id,code:`const tree=await snapshot();await wait(5000);await click(tree.nodes.find(node=>node.ref&&node.name==='Submit').ref);return true`})
          try {await waiting} finally {clearTimeout(timeout);await subscription.dispose()}
          const window=await client.callTool({name:'browser_follow',arguments:{operationId:id,durationMs:30,maxEvents:8}});assert.notEqual(window.isError,true);assert.equal(window.structuredContent.initial.runOperation.id,id)
          const stopped=await call('browser.stop',{operationId:id});assert.equal(stopped.runOperation.id,id)
          const result=await pending;assert.equal(result.outcome.kind,'stopped');assert.equal(result.runOperation.id,id)
          assert.equal(posts(),before);assert.equal((await read(one.id)).result.draft,'mcp original draft');assert.equal((await read(two.id)).result.draft,'neighbor unsaved draft')
        })
        await observe('mcp-disconnect-retains-original-operation-and-healthy-page',async()=>{
          const id='mcp-original-disconnect', before=posts()
          const pending=client.callTool({name:'browser_call',arguments:{method:'browser.run',params:{browserId:one.id,operationId:id,code:'await wait(1500);return true'}}}).catch(error=>({disconnected:error.message}))
          let operation
          for(let count=0;count<40;count++){
            operation=await sdk.call('browser.inspect',{operationId:id});if(operation.runOperation)break
            await new Promise(resolve=>setTimeout(resolve,25))
          }
          assert.equal(operation?.runOperation?.id,id)
          await client.close();await pending
          const retained=await sdk.call('browser.inspect',{operationId:id});assert.equal(retained.runOperation.id,id);assert.equal(retained.runOperation.browserId,one.id)
          assert.equal(posts(),before);assert.equal((await read(two.id)).result.draft,'neighbor unsaved draft')
        })
      } finally {
        await client.close().catch(()=>{});await sdk.dispose()
        if(mcpPid){try{process.kill(mcpPid,0);row.mcpProcess.exitConfirmed=false}catch(error){assert.equal(error.code,'ESRCH');row.mcpProcess.exitConfirmed=true}}
      }
    } })
  assert.equal(row.passed,true)
  assert.deepEqual(row.cases.map(item=>item.label),['public-create-original-receipt','compiled-sdk-explicit-target-preserves-other-page','official-mcp-stdio-discovers-original-targets-and-unsupported-task-owner','original-sdk-follow-and-mcp-stop-do-not-repeat-pending-native-click','mcp-disconnect-retains-original-operation-and-healthy-page'])
  assert.ok(Number.isInteger(row.mcpProcess?.originalPid) && row.mcpProcess.originalPid>0,'The official MCP client must own a real independent process')
  receipt.passed=true
} catch(error) {receipt.error=String(error?.stack??error);throw error}
finally {
  const profile=join(work,'state/engine-profile')
  const remaining = async () => (await promisify(execFile)('ps',['-axo','pid=,args='])).stdout.split('\n').filter(line=>line.includes(profile)).map(line=>line.trim())
  receipt.remaining=await remaining()
  // Browser.close acknowledges before the original OS processes necessarily exit.
  const until=Date.now()+3000
  while(receipt.remaining.length && Date.now()<until){await new Promise(resolve=>setTimeout(resolve,100));receipt.remaining=await remaining()}
  if(!receipt.remaining.length){await rm(profile,{recursive:true,force:true});receipt.privateEngineProfileRemoved=true}
  if(receipt.remaining.length||row.mcpProcess?.exitConfirmed===false)receipt.passed=false
  await persist();process.stderr.write('SDK/MCP proof receipt: '+join(output,'receipt.json')+'\n')
  if(!receipt.passed)process.exitCode=1
}
