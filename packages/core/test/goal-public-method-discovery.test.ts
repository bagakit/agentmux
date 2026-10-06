import { afterEach, describe, expect, it, vi } from 'vitest'

const methods = ['goal.delegation.prepare', 'goal.delegation.bind', 'goal.delegate', 'goal.report', 'goal.collect', 'goal.delegations'] as const
const entries = [
  ['Goal codec', () => import('../src/goal-delegation.js')],
  ['native codec', () => import('../src/rpc-native-codec.js')],
  ['public server', () => import('../src/public-rpc-server.js')],
  ['package entry', () => import('../src/index.js')]
] as const
afterEach(() => vi.resetModules())

describe('original public Goal method discovery through Source entry order', () => {
  it.each(entries)('keeps all exact Goal methods after loading %s first', async (_label, load) => {
    vi.resetModules()
    await load()
    const rpc = await import('../src/public-rpc.js'), goal = await import('../src/goal-delegation.js')
    expect(Object.keys(goal.GOAL_DELEGATION_METHODS).sort()).toEqual([...methods].sort())
    for (const method of methods) {
      expect(rpc.isAgentMuxRpcMethod(method), method).toBe(true)
      expect(rpc.AGENTMUX_RPC_NATIVE_METHODS[method], method).toBe('long')
      expect(goal.isGoalDelegationMethod(method), method).toBe(true)
    }
    expect(rpc.isAgentMuxRpcMethod('agent.send')).toBe(true)
    expect(rpc.isAgentMuxRpcMethod('goal.invented-method')).toBe(false)
    expect(goal.isGoalDelegationMethod('goal.invented-method')).toBe(false)
  })
})
