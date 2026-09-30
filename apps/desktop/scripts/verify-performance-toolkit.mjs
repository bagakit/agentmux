import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const base = resolve(root, '.bagakit/design/toolkit-performance-20261004/evidence')
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-'))
const sha = value => createHash('sha256').update(value).digest('hex')
const mode = process.argv[2]
assert.ok(['--backend','--mutations','--callers'].includes(mode), 'Choose one owning verification mode')
const config = 'apps/desktop/scripts/fixtures/performance-toolkit/vitest.config.mts'
const ownSources = ['packages/core/src/toolkit.ts','packages/core/src/toolkit-control.ts','packages/core/src/control.ts','packages/core/src/control-host.ts',
  'packages/core/src/client.ts','packages/core/src/ctxmux-run-adapter.ts','packages/core/src/agentmux.ts','packages/core/src/agentmux-cli-help.ts',
  'apps/desktop/src/main/toolkit-owner.ts','apps/desktop/src/main/toolkit-asset.ts','apps/desktop/src/main/toolkit-run-port.ts','apps/desktop/src/main/toolkit-ipc.ts',
  'apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/shared/toolkit.ts','apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/shared/toolkit-preferences.ts','apps/desktop/src/preload/index.ts','apps/desktop/src/renderer/src/lib/api.ts','apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/resources/toolkit/performance.mjs','apps/desktop/scripts/package-macos.mjs']
const proofPaths = [config,'apps/desktop/scripts/verify-performance-toolkit.mjs','apps/desktop/test/toolkit-owner.test.ts',
  'apps/desktop/test/performance-toolkit-main.test.ts','packages/core/test/toolkit-control.test.ts','packages/core/test/client-terminal-remove.test.ts',
  'apps/desktop/test/toolkit-renderer-routing.test.ts',
  'apps/desktop/scripts/fixtures/performance-toolkit/verify-context-bridge.mjs','apps/desktop/scripts/fixtures/performance-toolkit/context-bridge.cjs','vitest.setup.ts']
