import { fileURLToPath } from 'node:url'
import { createAntigravityAcpActor } from '@agentmux/providers/antigravity/acp-actor'
import { AgentMuxError } from '../errors.js'
import { observeRead } from '../observation-read.js'
import { AgentMuxRpcLines, isRpcId, rpcEncode } from '../public-rpc-frame.js'

export const antigravityAcpFraming = { observeRead, AgentMuxRpcLines, isRpcId, rpcEncode }
export const antigravityAcpActor = createAntigravityAcpActor({ ...antigravityAcpFraming, AgentMuxError })

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await antigravityAcpActor.run(JSON.parse(process.argv[2]!)) }
  catch { process.exitCode = 1 }
}
