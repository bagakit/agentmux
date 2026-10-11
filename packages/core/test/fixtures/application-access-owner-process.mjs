import { join } from 'node:path'
import { AgentMuxApplicationAccessOwner,AgentMuxControlServer,LocalExecutionHost } from '../../dist/index.js'
const root=process.argv[2],executionHost=new LocalExecutionHost()
const owner=new AgentMuxApplicationAccessOwner({path:join(root,'access.sqlite'),async resolveHost(hostId){if(!['source','target'].includes(hostId))throw new Error('Wrong Host');return {executionHost,runtimeId:'original-runtime',assertCurrent(){}}}})
const server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),coreClients:()=>[],applicationAccess:owner})
await server.start();process.send({ready:true,endpoint:server.path})
process.once('SIGTERM',async()=>{await server.stop();await owner.dispose();process.exit(0)})
