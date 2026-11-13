import { expect, it } from 'vitest'
import type { Demand } from '@agentmux/demand'
import { goalSupervisorHost, isGoalSupervisor } from '../src/goal-supervisor-identity.js'
const goal = { supervisorSessionId: 'supervisor', plan: { history: [{ author: { kind: 'agent', id: 'supervisor', hostId: 'remote-b', runtimeId: 'runtime-b' } }] } } as Demand

it('keeps a Supervisor on a remote Host and accepts its canonical Runtime through another route alias', async () => {
  expect(await goalSupervisorHost(goal, {})).toBe('remote-b')
  expect(await isGoalSupervisor(goal, { actor: { kind: 'agent', id: 'supervisor' }, hostId: 'remote-b', runtimeId: 'runtime-b' }, {})).toBe(true)
  expect(await isGoalSupervisor(goal, { actor: { kind: 'agent', id: 'supervisor' }, hostId: 'second-b-alias', runtimeId: 'runtime-b' }, {})).toBe(true)
  expect(await isGoalSupervisor(goal, { actor: { kind: 'agent', id: 'supervisor' }, hostId: 'remote-b', runtimeId: 'other-runtime' }, {})).toBe(false)
})

it('preserves exact old Supervisor Host evidence without guessing a local relationship', async () => {
  const original = { ...goal, plan: undefined, delegations: [{ ownerAgentSessionId: 'supervisor', hostId: 'remote-b' }] } as Demand
  expect(await isGoalSupervisor(original, { actor: { kind: 'agent', id: 'supervisor' }, hostId: 'remote-b' }, {})).toBe(true)
  expect(await isGoalSupervisor(original, { actor: { kind: 'agent', id: 'supervisor' }, hostId: 'local' }, {})).toBe(false)
  const unknown = { supervisorSessionId: 'supervisor' } as Demand
  await expect(goalSupervisorHost(unknown, {})).rejects.toThrow('not yet confirmed')
  expect(await goalSupervisorHost(unknown, { resolveGoalAgent: async () => ({ hostId: 'remote-b' }) })).toBe('remote-b')
})
