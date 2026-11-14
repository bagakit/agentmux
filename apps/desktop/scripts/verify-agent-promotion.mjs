import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, symlink, readdir, mkdtemp, copyFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { repository, workspaceSources } from './fixtures/topic-promotion/source-build.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'
import { buildWorkspaceMoveHelper } from '../../host/scripts/build-workspace-move-helper.mjs'
const { build } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('esbuild')
const checks = process.argv.find(arg => arg.startsWith('--checks='))?.slice('--checks='.length) ?? 'all'
assert.ok(['core','host','ui','all'].includes(checks),'Choose a nonempty known verification scope')
const output = join(repository,'.tmp/agent-mote-promotion/owner-'+Date.now()), sources=new Set(), results=[]
await mkdir(output,{recursive:true})
const identityRuntime = join(output,'identity-runtime.ts')
await writeFile(identityRuntime,`export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`)
const identityPlugin = { name:'promotion-own-identity', setup(builder) { builder.onResolve({filter:/^@agentmux\/identity\/runtime-source$/},()=>({path:identityRuntime})) } }
async function run(command,args,env={}) {
 const child=spawn(command,args,{cwd:repository,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
 const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes)});return {code,stdout,stderr}
}
if(checks==='core'||checks==='all') {
 const result=await run(join(repository,'node_modules/.bin/vitest'),['run','--config','packages/core/test/agent-promotion.config.mts'])
 await writeFile(join(output,'core.log'),result.stdout+result.stderr);assert.equal(result.code,0,result.stdout+result.stderr);console.log(result.stdout)
 for(const mutant of ['source-zone-binding','foreign-receipt','omit-owner']) {
  const changed=await run(join(repository,'node_modules/.bin/vitest'),['run','--config','packages/core/test/agent-promotion.config.mts'],{AGENT_PROMOTION_CORE_MUTANT:mutant,NO_COLOR:'1'})
  await writeFile(join(output,'core-'+mutant+'.log'),changed.stdout+changed.stderr)
  assert.notEqual(changed.code,0,'Core production mutation survived: '+mutant)
  assert.match(changed.stdout+changed.stderr,/FAIL|AssertionError/u);assert.doesNotMatch(changed.stdout+changed.stderr,/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|No test files found/u)
  results.push({name:'core-'+mutant,code:changed.code});console.log('core-'+mutant+': '+changed.code)
 }
}
if(checks==='host'||checks==='all') {
 await mkdir(join(output,'node_modules'))
 for(const name of await readdir(join(repository,'packages/core/node_modules'))) {
  if(name.startsWith('.'))continue
  if(name.startsWith('@')) {await mkdir(join(output,'node_modules',name));for(const child of await readdir(join(repository,'packages/core/node_modules',name)))await symlink(join(repository,'packages/core/node_modules',name,child),join(output,'node_modules',name,child),'dir')}
  else await symlink(join(repository,'packages/core/node_modules',name),join(output,'node_modules',name),'dir')
 }
 await mkdir(join(output,'node_modules/@agentmux/core/dist'),{recursive:true});await copyFile(join(repository,'packages/core/package.json'),join(output,'node_modules/@agentmux/core/package.json'))
 async function bundle(entry,outfile,mutation) {
  const result=await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',target:'node24',plugins:[{ name:'preserve-original-entry-guards', setup(builder) { builder.onLoad({filter:/\.ts$/}, async args => { if(args.path===entry) return; const source=await readFile(args.path,'utf8'); const before='pathToFileURL(resolve(process.argv[1])).href === import.meta.url'; if(!source.includes(before)) return; return {contents:source.replaceAll(before,'pathToFileURL(resolve(process.argv[1])).href === '+JSON.stringify(pathToFileURL(args.path).href)),loader:'ts'} }) } },identityPlugin,workspaceSources(mutation)],metafile:true,logLevel:'warning',banner:{js:"import{createRequire as __promotionRequire}from'node:module';const require=__promotionRequire(import.meta.url);"}})
  for(const path of Object.keys(result.metafile.inputs))if(!path.includes('node_modules'))sources.add(path)
 }
 await bundle(join(repository,'packages/core/src/control-endpoint-listener-worker.ts'),join(output,'node_modules/@agentmux/core/dist/control-endpoint-listener-worker.js'))
 const cli=join(output,'cli.mjs');await bundle(join(repository,'packages/core/src/agentmux.ts'),cli)
 const helper=(await buildWorkspaceMoveHelper()).output,fixture=join(repository,'apps/desktop/scripts/fixtures/agent-promotion')
 const mutants=process.argv.includes('--baseline-only')?[null]:[null,
  {name:'disabled-admission',path:'apps/host/src/agent-promotion.ts',before:'await assertPromotionEnabled(this.ports.configurationPath)',after:'/* mutation: disabled admission ignored */'},
  {name:'broad-membership',path:'packages/core/src/agent-promotion.ts',before:'  const next = structuredClone(graph)\n  next.tabs.push',after:'  const next = structuredClone(graph)\n  next.bindings.push({spaceId:input.spaceId,zoneId:sourceTab.zoneId!})\n  next.tabs.push'},
  {name:'personality-durability',path:'apps/host/src/agent-promotion.ts',before:'await this.ports.scratch.prepareMotePromotion(record.workspace, record.topicId)',after:'/* mutation: skip original personality durability owner */'},
  {name:'nested-owner',path:'apps/host/src/promotion-agent-inspection.ts',before:"result.routeHostId !== 'local' || ",after:''},
  {name:'standing-maintenance',path:'apps/host/src/agent-promotion.ts',before:'presence: { ...DEFAULT_MOTE_PRESENCE, enabled: false }',after:'presence: { ...DEFAULT_MOTE_PRESENCE, enabled: true }'}]
 for(const mutation of mutants) {
  const name=mutation?.name??'baseline',host=join(output,name+'.mjs'),data=await mkdtemp('/tmp/amx-agent-promote-')
  await bundle(join(fixture,'host.ts'),host,mutation)
  const result=await run(process.execPath,[join(fixture,'scenario.mjs'),data,host,cli,helper])
  await writeFile(join(output,name+'.log'),result.stdout+result.stderr)
  if(!mutation) {assert.equal(result.code,0,result.stdout+result.stderr);await copyFile(join(data,'result.json'),join(output,'result.json'))}
  else {assert.ok(mutation.loaded,'Actual source mutation loaded');assert.notEqual(result.code,0,'Production mutation survived: '+name);assert.match(result.stderr,/AssertionError \[ERR_ASSERTION\]/u);assert.doesNotMatch(result.stderr,/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/u)}
  await rm(data,{recursive:true,force:true});results.push({name,code:result.code,mutation:mutation?{path:mutation.path,before:mutation.before,after:mutation.after}:null});console.log(name+': '+result.code)
 }
}
if(checks==='ui'||checks==='all') {
 const result=await run(join(repository,'node_modules/.bin/vitest'),['run','--config','apps/desktop/test/agent-promotion-ui.config.mts'])
 await writeFile(join(output,'ui.log'),result.stdout+result.stderr);assert.equal(result.code,0,result.stdout+result.stderr);console.log(result.stdout)
 for(const mutant of ['settings-save','continue-disabled','original-intent','header-menu']) {
  const changed=await run(join(repository,'node_modules/.bin/vitest'),['run','--config','apps/desktop/test/agent-promotion-ui.config.mts'],{AGENT_PROMOTION_UI_MUTATION:mutant,NO_COLOR:'1'})
  await writeFile(join(output,'ui-'+mutant+'.log'),changed.stdout+changed.stderr)
  assert.notEqual(changed.code,0,'UI production mutation survived: '+mutant)
  assert.match(changed.stdout+changed.stderr,/AssertionError/u);assert.doesNotMatch(changed.stdout+changed.stderr,/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|No test files found/u)
  results.push({name:'ui-'+mutant,code:changed.code});console.log('ui-'+mutant+': '+changed.code)
 }
}
const sourceDigests={};for(const file of [...sources].sort())sourceDigests[file]=createHash('sha256').update(await readFile(join(repository,file))).digest('hex')
await writeFile(join(output,'receipt.json'),JSON.stringify({passed:true,checks,results,sourceDigests},null,2))
console.log('evidence: '+relative(repository,output))