const inputs = {}
for (const path of [...ownSources,...proofPaths]) {
  const bytes = await readFile(resolve(root, path)); assert.ok(bytes.length > 0, `Input must be nonempty: ${path}`)
  inputs[path] = sha(bytes)
  const snapshot = resolve(evidence, 'inputs', path); await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
}
const identity = sha(JSON.stringify(Object.fromEntries(ownSources.map(path => [path,inputs[path]]))))
const results = []
if (mode === '--callers') {
  const edges = [
    ['packages/core/src/agentmux.ts','packages/core/src/toolkit-control.ts','subscribeAgentMuxToolkit('],
    ['packages/core/src/control-host.ts','packages/core/src/toolkit-control.ts','serveToolkitControl('],
    ['apps/desktop/src/main/ipc.ts','apps/desktop/src/main/toolkit-owner.ts','new ToolkitOwner('],
    ['apps/desktop/src/main/ipc.ts','packages/core/src/control.ts','    toolkit,'],
    ['apps/desktop/src/main/runtime-controller.ts','packages/core/src/client.ts','client.createTerminal('],
    ['apps/desktop/src/main/runtime-controller.ts','packages/core/src/client.ts','client.removeTerminal('],
    ['apps/desktop/src/preload/index.ts','apps/desktop/src/main/toolkit-ipc.ts',"invoke('toolkit:observe'"],
    ['apps/desktop/resources/toolkit/performance.mjs','packages/core/src/agentmux.ts',"[cli, 'metrics', 'watch']"]
  ]
  assert.ok(edges.length > 0)
  for (const [caller,definition,anchor] of edges) {
    assert.notEqual(caller,definition);assert.ok(!/test|fixture/u.test(caller));
    const source=await readFile(resolve(root,caller),'utf8');assert.ok(source.length>0);assert.ok(source.includes(anchor),caller+' external product edge missing')
  }
  await writeFile(resolve(evidence,'callers.json'),JSON.stringify(edges,null,2)+'\n')
  results.push({mode,edges})
} else {
  const require = createRequire(resolve(root,'packages/core/package.json'))
  const { build } = require('esbuild')
  const aliases = new Map()
  for (const name of ['core','demand','layout']) {
    const dir = resolve(root,'packages',name), pkg = JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'))
    for (const [key,value] of Object.entries(pkg.exports)) {
      const target = typeof value === 'string' ? value : value.import
      const path = resolve(dir,target.replace('./dist/src/','./src/').replace('./dist/','./src/').replace(/\.js$/u,'.ts'))
      assert.ok((await readFile(path)).length > 0); aliases.set(`@agentmux/${name}${key === '.' ? '' : key.slice(1)}`,path)
    }
  }
  async function compileCli() {
    const dir = resolve(evidence, 'cli')
    const cli = resolve(dir,'agentmux.mjs'); await mkdir(dir,{recursive:true})
    await symlink(resolve(root,'packages/core/node_modules'),resolve(dir,'node_modules'),'dir')
    const compiledInputs = {}, loaded = []
    await build({ entryPoints:[resolve(root,'packages/core/src/agentmux.ts')], outfile:cli, bundle:true, platform:'node',
    format:'esm', target:'node24', packages:'external', sourcemap:false, metafile:true,
    plugins:[{ name:'private-current-WT-source', setup(builder) {
      builder.onResolve({filter:/^@agentmux\//}, args => aliases.has(args.path) ? {path:aliases.get(args.path)} : undefined)
      builder.onLoad({filter:/\.(ts|json)$/}, async args => {
        if (!args.path.startsWith(root+'/packages/')) return
        const bytes = await readFile(args.path), path = relative(root,args.path)
        compiledInputs[path] = sha(bytes)
        let contents = bytes.toString()
        loaded.push({path,originalSHA256:sha(bytes),consumedSHA256:sha(contents),mutant:'baseline',bytes:Buffer.byteLength(contents)})
        return {contents,loader:args.path.endsWith('.json') ? 'json' : 'ts'}
      })
    }}] })
    assert.equal(compiledInputs['packages/core/src/agentmux.ts'],inputs['packages/core/src/agentmux.ts'])
    assert.ok(Object.keys(compiledInputs).length > 0)
    await writeFile(resolve(dir,'inputs.json'),JSON.stringify(compiledInputs,null,2)+'\n')
    await writeFile(resolve(dir,'loaded-source.jsonl'),loaded.map(value=>JSON.stringify(value)+'\n').join(''))
    return {cli,compiledInputs,loaded}
  }
  const candidate = await compileCli()
  const exec = promisify(execFile)
  async function bridge(name,mutant='baseline') {
    const output=resolve(evidence,name);await mkdir(output,{recursive:true})
    const child=await exec(process.execPath,[resolve(root,'apps/desktop/scripts/fixtures/performance-toolkit/verify-context-bridge.mjs')],{
      cwd:root,env:{...process.env,AGENTMUX_TOOLKIT_EVIDENCE:output,AGENTMUX_TOOLKIT_BRIDGE_MUTANT:mutant},timeout:150000,maxBuffer:1024*1024})
    await writeFile(resolve(output,'verifier.log'),child.stdout+child.stderr)
    const receipt=JSON.parse(await readFile(resolve(output,'receipt.json'),'utf8'))
    assert.equal(receipt.completed,true);assert.equal(receipt.sandbox,true)
    assert.equal(receipt.collected,mutant==='baseline'?3:1)
    assert.equal(receipt.passedCases,mutant==='baseline'?3:0)
    const loaded=(await readFile(resolve(output,'loaded-source.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loaded.length>0)
    for(const value of loaded.filter(v=>ownSources.includes(v.path)))assert.equal(value.originalSHA256,inputs[value.path],'Bridge Source candidate drift')
    results.push({name,mutant,collected:receipt.collected,passedCases:receipt.passedCases,receiptSHA256:sha(await readFile(resolve(output,'receipt.json'))),exitCode:receipt.exitCode})
    console.log(child.stdout.trim())
  }
  async function run(name,mutant='baseline',expected) {
    const output = resolve(evidence,name); await mkdir(output,{recursive:true})
    const built = candidate
    const allFiles = proofPaths.filter(path => /\.test\.tsx?$/u.test(path))
    const ownerUnit=['shared','establish','framing','release'].includes(mutant)
    const nativeOnly=['registration','asset','dispatch','remove','packaged-path'].includes(mutant)
    const files = ownerUnit ? allFiles.filter(path=>path.endsWith('toolkit-owner.test.ts'))
      : ['terminal-kind','terminal-metadata'].includes(mutant) ? allFiles.filter(path=>path.endsWith('client-terminal-remove.test.ts'))
      : mutant==='renderer-owner' ? allFiles.filter(path=>path.endsWith('toolkit-renderer-routing.test.ts'))
      : mutant==='utf8' ? allFiles.filter(path=>path.endsWith('toolkit-control.test.ts'))
      : nativeOnly ? allFiles.filter(path=>path.endsWith('performance-toolkit-main.test.ts')) : allFiles
    let asset=resolve(root,'apps/desktop/resources/toolkit/performance.mjs'),assetLoaded=[]
    if(mutant==='asset'){
      const original=await readFile(asset,'utf8'),anchor="[cli, 'metrics', 'watch']"
      assert.equal(original.split(anchor).length-1,1,'Official asset actual CLI invocation must be nonempty')
      const transformed=original.replace(anchor,"[cli, 'metrics', 'get']")
      asset=resolve(output,'performance-mutant.mjs');await writeFile(asset,transformed)
      assetLoaded=[{path:'apps/desktop/resources/toolkit/performance.mjs',originalSHA256:sha(original),consumedSHA256:sha(transformed),mutant,bytes:Buffer.byteLength(transformed)}]
      await writeFile(resolve(output,'loaded-asset.jsonl'),assetLoaded.map(value=>JSON.stringify(value)+'\n').join(''))
    }
    let exitCode=0,stdout='',stderr=''
    const filters=mutant==='packaged-path'?['-t','actual production asset helper']
      : nativeOnly?['-t','actual CLI/help/asset']:[]
    try { const value=await exec(process.execPath,[resolve(root,'node_modules/vitest/vitest.mjs'),'run','--config',config,...files,...filters,'--reporter=json','--outputFile',resolve(output,'vitest.json')],
      {cwd:root,env:{...process.env,pnpm_config_verify_deps_before_run:'false',AGENTMUX_TOOLKIT_CLI:built.cli,
        AGENTMUX_TOOLKIT_EVIDENCE:output,AGENTMUX_TOOLKIT_MUTANT:mutant,AGENTMUX_TOOLKIT_ASSET:asset},timeout:180_000,maxBuffer:20*1024*1024}); stdout=value.stdout;stderr=value.stderr }
    catch(error) { exitCode=typeof error.code==='number'?error.code:-1;stdout=error.stdout??'';stderr=error.stderr??'' }
    await writeFile(resolve(output,'run.log'),stdout+stderr)
    const report=JSON.parse(await readFile(resolve(output,'vitest.json'),'utf8'))
    assert.ok(report.numTotalTests>0 && report.testResults.length>0,`${name}: actual collection must be nonempty`)
    for (const path of filters.length?files.filter(path=>path.endsWith('performance-toolkit-main.test.ts')):files) {
      const file = report.testResults.find(value => value.name === resolve(root,path))
      assert.ok(file && file.assertionResults.length > 0, `${name}: actual owning fixture must collect nonempty assertions: ${path}`)
    }
    const assertions=report.testResults.flatMap(file=>file.assertionResults)
    assert.ok(assertions.length>0)
    const loaded=(await readFile(resolve(output,'loaded-source.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loaded.length>0)
    const owns=[...loaded,...built.loaded,...assetLoaded].filter(value=>ownSources.includes(value.path))
    assert.ok(owns.length>0)
    for(const value of owns) assert.equal(value.originalSHA256,inputs[value.path],`${name}: loaded Source candidate drifted`)
    let oracle=[]
    if(expected) {
      assert.notEqual(exitCode,0,`${name}: mutant stayed GREEN`)
      const failures=assertions.filter(value=>value.status==='failed' && expected.test(value.fullName))
      assert.ok(failures.length>0 && failures.some(value=>value.failureMessages.some(message=>message.includes('AssertionError'))),`${name}: specific behavior AssertionRED required`)
      assert.ok(owns.some(value=>value.consumedSHA256!==value.originalSHA256),`${name}: actual source mutation must be consumed`)
      oracle=failures.map(value=>value.fullName)
    } else { assert.equal(exitCode,0,`${name}: GREEN required; inspect ${output}/run.log`);assert.equal(report.numFailedTests,0) }
    results.push({name,mutant,exitCode,collected:report.numTotalTests,oracle,reportSHA256:sha(await readFile(resolve(output,'vitest.json'))),loadedSHA256:sha(await readFile(resolve(output,'loaded-source.jsonl'))),
      cliSHA256:sha(await readFile(built.cli)),cliLoadedSHA256:sha(await readFile(resolve(dirname(built.cli),'loaded-source.jsonl')))})
    await rm(resolve(output,'cache'),{recursive:true,force:true})
    console.log(`${name}: ${expected?'AssertionRED':'GREEN'} (${report.numTotalTests} collected)`)
  }
  await run('baseline')
  await bridge('bridge-baseline')
  if(mode==='--mutations') {
    await run('registration','registration',/actual CLI\/help\/asset/u)
    await run('asset','asset',/actual CLI\/help\/asset/u)
    await run('shared','shared',/shares one actual port/u)
    await run('establish','establish',/ends a delayed partial/u)
    await run('framing','framing',/decodes split UTF8/u)
    await run('release','release',/shares one actual port/u)
    await run('dispatch','dispatch',/actual CLI\/help\/asset/u)
    await run('remove','remove',/actual CLI\/help\/asset/u)
    await run('terminal-kind','terminal-kind',/public terminal removal refuses both current/u)
    await run('terminal-metadata','terminal-metadata',/successful terminal retirement releases only/u)
    await run('renderer-owner','renderer-owner',/actual Renderer control consumer rejects all/u)
    await run('packaged-path','packaged-path',/actual production asset helper/u)
    await run('utf8','utf8',/rejects malformed UTF8 watch bytes/u)
    await bridge('bridge-early-release','early-release')
    await bridge('bridge-node-crypto','node-crypto')
    await run('restored')
    await bridge('bridge-restored')
  }
  results.push({cliSHA256:sha(await readFile(candidate.cli)),cliSourceInputs:candidate.compiledInputs})
}
for(const [path,hash] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root,path))),hash,`Exact Source/proof restore; real tree must not mutate: ${path}`)
const receipt={schema:'agentmux.performance-toolkit-source-proof.v1',completed:true,mode,sourceIdentity:identity,inputs,
  sourceWriterUsed:false,mutationsInPrivateSourceTransformsOnly:true,mutationTransforms:['Vitest','esbuild-onLoad'],evidenceDirectory:evidence,results}
await writeFile(resolve(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
await writeFile(resolve(base,`${mode.slice(2)}-receipt.json`),JSON.stringify(receipt,null,2)+'\n')
console.log(`receipt: ${resolve(evidence,'receipt.json')}`)
