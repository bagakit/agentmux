import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, desktopRequire, root } from './fixtures/settings-resource-library/environment.mjs'

const mode = process.argv[2]
assert.ok(['--check', '--capture', '--review'].includes(mode))
const base = resolve(root, '.bagakit/executor-command-clarity')
const fixture = resolve(root, 'apps/desktop/scripts/fixtures/executor-launch')
const product = [
  'packages/core/src/executable-diagnostics.ts', 'packages/core/src/client.ts', 'packages/core/src/executor-owner.ts',
  ...['components/settings/ExecutorLaunchPreview.tsx','components/settings/AgentSettingsPane.tsx',
    'components/settings/HostExecutorSettings.tsx', 'lib/executor-detection.ts','lib/executors.ts','styles/settings-resource-library.css'
  ].map(path => 'apps/desktop/src/renderer/src/' + path)
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function identity() {
  return Object.fromEntries(await Promise.all(product.map(async file => [file,hash(await readFile(resolve(root,file)))])))
}
await mkdir(base,{recursive:true})
const proofFiles = [...product,
  'packages/core/src/agentmux-cli-resource-guide.ts',
  'apps/desktop/scripts/verify-executor-launch.mjs',
  'apps/desktop/scripts/fixtures/executor-launch/vitest.config.mts',
  'apps/desktop/test/executor-launch.test.tsx','apps/desktop/test/agent-executor-picker.test.tsx',
  'apps/desktop/test/remote-executor-consumer.test.ts',
  'packages/core/test/client-executor-availability.test.ts','packages/core/test/executor-owner.test.ts',
  'packages/core/test/executor-diagnostics-public.test.ts',
  'apps/desktop/src/main/runtime-controller.ts','packages/core/src/public-rpc-service.ts',
  'packages/core/src/settings-cli.ts', 'pnpm-lock.yaml']
const proofInputs = Object.fromEntries(await Promise.all(proofFiles.map(async file => [file,hash(await readFile(resolve(root,file)))])))
if (mode === '--check') {
  try {
    const previous = JSON.parse(await readFile(resolve(base,'check.json'),'utf8'))
    if (previous.passed && JSON.stringify(previous.proofInputs) === JSON.stringify(proofInputs)) {
      console.log(JSON.stringify({passed:true,reused:previous.evidence,scope:'unchanged owning implementation, test inputs, public routes and dependencies'}))
      process.exit(0)
    }
  } catch(error) { if(error.code !== 'ENOENT')throw error }
}
if (mode === '--review') {
  const capture = JSON.parse(await readFile(resolve(base,'capture.json'),'utf8'))
  const peer = JSON.parse(await readFile(resolve(base,'visual-review.json'),'utf8'))
  assert.equal(capture.passed,true)
  assert.equal(peer.passed,true,'Independent actual PNG review must accept the candidate')
  assert.equal(peer.sourceIdentity,capture.sourceIdentity)
  assert.deepEqual(await identity(),capture.sources,'Reviewed product Source remains unchanged')
  assert.ok(capture.render.frames.length >= 5)
  for(const frame of capture.render.frames) {
    const digest=hash(await readFile(resolve(capture.evidence,frame.file)))
    assert.equal(digest,frame.sha256)
    assert.ok(peer.images.includes(frame.sha256),'Every original PNG actually reviewed')
  }
  console.log(JSON.stringify({passed:true,reviewer:peer.reviewer,capture:capture.evidence}))
  process.exit(0)
}
const evidence=resolve(base,mode.slice(2)+'-'+crypto.randomUUID())
await mkdir(evidence,{recursive:true})
const sources=await identity(), receipt={passed:false,mode,evidence,sources,sourceIdentity:hash(JSON.stringify(sources)),proofInputs,runs:[]}
async function run(label,command,args,env={}) {
  const log=[]
  const environment={...process.env,...env}
  if(label==='electron')delete environment.ELECTRON_RUN_AS_NODE
  const result=await runProbeProcess(command,args,{cwd:root,temporaryRoot:evidence,env:environment,timeoutMs:90000,onLine:line=>log.push(line)})
  await writeFile(resolve(evidence,label+'.log'),log.join('\n'))
  return result
}
try {
  if(mode==='--check') {
    const build=await run('core-build','pnpm',['--filter','@agentmux/core','build'])
    assert.equal(build.exitCode,0,'Build the exact public CLI and Core')
    const config=resolve(fixture,'vitest.config.mts')
    for(const mutant of ['baseline','preview','adjacent','literal','diagnostic','label']) {
      const output=resolve(evidence,mutant+'.json'),mutationLog=resolve(evidence,mutant+'-loaded.jsonl')
      const result=await run(mutant,process.execPath,[desktopRequire.resolve('vitest/vitest.mjs'),'run','--config',config,'--reporter=json','--outputFile',output],
        mutant==='baseline'?{}:{AMUX_LAUNCH_MUTANT:mutant,AMUX_LAUNCH_MUTATION_LOG:mutationLog})
      const tests=JSON.parse(await readFile(output,'utf8'))
      assert.equal(result.timedOut,false)
      assert.ok(tests.numTotalTests>0,'Actual nonempty test set')
      if(mutant==='baseline') { assert.equal(result.exitCode,0);assert.equal(tests.numFailedTests,0) }
      else {
        const loaded=(await readFile(mutationLog,'utf8')).trim().split('\n').map(JSON.parse)
        assert.ok(loaded.length>0 && loaded.every(item=>item.mutant===mutant),'Actual production mutation loaded')
        assert.equal(result.exitCode,1)
        const failures=tests.testResults.flatMap(suite=>suite.assertionResults??[]).filter(test=>test.status==='failed')
        assert.ok(failures.length>0 && failures.some(test=>test.failureMessages.some(message=>message.includes('AssertionError'))),'Meaningful assertion RED, never setup/compilation RED')
      }
      receipt.runs.push({mutant,...result,passedTests:tests.numPassedTests,failedTests:tests.numFailedTests})
    }
    // Restore/retest the unchanged production Source after loaded mutations.
    const restored=await run('restored',process.execPath,[desktopRequire.resolve('vitest/vitest.mjs'),'run','--config',config])
    assert.equal(restored.exitCode,0);receipt.restored=restored
    const callers=[
      ['apps/desktop/src/renderer/src/components/settings/modules/agents.tsx','<AgentSettingsPane','api.config.save'],
      ['apps/desktop/src/renderer/src/components/settings/AgentSettingsPane.tsx','<ExecutorLaunchPreview','<HostExecutorSettings','args: parseExecutorArgs(draft.args)'],
      ['apps/desktop/src/main/runtime-controller.ts','current.client.probeExecutorAvailability(input.providerId, input.command)'],
      ['packages/core/src/public-rpc-service.ts','settings.executors.discover'],
      ['packages/core/src/settings-cli.ts',"resource === 'executors' && action === 'discover'"]
    ]
    for(const [file,...symbols] of callers) {
      const source=await readFile(resolve(root,file),'utf8')
      for(const symbol of symbols)assert.ok(source.includes(symbol),file+': '+symbol)
    }
    receipt.callers=callers
  } else {
    const {build}=await import(pathToFileURL(desktopRequire.resolve('vite')).href)
    const output=resolve(evidence,'compiled')
    await build({configFile:false,root:resolve(root,'apps/desktop/scripts/fixtures/settings-reference'),base:'./',logLevel:'error',
      resolve:{alias:aliases},worker:{format:'es'},
      esbuild:{jsx:'automatic'},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},
      build:{target:'esnext',outDir:output,emptyOutDir:true}})
    const owned=await mkdtemp(resolve(tmpdir(),'amux-executor-launch-'))
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
    try {
      const result=await run('electron',desktopRequire('electron'),[resolve(fixture,'main.cjs'),resolve(output,'index.html'),owned,evidence],env)
      receipt.render=JSON.parse(await readFile(resolve(evidence,'render.json'),'utf8'))
      assert.equal(result.exitCode,0,receipt.render.failure?.message)
      assert.equal(receipt.render.passed,true)
      for(const frame of receipt.render.frames)frame.sha256=hash(await readFile(resolve(evidence,frame.file)))
      receipt.captureOnly=true
    } finally {
      assert.deepEqual(await listProbeProcesses(-1,owned),[])
      await rm(owned,{recursive:true,force:true})
    }
  }
  assert.deepEqual(await identity(),sources,'Product source remained unchanged')
  receipt.passed=true
} catch(error) {receipt.failure={message:error.message,stack:error.stack};throw error}
finally {
  await writeFile(resolve(evidence,'receipt.json'),JSON.stringify(receipt,null,2))
  if(receipt.passed)await writeFile(resolve(base,mode==='--capture'?'capture.json':'check.json'),JSON.stringify(receipt,null,2))
  console.log(JSON.stringify({passed:receipt.passed,mode,evidence,failure:receipt.failure?.message}))
}
