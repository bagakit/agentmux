import type { AgentMuxRpcClient } from './public-rpc-client.js'
import { parseNameControlParams, parseNameControlResult, type NameControlParams } from './name-control.js'

/** Finite business client. It never probes a Run, retries a write or supplies a caller identity. */
export function createNameControlClient(rpc: Pick<AgentMuxRpcClient, 'call'>) {
  return {
    async inspectMember(value: NameControlParams['space.member.name.inspect']) {
      const input = parseNameControlParams('space.member.name.inspect', value)
      return parseNameControlResult('space.member.name.inspect', await rpc.call('space.member.name.inspect', input), input)
    },
    async changeMember(value: NameControlParams['space.member.name.change']) {
      const input = parseNameControlParams('space.member.name.change', value)
      return parseNameControlResult('space.member.name.change', await rpc.call('space.member.name.change', input), input)
    },
    async inspectAgent(value: NameControlParams['agent.name.inspect']) {
      const input = parseNameControlParams('agent.name.inspect', value)
      return parseNameControlResult('agent.name.inspect', await rpc.call('agent.name.inspect', input), input)
    },
    async changeAgent(value: NameControlParams['agent.name.change']) {
      const input = parseNameControlParams('agent.name.change', value)
      return parseNameControlResult('agent.name.change', await rpc.call('agent.name.change', input), input)
    },
  }
}
