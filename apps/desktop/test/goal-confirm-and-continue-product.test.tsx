// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { container, fixture, mount, settle } from './helpers/goal-responsibility-product'
import { prepareSourceCoreCli } from './helpers/source-core-cli.mjs'

const goalId = 'goal'
const recipient = { hostId: 'local', agentSessionId: 'owner' }
const goal = () => useAppStore.getState().demands[goalId]!
const approve = () => container.querySelector<HTMLButtonElement>('[data-goal-confirm]')!
const notification = () => container.querySelector('[data-goal-confirmation-notification]')
async function openGoal(f: Awaited<ReturnType<typeof fixture>>) {
  await act(async () => {
    await useAppStore.getState().refreshDemand(goalId)
    useAppStore.setState({ selectedDemandId: goalId, mainSurface: 'board', sessions: f.projectSessions() })
  })
  await mount(createElement(GlobalBoardSurface))
}

it('confirms the displayed proposal and sends one original notification after the Supervisor input clears', async () => {
  const f = await fixture({ patrol: true, addressable: true })
  f.patrolState.inputOccupied = true
  await openGoal(f)
  expect(approve().getAttribute('aria-label')).toMatch(/^Confirm goal and let .+ continue$/u)
  expect(approve().querySelector('[data-goal-confirm-agent]')).toBeTruthy()
  expect((await f.demands.get(goalId))!.alignment?.confirmedAt).toBeNull()
  await act(async () => { approve().click(); approve().click() })
  await vi.waitFor(() => expect(notification()?.textContent).toContain('Waiting to notify Supervisor'))
  await f.flushPatrol()
  const saved = (await f.demands.get(goalId))!
  expect(saved.alignment?.confirmedAt).toBeGreaterThan(0)
  expect(saved.patrols).toHaveLength(1)
  expect(saved.patrols?.[0]).toMatchObject({ purpose: 'confirmation', supervisorAgentSessionId: 'owner', recipientHostId: 'local',
    alignment: { revision: 1, confirmedAt: saved.alignment?.confirmedAt } })
  expect(f.nativeWrites).toHaveLength(0)
  expect(saved.dispatches ?? []).toEqual([])

  const original = saved.patrols![0]!
  const cli = await prepareSourceCoreCli()
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli.cliPath, '--endpoint', 'unix:' + f.socketPath, 'goal', 'confirm',
      '--goal', goalId, '--revision', '1', '--continue-with', JSON.stringify(recipient), '--operation-id', original.operationId])
    expect(JSON.parse(stdout).result.goal.patrols).toMatchObject([{ operationId: original.operationId, purpose: 'confirmation' }])
  } finally { await cli.cleanup() }
  expect((await f.demands.get(goalId))!.patrols).toHaveLength(1)
  await f.restartPatrol()
  f.patrolState.inputOccupied = false
  await act(async () => { f.emit('owner'); await f.flushPatrol(); await settle() })
  await vi.waitFor(() => expect(notification()?.getAttribute('data-goal-confirmation-notification')).toBe('delivered'))
  const delivered = (await f.demands.get(goalId))!.patrols![0]!.attempts[0]!
  expect(JSON.parse(delivered.agentMuxNote)).toMatchObject({ schema: 'agentmux.goal-confirmation.v1', goalId,
    goalUrl: goal().address?.goalUrl, alignmentRevision: 1, operationId: original.operationId })
  expect((await f.rpc.call('goal.delegations', { goalId })).patrolObservations).toMatchObject([{ operationId: original.operationId, state: 'delivered' }])
  const writes = f.nativeWrites.filter(write => write.data.includes('agentmux.goal-confirmation.v1'))
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ runId: 'owner-run' })
  expect(f.attempts).toHaveLength(1)
  await f.restartPatrol(); await f.flushPatrol()
  expect(f.attempts).toHaveLength(1)
}, 30_000)

it('keeps a saved confirmation and an unconfirmed notification without resending input', async () => {
  const f = await fixture({ patrol: true, addressable: true })
  f.patrolState.loseReceiptAfterSubmit = true
  f.patrolState.receiptUnavailable = true
  await openGoal(f)
  await act(async () => { approve().click(); await settle() })
  await vi.waitFor(() => expect(notification()?.textContent).toContain('notification unconfirmed'))
  await f.flushPatrol()
  expect((await f.demands.get(goalId))!.alignment?.confirmedAt).toBeGreaterThan(0)
  expect(f.nativeWrites.filter(write => write.data.includes('agentmux.goal-confirmation.v1'))).toHaveLength(1)
  await act(async () => {
    await f.restartPatrol()
    f.patrolState.receiptUnavailable = false
    notification()!.querySelector('button')!.click()
    await f.flushPatrol()
  })
  await vi.waitFor(() => expect(notification()?.getAttribute('data-goal-confirmation-notification')).toBe('delivered'))
  expect(f.attempts).toHaveLength(1)
}, 30_000)

it('still confirms the proposal when no original Supervisor is assigned', async () => {
  const f = await fixture({ patrol: true, addressable: true })
  await f.demands.update(goalId, { supervisorSessionId: null })
  await openGoal(f)
  expect(approve().textContent).toBe('Confirm goal')
  expect(approve().querySelector('[data-goal-confirm-agent]')).toBeNull()
  await act(async () => approve().click())
  await vi.waitFor(() => expect(goal().alignment?.confirmedAt).toBeGreaterThan(0))
  expect((await f.demands.get(goalId))!.patrols ?? []).toEqual([])
  expect(f.nativeWrites).toEqual([])
})

it('keeps a superseded notice but sends nothing across a Goal revision change', async () => {
  const f = await fixture({ patrol: true, addressable: true })
  f.patrolState.inputOccupied = true
  await openGoal(f)
  await act(async () => { approve().click(); await settle() })
  await vi.waitFor(() => expect(notification()).toBeTruthy())
  await f.flushPatrol()
  const saved = (await f.demands.get(goalId))!.patrols![0]!
  await f.demands.proposeAlignment(goalId, { summary: 'The person has yet to confirm this new proposal.',
    criteria: [{ id: 'AC', text: 'Check the revised target.' }], openQuestions: [] })
  f.patrolState.inputOccupied = false
  await act(async () => { f.emit('owner'); await f.flushPatrol() })
  expect(f.attempts).toHaveLength(0)
  expect((await f.rpc.call('goal.delegations', { goalId })).patrolObservations).toMatchObject([{ operationId: saved.operationId, state: 'stale' }])
  expect((await f.demands.get(goalId))!.alignment).toMatchObject({ revision: 2, confirmedAt: null })
}, 30_000)
