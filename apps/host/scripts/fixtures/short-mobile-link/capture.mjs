import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from '../../../../desktop/scripts/probe-process.mjs'
const root = resolve(import.meta.dirname, '../../../../..'), require = createRequire(join(root,'apps/mobile/package.json'))
const desktopRequire = createRequire(join(root,'apps/desktop/package.json')), { build: viteBuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { build } = createRequire(join(root,'packages/core/package.json'))('esbuild')
const output = resolve(process.argv[2] ?? join(root,'.tmp/mobile-next/short-path-processes')), compiled = join(output,'compiled')
await mkdir(output,{recursive:true})
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = {}, transforms = {}, receipt = { passed:false, inputs, transforms, processes:[], boundary:'Two private Chromium OS processes use one actual HTTP origin, actual short immutable namespace and original main/Root/App/storage. Original product SDK facts are controlled and its draft is prepared through DeviceWorkface before mounting, not a live Relay or user App.' }
let server, pendingMetadata, reads = 0
try {
  const fixture = join(root,'apps/mobile/scripts/fixtures/mobile-product-redesign/product-entry.tsx'), original = await readFile(fixture,'utf8')
  let leaf = original.slice(0,original.indexOf('function Scene()'))
  assert.ok(leaf.length > 0 && original.includes('function Scene()'))
  leaf = leaf.replace("import { MobileApp } from '../../../src/MobileApp'", '')
  const seed = /if \(!localStorage\.getItem\('mobile-product-fixture-initialized'\)\) \{[\s\S]*?\n\}/u
  assert.ok(seed.test(leaf)); leaf = leaf.replace(seed,'') + '\nexport {client,calls};\n'
  receipt.fixture = { file:relative(root,fixture), originalSHA256:sha(original), loadedSHA256:sha(leaf), purpose:'Reuse original SDK facts before Scene; remove its file-origin seed and retain actual main/Root/App mounting.' }
  const sdk = `export * from ${JSON.stringify(join(root,'packages/core/src/relay-hosted.ts'))};
import {client,calls} from 'short-link-original-client';
import {getDeviceWorkface} from ${JSON.stringify(join(root,'apps/mobile/src/recovery/device-workface.ts'))};
import {existingDeviceRelayIdentity} from ${JSON.stringify(join(root,'apps/mobile/src/connection/relay-identity.ts'))};
import {mobileWebPageIdentity} from ${JSON.stringify(join(root,'apps/mobile/src/mobile-web/page-identity.ts'))};
localStorage.setItem('agentmux-mobile-home','mote');
if(!localStorage.getItem('agentmux.connection-offer.v2'))await getDeviceWorkface().updateConversation({version:1,drafts:[[JSON.stringify(['draft','session-mote']),'原短链接草稿跨进程保留']],attempts:[],responses:[]});
client.connect=async()=>{};client.dispose=async()=>{calls.push({method:'fixture.dispose'})};
export async function connectRelayHostedClient(input){calls.push({method:'fixture.connect',hostId:input.offer.serverId});return client}
window.shortLinkProbe={facts:()=>({record:getDeviceWorkface().snapshot().record,page:mobileWebPageIdentity(),offer:localStorage.getItem('agentmux.connection-offer.v2'),url:location.href,calls}),keyHash:async()=>{const key=await existingDeviceRelayIdentity();if(!key)throw Error('Original key unavailable');const bytes=new Uint8Array([...key.publicKey,...key.secretKey]);return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')}};`
  await viteBuild({ root:join(root,'apps/mobile'), configFile:join(root,'apps/mobile/vite.config.ts'), logLevel:'warn',
    define:{__AGENTMUX_MOBILE_PROVIDER_CATALOG__:'[]',__AGENTMUX_MOBILE_PROJECT_APPEARANCE__:'{"kind":"folder","icon":null}',__AGENTMUX_MOBILE_SETUP_RETENTION__:'null'},
    plugins:[{name:'short-path-original-product-leaf',enforce:'pre',resolveId(id){if(id==='@agentmux/core/relay-hosted')return '\0short-link-sdk';if(id==='short-link-original-client')return fixture+'?short-link-leaf'},load(id){if(id==='\0short-link-sdk')return sdk;if(id===fixture+'?short-link-leaf')return {code:leaf,map:null}},
      async transform(code,id){const file=id.split('?')[0];if(file.startsWith(root+'/')&&!file.includes('/node_modules/')&&!id.startsWith('\0')){const name=relative(root,file), original=sha(await readFile(file));inputs[name]=original;if(sha(code)!==original)transforms[name]={sourceSHA256:original,loadedSHA256:sha(code)}}}}],
    build:{outDir:compiled,emptyOutDir:true} })
  await symlink(join(root,'apps/host/node_modules'),join(output,'node_modules'),'dir').catch(error=>{if(error.code!=='EEXIST')throw error})
  const artifact=join(output,'assets-owner.mjs')
  const hostBuild=await build({entryPoints:[join(root,'apps/host/src/mobile-assets-owner.ts')],outfile:artifact,bundle:true,platform:'node',format:'esm',packages:'external',metafile:true,logLevel:'error'})
  for(const file of Object.keys(hostBuild.metafile.inputs))inputs[relative(root,resolve(file))]=sha(await readFile(resolve(file)))
  receipt.hostArtifactSHA256=sha(await readFile(artifact))
  const {MobileAssetsOwner}=await import(pathToFileURL(artifact).href), owner=new MobileAssetsOwner();await owner.initialize(compiled)
  const manifest=JSON.parse(await readFile(join(compiled,'mobile-release.json'),'utf8'));receipt.release={buildId:manifest.buildId,digest:manifest.digest}
  const publicKey=Buffer.alloc(32,7).toString('base64')
  server=createServer((request,response)=>{if(request.url==='/.well-known/agentmux/connection'){reads++;pendingMetadata=()=>{response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({v:2,serverId:'host-original',daemonPublicKeyB64:publicKey,relay:{endpoint:'127.0.0.1:'+server.address().port,useTls:false}}))};return}owner.route(request,response)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port
  const namespace='/m/'+Buffer.from(manifest.digest.slice(7),'hex').toString('base64url')+'/', pin=Buffer.concat([Buffer.from([4]),Buffer.alloc(32,7)]).toString('base64url')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  for(const phase of ['initial','restored']){
    const url=origin+namespace+(phase==='initial'?'#'+pin:'')
    const processReceipt=await runProbeProcess(desktopRequire('electron'),[join(import.meta.dirname,'main.cjs'),url,output,phase],{temporaryRoot:output,cwd:root,env,timeoutMs:45000,onLine:line=>{if(line==='short-link:metadata-painted'){assert.ok(pendingMetadata);pendingMetadata()}}})
    receipt.processes.push(processReceipt)
    const observed=JSON.parse(await readFile(join(output,phase+'.json'),'utf8'));assert.equal(observed.passed,true,JSON.stringify(observed.error));assert.equal(processReceipt.exitCode,0);assert.equal(observed.page.namespaceDigest,manifest.digest)
  }
  assert.equal(reads,1,'Saved same-origin reconnect does not perform public discovery')
  receipt.metadataReads=reads;receipt.passed=true
} catch(error){receipt.error={message:error.message,stack:error.stack};throw error}
finally{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,receipt:relative(root,join(output,'receipt.json'))}))}
