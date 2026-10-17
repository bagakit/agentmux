import { existsSync, unlinkSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux, AgentProviderRegistry } from '../../dist/index.js'
const original = new AgentProviderRegistry().get('codex')
const fixture = { ...original, reconnectTerminalFrontend: async (...args) => {
  appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'reconnect-operations.ndjson'), JSON.stringify(args[1])+'\n')
  const result = await original.reconnectTerminalFrontend(...args)
  const lost = join(process.env.AGENTMUX_STATE_DIRECTORY, 'lose-frontend-receipt')
  if (existsSync(lost)) { unlinkSync(lost); throw new Error('Private frontend receipt connection lost after the original action.') }
  return result
} }
const owner = await startHeadlessAgentMux({ providers:[fixture], socketPath:join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'headless.sock') })
let stopReservation, preparing=false
const stopRequest=join(process.env.AGENTMUX_STATE_DIRECTORY,'prepare-stop'),stopResult=join(process.env.AGENTMUX_STATE_DIRECTORY,'prepared-stop'),releaseRequest=join(process.env.AGENTMUX_STATE_DIRECTORY,'release-stop')
const preparation=setInterval(()=>{if(preparing)return;if(!existsSync(stopRequest)&&!existsSync(releaseRequest))return;preparing=true;void(async()=>{
 if(existsSync(releaseRequest)&&stopReservation){await owner.client.registry.releaseLifecycle(stopReservation);unlinkSync(releaseRequest);writeFileSync(stopResult,JSON.stringify({released:true}));stopReservation=undefined}
 if(existsSync(stopRequest)){const id=readFileSync(stopRequest,'utf8');unlinkSync(stopRequest);const session=owner.client.agentSession(id);const operation=await owner.client.kernel.prepareStop(session.run.runId);stopReservation=await owner.client.registry.reserveExisting('stop',id,session.run,'private-pending-stop',operation);writeFileSync(stopResult,JSON.stringify(stopReservation))}
})().catch(error=>{writeFileSync(stopResult,JSON.stringify({error:String(error)}))}).finally(()=>{preparing=false})},20)
preparation.unref()
process.once('exit',()=>clearInterval(preparation))
process.stdout.write(JSON.stringify({ owner:owner.ownerIdentity(), socketPath:owner.socketPath })+'\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
