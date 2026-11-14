import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

const core=resolve(process.argv[2]??'packages/core'),output=process.argv[3]
assert.equal(JSON.parse(await readFile(join(core,'package.json'),'utf8')).name,'@agentmux/core')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),checks=[]
const cases=[
 ['public-rpc-client-first',`const m=await import(${JSON.stringify(pathToFileURL(join(core,'dist/public-rpc-client.js')).href)});if(typeof m.connectAgentMuxRpc!=='function')throw Error('The original SDK connect export is missing');console.log('original-public-SDK-imported')`],
 ['public-runtime-client-first',`const m=await import('@agentmux/core/runtime-client');if(typeof m.connectLocalAgentMuxRuntime!=='function')throw Error('The original public runtime client export is missing');console.log('original-runtime-client-imported')`],
 ['same-codec-owner',`await import(${JSON.stringify(pathToFileURL(join(core,'dist/public-rpc-client.js')).href)});const a=await import(${JSON.stringify(pathToFileURL(join(core,'dist/rpc-data.js')).href)}),b=await import(${JSON.stringify(pathToFileURL(join(core,'dist/rpc-business-codec.js')).href)});if(a.rpcRecord!==b.rpcRecord||a.rpcString!==b.rpcString)throw Error('The original codec owner was copied');console.log('same-original-codec-functions')`]
]
for(const[name,code]of cases){const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:core,encoding:'utf8',timeout:15000});checks.push({name,argv:[process.execPath,'--input-type=module','-e',code],exitCode:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr})}
const cli=spawnSync(process.execPath,[join(core,'bin/amux'),'--help'],{cwd:core,encoding:'utf8',timeout:15000})
checks.push({name:'original-CLI-help',argv:[process.execPath,join(core,'bin/amux'),'--help'],exitCode:cli.status,signal:cli.signal,error:cli.error?.message,stdout:cli.stdout,stderr:cli.stderr})
const passed=checks.every(c=>c.exitCode===0&&!c.signal&&!c.error),catalog=join(core,'dist/public-rpc-provider-catalog.js')
const report={passed,core,checks,catalog:{file:catalog,sha256:sha(await readFile(catalog))},boundary:'Each entry runs in its own fresh Node process. No client prewarm, Core/Runtime/Session construction, credentials changes or business request. CLI reads help only; codec export functions retain the original rpc-data identity.'}
if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({passed,checks:checks.map(c=>({name:c.name,exitCode:c.exitCode,signal:c.signal}))}))
if(!passed)process.exitCode=1
