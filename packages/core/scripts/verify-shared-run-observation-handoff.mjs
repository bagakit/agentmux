import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
const root=resolve(import.meta.dirname,'../../..'),evidence=resolve(root,'.local/shared-run-observation-handoff')
const config='apps/desktop/test/shared-run-observation-handoff.config.mts'
const hash=value=>createHash('sha256').update(value).digest('hex')
const json=async file=>JSON.parse(await readFile(file,'utf8'))
const lines=async file=>(await readFile(file,'utf8')).split('\n').filter(Boolean).map(JSON.parse)
const mutants=['replace-serving-pump','candidate-release','late-unavailable']
const expected={'replace-serving-pump':'shared observation preserves the original terminal reader','candidate-release':'shared observation closes its temporary snapshot candidate','late-unavailable':'shared observation refuses a false live handoff'}
const assertionFailure=message=>/^AssertionError:/mu.test(message)||(/^Error: promise resolved .+ instead of rejecting$/mu.test(message)&&message.includes('__VITEST_REJECTS__'))
const sdkSources=['index','client','attachment','control','validation','wire','gap-observation','stop-operation','generated/constants'].map(name=>`packages/core/node_modules/@ctxmux/sdk/dist/${name}.js`)
const required=[...sdkSources,config,'packages/core/package.json','packages/core/src/index.ts','packages/core/src/headless-runtime.ts','packages/core/src/ctxmux-run-adapter.ts','packages/core/src/client.ts','packages/core/test/shared-run-observation-handoff.test.ts',
  'packages/core/src/hosted-client.ts','packages/core/src/hosted-value.ts','packages/core/src/hosted-runtime-service.ts','packages/core/src/public-rpc-client.ts',
  'packages/core/test/helpers/run-attachment-fixture.ts','packages/core/test/helpers/hosted-runtime-port.ts','packages/core/test/helpers/headless-runtime-fixture.ts',
  'packages/core/test/fixtures/shared-run-observation-owner.mjs','apps/desktop/test/shared-run-observation-handoff.test.tsx','apps/desktop/test/fixtures/shared-run-output.mjs',
  'apps/desktop/test/fixtures/terminal-observation-bridge.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/components/TerminalView.tsx','apps/desktop/src/renderer/src/store.ts','apps/desktop/src/renderer/src/lib/terminal-attachment-observation.ts','apps/desktop/src/renderer/src/lib/terminal-view-observation.ts','apps/desktop/src/renderer/src/lib/api.ts','apps/desktop/test/session-continuity-core.config.mts','vitest.setup.ts',
  'packages/core/scripts/verify-shared-run-observation-handoff.mjs','packages/core/dist/control-endpoint-listener-worker.js',`packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]
async function privateDependencies(directory){
  const destination=resolve(directory,'node_modules');await mkdir(destination,{recursive:true})
  const source=resolve(root,'packages/core/node_modules')
  for(const name of await readdir(source)){
    if(name.startsWith('@')){
      await mkdir(resolve(destination,name),{recursive:true})
      for(const child of await readdir(resolve(source,name)))await symlink(resolve(source,name,child),resolve(destination,name,child),'dir')
    }else await symlink(resolve(source,name),resolve(destination,name),'dir')
  }
  await symlink(resolve(root,'packages/core'),resolve(destination,'@agentmux/core'),'dir')
}
async function checkInputs(inputs){
  for(const file of required)assert.match(inputs[file]??'',/^[a-f0-9]{64}$/,'Required candidate input: '+file)
  for(const [file,pin]of Object.entries(inputs)){assert.match(pin,/^[a-f0-9]{64}$/);assert.equal(hash(await readFile(resolve(root,file))),pin,'Candidate input changed: '+file)}
  assert.equal((await json(resolve(root,'packages/core/package.json'))).exports['.'].import,'./dist/index.js','Original public package entry')
  assert.ok((await readFile(resolve(root,'packages/core/src/index.ts'),'utf8')).includes("export * from './headless-runtime.js'"),'Original public Headless owner remains discoverable')
}
async function checkResources(rows,baseline,probe){
  assert.ok(!rows.some(row=>row.event==='cleanup-error'),'No private cleanup failure')
  if(baseline)assert.ok(rows.some(row=>row.event==='preserved'&&row.acceptedInputBytes===0&&row.publicFollower&&row.selection&&row.originalPumps===row.finalPumps&&row.corruptedTransfers===1),'Real Native/mounted/public preservation witness')
  for(const row of rows.filter(row=>['allocated','bridge'].includes(row.event))){
    await assert.rejects(access(row.root),'Private root removed')
    if(row.event==='allocated'){
      assert.ok(rows.some(end=>end.event==='released'&&end.root===row.root),'Private owner release receipt')
      for(const pid of [row.nativePid,row.ownerPid]){assert.ok(Number.isInteger(pid)&&pid>1);if(probe)assert.throws(()=>process.kill(pid,0),'Exact private process exited')}
    }
  }
  if(probe)for(const row of rows.filter(row=>row.event==='run'&&row.pid!==null))assert.throws(()=>process.kill(row.pid,0),'Exact private PTY exited')
}
async function consumeResult(row,inputs,probeCleanup=false){
  const report=resolve(root,row.report),loaded=resolve(evidence,row.name+'-loaded.jsonl'),resources=resolve(evidence,row.name+'-resources.jsonl')
  const suite=await json(report),modules=await lines(loaded),activity=await lines(resources)
  const assertions=suite.testResults.flatMap(value=>value.assertionResults)
  assert.ok(assertions.some(test=>['passed','failed'].includes(test.status)),'Nonempty actual consumer assertions')
  assert.ok(!suite.testResults.some(value=>value.status==='failed'&&!value.assertionResults.length),'Loading errors cannot stand for semantic proof')
  for(const module of modules)assert.equal(module.sourceSHA256,inputs[module.file],'Exact loaded candidate source: '+module.file)
  assert.ok(modules.some(value=>value.file==='packages/core/src/ctxmux-run-adapter.ts'&&value.sourceSHA256===inputs[value.file]),'Exact actual adapter source loaded')
  await checkResources(activity,row.name==='baseline',probeCleanup)
  if(row.name!=='baseline'){
    assert.ok(mutants.includes(row.name));assert.equal(suite.numFailedTests,1);assert.equal(suite.success,false)
    assert.ok(modules.some(value=>value.mutation===row.name&&value.sourceSHA256!==value.loadedSHA256),'Selected source mutant loaded')
    assert.ok(assertions.some(test=>test.status==='failed'&&test.fullName.includes(expected[row.name])&&test.failureMessages.some(assertionFailure)),'Designated semantic oracle killed mutant')
  }else{
    assert.equal(suite.success,true);assert.equal(suite.numFailedTests,0);assert.equal(suite.numPassedTests,8)
    for(const title of ['original terminal reader','original agent reader','temporary snapshot candidate','current unavailable fact','false live handoff','superseded opening','foreign snapshot','actual Native mounted history'])assert.ok(assertions.some(test=>test.status==='passed'&&test.fullName.includes(title)),'Nonempty accepted consumer: '+title)
    for(const file of ['apps/desktop/src/renderer/src/components/TerminalView.tsx','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/preload/index.ts','packages/core/src/hosted-client.ts','packages/core/src/hosted-value.ts'])assert.ok(modules.some(value=>value.file===file),'Real consumer loaded: '+file)
  }
  const actual={...row,passed:suite.numPassedTests,failed:suite.numFailedTests,reportSHA256:hash(await readFile(report)),loadedSHA256:hash(await readFile(loaded)),resourcesSHA256:hash(await readFile(resources)),privateCleanup:true}
  for(const key of ['passed','failed','reportSHA256','loadedSHA256','resourcesSHA256','privateCleanup'])if(Object.hasOwn(row,key))assert.equal(actual[key],row[key],'Retained proof field: '+key)
  return actual
}
if(process.argv.includes('--run')){
  await mkdir(evidence,{recursive:true})
  const privateRoot=await mkdtemp(resolve(evidence,'owner-'))
  try{
    await privateDependencies(privateRoot)
    const compiled=resolve(privateRoot,'core-source.mjs')
    const compiledInputs=new Map()
    const built=await build({entryPoints:[resolve(root,'packages/core/src/headless-runtime.ts')],bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',outfile:compiled,
      alias:{'@agentmux/identity/runtime-source':resolve(root,'packages/identity/dist/runtime-source.js')},metafile:true,logLevel:'silent',plugins:[{name:'exact-compiled-inputs',setup(builder){
        builder.onLoad({filter:/\.(?:[cm]?[jt]sx?|json)$/},async({path})=>{
          const contents=await readFile(path,'utf8');compiledInputs.set(relative(root,path),hash(contents))
          const extension=path.split('.').at(-1),loader=['ts','tsx','jsx','json'].includes(extension)?extension:'js'
          return {contents,loader}
        })
      }}]})
    const sdk=resolve(root,'packages/core/node_modules/@ctxmux/sdk/dist/index.js')
    const worker=resolve(privateRoot,'owner.mjs')
    await writeFile(worker,`process.env.AGENTMUX_TEST_HANDOFF_CORE_ENTRY=${JSON.stringify(compiled)};process.env.AGENTMUX_TEST_HANDOFF_SDK_ENTRY=${JSON.stringify(sdk)};await import(${JSON.stringify(new URL('../test/fixtures/shared-run-observation-owner.mjs',import.meta.url).href)});\n`)
    const consumed=[...new Set([...required,...Object.keys(built.metafile.inputs).map(file=>relative(root,resolve(root,file))).filter(file=>!file.includes('node_modules/'))])]
    const inputs=Object.fromEntries(await Promise.all(consumed.map(async file=>[file,compiledInputs.get(file)??hash(await readFile(resolve(root,file)))])))
    const compiledOwnerSHA256=hash(await readFile(compiled)),results=[]
    await writeFile(resolve(evidence,'candidate.json'),JSON.stringify({inputs,compiledOwnerSHA256},null,2)+'\n')
    await checkInputs(inputs)
    for(const mutation of [null,...mutants]){
      const name=mutation??'baseline',report=resolve(evidence,name+'.json'),loaded=resolve(evidence,name+'-loaded.jsonl'),resources=resolve(evidence,name+'-resources.jsonl')
      await writeFile(loaded,'');await writeFile(resources,'')
      const cache=await mkdtemp(resolve(tmpdir(),'sh-'));let log=''
      assert.ok(Buffer.byteLength(resolve(cache,'amrr-123456/r/headless.sock'))<104,'Private Unix socket placement must remain usable')
      try{
        const child=spawn(process.execPath,[resolve(root,'node_modules/vitest/vitest.mjs'),'run','--config',config,'--reporter=json','--outputFile='+report],{cwd:root,env:{...process.env,
          AGENTMUX_SHARED_HANDOFF_MUTATION:mutation??'',SHARED_HANDOFF_LOADED:loaded,SHARED_HANDOFF_RESOURCES:resources,AGENTMUX_CONTINUITY_MUTATION:'',
          AGENTMUX_TEST_CLIENT_ENTRY:'',AGENTMUX_TEST_RPC_CLIENT_ENTRY:'',AGENTMUX_TEST_OWNER_ENTRY:worker,TMPDIR:cache},stdio:['ignore','pipe','pipe']})
        child.stdout.on('data',value=>{log+=value});child.stderr.on('data',value=>{log+=value})
        const code=await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes)})
        await writeFile(resolve(evidence,name+'.log'),log)
        const row=await consumeResult({name,report:relative(root,report)},inputs,true)
        assert.equal(code,mutation?1:0,log)
        results.push(row)
        process.stdout.write(name+': '+(mutation?'semantic mutant rejected':'shared readers preserved')+'\n')
      }finally{await rm(cache,{recursive:true,force:true})}
    }
    await checkInputs(inputs)
    await writeFile(resolve(evidence,'receipt.json'),JSON.stringify({schema:'agentmux.shared-run-observation-handoff.v1',status:'passed',inputs,compiledOwnerSHA256,results,
      scope:'Fresh exact snapshots preserve the original physical pump until an actual unavailable/end fact. Actual private Native/Unix/Hosted/Main/mounted reader and public raw follower; no unknown stall or field-error-root-cause claim.'},null,2)+'\n')
  }finally{await rm(privateRoot,{recursive:true,force:true})}
}else{
  const receipt=await json(resolve(evidence,'receipt.json'));assert.equal(receipt.status,'passed');await checkInputs(receipt.inputs)
  assert.deepEqual(receipt.results.map(value=>value.name),['baseline',...mutants])
  assert.match(receipt.compiledOwnerSHA256,/^[a-f0-9]{64}$/)
  for(const value of receipt.results)await consumeResult(value,receipt.inputs)
  process.stdout.write('Shared Run observation: exact candidate receipt verified\n')
}
