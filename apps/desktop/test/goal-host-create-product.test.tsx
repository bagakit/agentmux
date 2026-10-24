// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { demands, root, container, client, session, writes } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { directGoalRequest } from '../src/renderer/src/lib/goals-direct-pmo'
import { useAppStore } from '../src/renderer/src/store'

it('New Goal saves through the actual Main/public Host owner and retains its exact request when the discussion position is unavailable', async () => {
  await act(async () => root.render(<GlobalBoardSurface />))
  const button = container.querySelector<HTMLButtonElement>('[aria-label="New Goal"]')!
  expect(button.disabled).toBe(false)
  await act(async () => {
    button.click(); button.click()
    await vi.waitFor(() => expect(directGoalRequest()).toMatchObject({ phase: 'pmo', pending: false, error: expect.any(String) }))
  })
  const request = directGoalRequest()!
  const saved = (await demands.get(request.id))!
  expect(saved).toMatchObject({ id: request.id, title: 'Untitled goal', status: 'backlog', description: '' })
  expect(saved.creationOrigin?.operationId).toBe(request.creationOperationId)
  expect(saved.discussionOperationId).toEqual(expect.any(String))
  expect((await demands.list()).filter(goal => goal.id !== 'goal')).toHaveLength(1)
  expect(useAppStore.getState().demands[request.id]).toMatchObject({ id: request.id, title: saved.title })
  expect(container.querySelector('[data-direct-goal-id]')?.getAttribute('data-direct-goal-id')).toBe(request.id)
  expect(writes).toEqual([])
  expect((await client.agentSession(session.agentSessionId)).run).toEqual(session.run)
  expect(button.disabled).toBe(true)
})
