import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import { click, mount, mounted } from './conversation-fixture'
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; localStorage.clear(); vi.restoreAllMocks() })
describe('mobile Goal density public consumer', () => {
  it('refreshes Goals from the original public consumer through a named icon action and keeps the selected main workface', async () => {
    const rpc = vi.fn(async (method: string) => method === 'app.snapshot' ? { projects: [], unavailable: [] } : { goals: [] })
    const view = await mount(<MobileGoalsSurface visible connected client={{ forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: 'private-goals', ownerInstanceId: 'private-owner', protocolVersion: 2, processId: 1, ctxmux: null, availability: 'connected' }) } as any} />)
    const action = view.element.querySelector('[aria-label="刷新目标"]')!
    expect(action.querySelector('svg')).not.toBeNull()
    await click(action)
    expect(rpc.mock.calls.filter(([method]) => method === 'goal.ls')).toHaveLength(2)
    expect(view.element.querySelector('h1')?.textContent).toBe('Goals')
  })
})
