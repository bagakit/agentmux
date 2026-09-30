import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const base = resolve(root,'.bagakit/design/toolkit-performance-20261004/preferences')
await mkdir(base,{recursive:true})
const evidence = await mkdtemp(resolve(base,'run-'))
const mode = process.argv[2]
assert.ok(['--tests','--unit','--mutations','--callers'].includes(mode))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const own = ['apps/desktop/src/shared/toolkit-preferences.ts','apps/desktop/src/shared/config-edit.ts',
  'apps/desktop/src/main/config-store.ts','apps/desktop/src/main/settings/modules/toolkit.ts',
  'apps/desktop/src/main/settings/setting-catalog.ts','apps/desktop/src/main/settings-control.ts',
  'apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/toolkit.tsx',
  'apps/desktop/src/renderer/src/components/settings/settings-modules.ts',
  'apps/desktop/src/renderer/src/styles/settings-toolkit.css']
const proof = ['apps/desktop/scripts/fixtures/toolkit-preferences/vitest.config.mts',
  'apps/desktop/scripts/verify-toolkit-preferences.mjs','apps/desktop/test/toolkit-preferences-control.test.ts',
  'apps/desktop/test/toolkit-preferences-draft.test.tsx']
const inputs = {}
for(const path of [...own,...proof]) {
  const bytes=await readFile(resolve(root,path));assert.ok(bytes.length>0,path);inputs[path]=sha(bytes)
  const target=resolve(evidence,'inputs',path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes)
}
const results=[]
if(mode==='--callers') {
  const edges=[]
  for(const [definition,caller] of [
    ['apps/desktop/src/main/settings/modules/toolkit.ts','apps/desktop/src/main/settings/setting-catalog.ts'],
    ['apps/desktop/src/renderer/src/components/settings/modules/toolkit.tsx','apps/desktop/src/renderer/src/components/settings/settings-modules.ts']
  ]) {
    const defined=await readFile(resolve(root,definition),'utf8'), consumed=await readFile(resolve(root,caller),'utf8')
    const symbol=defined.match(/export const (\w+)/u)?.[1];assert.ok(symbol)
    const matches=consumed.split('\n').filter(line=>!line.trim().startsWith('import')&&new RegExp(`\\b${symbol}\\b`,'u').test(line))
    assert.ok(matches.length>0,`Nonempty product composition for ${symbol}`);assert.notEqual(definition,caller)
    edges.push({definition,caller,symbol,matches})
  }
  const pane=await readFile(resolve(root,own[7]),'utf8')
  assert.ok(pane.includes('<ToolkitSettingsPane ')&&pane.includes('api.config.save('))
  edges.push({definition:own[6],caller:own[7],matches:['<ToolkitSettingsPane','api.config.save']})
  assert.ok(edges.length>0);results.push({edges})
} else {
  const require=createRequire(resolve(root,'packages/core/package.json'))
  const {build}=require('esbuild')
  const dir=resolve(evidence,'cli');await mkdir(dir)
  await symlink(resolve(root,'packages/core/node_modules'),resolve(dir,'node_modules'),'dir')
  const cli=resolve(dir,'agentmux.mjs'),compiledInputs={}
  await build({entryPoints:[resolve(root,'packages/core/src/agentmux.ts')],outfile:cli,bundle:true,
    platform:'node',format:'esm',target:'node24',packages:'external',plugins:[{name:'bind-own-cli-source',setup(builder){
      builder.onLoad({filter:/\.(ts|json)$/},async args=>{
        if(!args.path.startsWith(root+'/packages/'))return
        const bytes=await readFile(args.path),path=relative(root,args.path)
        compiledInputs[path]=sha(bytes)
        const target=resolve(dir,'inputs',path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes)
        return{contents:bytes.toString(),loader:args.path.endsWith('.json')?'json':'ts'}
      })
    }}]})
  assert.ok(compiledInputs['packages/core/src/agentmux.ts']);assert.ok(Object.keys(compiledInputs).length>0)
  await writeFile(resolve(dir,'inputs.json'),JSON.stringify(compiledInputs,null,2)+'\n')
  const exec=promisify(execFile)
  async function run(name,mutant='baseline') {
    const out=resolve(evidence,name);await mkdir(out)
    let code=0,stdout='',stderr=''
    try{const result=await exec('pnpm',['exec','vitest','run','--config','apps/desktop/scripts/fixtures/toolkit-preferences/vitest.config.mts',
      '--reporter=json','--outputFile',resolve(out,'vitest.json')],{cwd:root,timeout:120_000,maxBuffer:8*1024*1024,
      env:{...process.env,pnpm_config_verify_deps_before_run:'false',AGENTMUX_TOOLKIT_PREFERENCES_CLI:cli,
        AGENTMUX_TOOLKIT_PREFERENCES_EVIDENCE:out,AGENTMUX_TOOLKIT_PREFERENCES_MUTANT:mutant}});stdout=result.stdout;stderr=result.stderr}
    catch(error){code=typeof error.code==='number'?error.code:-1;stdout=error.stdout??'';stderr=error.stderr??''}
    await writeFile(resolve(out,'run.log'),stdout+stderr)
    const report=JSON.parse(await readFile(resolve(out,'vitest.json'),'utf8'))
    assert.ok(report.numTotalTests>0&&report.testResults.length>0,'Actual owning test collection must be nonempty')
    for(const path of proof.filter(path=>/\.test\.tsx?$/u.test(path))) {
      const file=report.testResults.find(file=>file.name===resolve(root,path));assert.ok(file?.assertionResults.length>0,path)
    }
    const failures=report.testResults.flatMap(file=>file.assertionResults.filter(test=>test.status==='failed'))
    if(mutant==='baseline')assert.equal(code,0,stdout+stderr)
    else{
      assert.notEqual(code,0,`${mutant}: mutant must be RED`)
      const owning = {
        composition: 'Toolkit preferences on the unique durable owner the actual compiled CLI reads and writes the same registered owner and disk',
        expectation: 'Toolkit preferences in the real Settings consumer reaches the contributed page and saves first absent preferences through its unique owner',
        defaults: 'Toolkit preferences in the real Settings consumer reaches the contributed page and saves first absent preferences through its unique owner'
      }
      const failure = failures.find(test => test.fullName === owning[mutant])
      assert.ok(failure, `${mutant}: exact owning outcome must fail`)
      assert.ok(failure.failureMessages.some(message => message.includes('AssertionError')), `${mutant}: owning outcome must be AssertionRED`)
      assert.ok(failure.failureMessages.some(message => message.includes(mutant === 'composition' ? 'frame' : mutant === 'expectation' ? 'statusBar' : 'to be null')), `${mutant}: exact product outcome, not a call argument or setup, must fail`)
      const loaded=(await readFile(resolve(out,'loaded-source.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
      assert.ok(loaded.some(input=>input.mutant===mutant&&input.originalSHA256!==input.consumedSHA256),'Actual product Source mutation must be loaded')
    }
    const result={name,mutant,code,tests:report.numTotalTests,failed:failures.map(test=>test.fullName)};results.push(result)
  }
  await run('control')
  if(mode==='--mutations')for(const mutant of ['composition','expectation','defaults']){await run(mutant,mutant);await run(`restored-${mutant}`)}
  if(mode==='--unit'){
    const visualPath=process.env.AGENTMUX_TOOLKIT_PREFERENCES_VISUAL_RECEIPT??resolve(base,'visual-pass.json')
    const visual=JSON.parse(await readFile(visualPath,'utf8'))
    assert.equal(visual.aestheticReview,'PASS','Actual independent visual review required')
    assert.ok(visual.images.length>=4,'Full light/dark wide/narrow images required')
    for(const path of ['apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx',
      'apps/desktop/src/renderer/src/components/settings/modules/toolkit.tsx','apps/desktop/src/renderer/src/styles/settings-toolkit.css']){
      assert.equal(visual.inputs[path],inputs[path],`Visual Source must match: ${path}`)
    }
    for(const item of visual.images)assert.equal(sha(await readFile(item.path)),item.sha256,'Actual full PNG bytes must remain exact')
    results.push({visualPath,review:visual.aestheticReview})
  }
}
for(const [path,hash] of Object.entries(inputs))assert.equal(sha(await readFile(resolve(root,path))),hash,`Input changed during proof: ${path}`)
await writeFile(resolve(evidence,'receipt.json'),JSON.stringify({mode,inputs,results},null,2)+'\n')
process.stdout.write(JSON.stringify({mode,evidence,results})+'\n')
