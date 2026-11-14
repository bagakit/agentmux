import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import { generateKeyPair, exportPublicKey } from '@agentmux/relay/e2ee'
import { connectAgentMuxRpc } from '../../../../../packages/core/dist/public-rpc-client.js'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export async function privateCore(options = {}) {
 const deviceKeyPair = generateKeyPair(), relays = []
 const directory = await mkdtemp('/tmp/amux-mesh-ui-')
 const runtime = join(directory,'r'), state = join(directory,'s')
 await Promise.all([mkdir(runtime,{mode:0o700}),mkdir(join(state,'ctxmux'),{recursive:true,mode:0o700}),mkdir(join(directory,'home'),{mode:0o700})])
 const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_'))), HOME:join(directory,'home'), AGENTMUX_RUNTIME_DIRECTORY:runtime, AGENTMUX_STATE_DIRECTORY:state, AGENTMUX_AGENT_SESSION_STORE:join(state,'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH:join(state,'messages.ndjson') }
 let native, core, client; const children=[]
 const stop = async child => { if (child?.pid && child.exitCode===null && child.signalCode===null) { child.kill('SIGTERM'); await once(child,'exit') } }
 async function close() { for(const relay of relays)await relay.dispose();await client?.dispose(); await stop(core); await stop(native); await rm(directory,{recursive:true,force:true}) }
 try {
  native = spawn(resolve(root,'packages/core/vendor/ctxmux',`${process.platform}-${process.arch}`,'bin/ctxmuxd'),['--socket',join(runtime,'ctxmux.sock'),'--state-dir',join(state,'ctxmux'),'--readiness-fd','3'],{env,stdio:['ignore','ignore','pipe','pipe']}); children.push(native)
  let nativeErrors='';native.stderr.on('data',d=>{nativeErrors+=String(d)})
  await new Promise((yes,no)=>{ const timer=setTimeout(()=>no(Error('Private Native readiness timed out')),30000);native.stdio[3].once('data',()=>{clearTimeout(timer);yes()});native.once('error',e=>{clearTimeout(timer);no(e)});native.once('exit',code=>{clearTimeout(timer);no(Error('Private Native exited '+code+': '+nativeErrors))}) })
  core=spawn(process.execPath,options.host ? ['--experimental-transform-types','--import',resolve(root,'apps/host/test/mobile-web-node-loader.mjs'),resolve(root,'apps/host/test/fixtures/mobile-web-host.mjs')] : [resolve(root,'packages/core/dist/headless-runtime-cli.js'),'serve'],{env,stdio:['ignore','pipe','pipe']});children.push(core)
  let errors='';core.stderr.on('data',d=>{errors+=String(d)})
  const receipt=await new Promise((yes,no)=>{let output='';const timer=setTimeout(()=>no(Error('Private Core readiness timed out: '+errors)),30000);core.stdout.on('data',d=>{output+=String(d);if(output.includes('\n')){clearTimeout(timer);try{yes(JSON.parse(output.split('\n')[0]))}catch(e){no(e)}}});core.once('error',e=>{clearTimeout(timer);no(e)});core.once('exit',code=>{clearTimeout(timer);no(Error('Private Core exited '+code+': '+errors))})})
  client=await connectAgentMuxRpc({endpoint:{transport:'unix',path:receipt.socketPath}})
  for(let i=0;i<200;i++){const value=await client.call('settings.mesh.inspect',{});if(value.identity) return {client,close,directory,readOffer:parseConnectionOfferUrl,devicePublicKey:exportPublicKey(deviceKeyPair.publicKey),relay:async offer=>{const connection=await connectAgentMuxRpc({endpoint:{transport:'relay',offer},relayKeyPair:deviceKeyPair});relays.push(connection);return connection},pids:children.map(child=>child.pid),socketPath:receipt.socketPath,owner:receipt.owner};await new Promise(done=>setTimeout(done,20))}
  throw Error('Original Mesh identity unavailable')
 } catch(error) { await close();throw error }
}
