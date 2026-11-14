import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hashPublisherToken, parseRelayGatewayConfiguration, startRelayGateway } from './gateway.js'
import { acquireRelayMeshIdentity, inspectRelayMeshState, reconcileRelayMeshState, type RelayMeshStateInspection } from './mesh-state.js'
import { meshObject } from './mesh-protocol.js'

const usage = 'agentmux-relay serve --config FILE\nagentmux-relay identity --state ABSOLUTE_NEW_DIRECTORY\nagentmux-relay state inspect --state ABSOLUTE_DIRECTORY\nagentmux-relay state reconcile --state ABSOLUTE_DIRECTORY --expected FILE\nagentmux-relay secret\n\nserve reads its private configuration once and owns only its Relay listener/network. Mesh config selects meshStateDirectory; its exclusive OS advisory owner reserves a durable boot epoch before networking. identity reserves an epoch and prints public peer identity only. state inspect is read-only. Offline reconcile requires the complete exact owner/intent/key/epoch receipt and OS confirmation that the original local Node metadata writer no longer exists; guard-child exit alone is insufficient. Live/reused/unknown PID, absent owner or incomplete intent refuses recovery and preserves the marker. It obtains the same nonblocking OS guard and confirms durable readback without replaying a save or reconstructing its original acknowledgement. No automatic PID/clock-based takeover or process kill. macOS lockf or Linux flock is required for standalone Mesh state.\nsecret prints a new publisher credential and its SHA-256 hash; store the credential privately.\n'

export async function runRelayGatewayCli(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args.length === 1 && args[0] === '--help') { process.stdout.write(usage); return }
  if (args.length === 1 && args[0] === 'secret') {
    const token = randomBytes(32).toString('base64url')
    process.stdout.write(JSON.stringify({ token, tokenHash: hashPublisherToken(token) }) + '\n')
    return
  }
  if(args.length===3&&args[0]==='identity'&&args[1]==='--state'&&args[2]){
    const owner=await acquireRelayMeshIdentity(args[2])
    try{const {secretKey:_secretKey,...identity}=owner.identity;process.stdout.write(JSON.stringify({operation:'identity',...identity})+'\n')}
    finally{await owner.release()}
    return
  }
  if(args.length===4&&args[0]==='state'&&args[1]==='inspect'&&args[2]==='--state'&&args[3]){
    process.stdout.write(JSON.stringify(await inspectRelayMeshState(args[3]))+'\n');return
  }
  if(args.length===6&&args[0]==='state'&&args[1]==='reconcile'&&args[2]==='--state'&&args[3]&&args[4]==='--expected'&&args[5]){
    let expected:RelayMeshStateInspection
    try{expected=JSON.parse(await readFile(args[5],'utf8')) as RelayMeshStateInspection}catch{throw new Error('Mesh recovery requires its original valid JSON inspection receipt.')}
    process.stdout.write(JSON.stringify(await reconcileRelayMeshState(args[3],expected))+'\n');return
  }
  if (args.length !== 3 || args[0] !== 'serve' || args[1] !== '--config' || !args[2]) throw new Error('Expected serve --config FILE or secret.')
  const text = await readFile(args[2], 'utf8')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Relay gateway configuration is not valid JSON.') }
  let identityOwner:Awaited<ReturnType<typeof acquireRelayMeshIdentity>>|undefined
  const raw=meshObject(value,['host','port','publishers','mesh','meshStateDirectory'])
  if(raw.mesh!==undefined){
    if(typeof raw.meshStateDirectory!=='string')throw new Error('Mesh standalone requires its original absolute meshStateDirectory.')
    const mesh=meshObject(raw.mesh,['networkId','members','peers','advertisedIngress'])
    identityOwner=await acquireRelayMeshIdentity(raw.meshStateDirectory)
    value={...raw,mesh:{...mesh,identity:identityOwner.identity}}
    delete (value as Record<string,unknown>).meshStateDirectory
  }else if(raw.meshStateDirectory!==undefined)throw new Error('Mesh identity state requires an explicit Mesh configuration.')
  let gateway:Awaited<ReturnType<typeof startRelayGateway>>
  try{gateway=await startRelayGateway(parseRelayGatewayConfiguration(value))}
  catch(error){await identityOwner?.release();throw error}
  const observation=gateway.inspectMesh()
  process.stdout.write(JSON.stringify({ operation: 'serve', service: 'agentmux-relay', protocol: 2, host: gateway.host, port: gateway.port,
    ...(observation.identity?{mesh:{networkId:observation.networkId,identity:observation.identity}}:{}) }) + '\n')
  await new Promise<void>((resolve, reject) => {
    let stopping = false
    const stop = (cause?:Error) => {
      if (stopping) return
      stopping = true
      void (async()=>{
        let issue=cause
        try{await gateway.stop()}catch(error){issue??=error as Error}
        try{await identityOwner?.release()}catch(error){issue??=error as Error}
        if(issue)reject(issue);else resolve()
      })().finally(() => {
        process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
      })
    }
    const onSignal=()=>stop()
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
    void identityOwner?.ownerLost.then(error=>stop(error))
  })
}
