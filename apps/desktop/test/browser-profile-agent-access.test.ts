import { describe, expect, it, vi } from 'vitest'
import { assertBrowserAutomation, createBrowserAutomationGate } from '../src/main/browser-automation-gate.js'
import { executeBrowserTaskControl } from '../src/main/browser-task-control.js'

/**
 * One automation gate, decided by who asks. The global switch applies to Agents and people alike. A
 * Profile's Agent switch only narrows Agent callers, and an unread Profile is unknown, never allowed.
 * Stop is never gated.
 */
function gate(overrides: { automation?: boolean; profileOf?: (id: string) => Promise<string | null>; agentAccess?: (id: string) => boolean | undefined } = {}) {
  const profileOf = vi.fn(overrides.profileOf ?? (async (id: string) => (id === 'b-private' ? null : id === 'b-guarded' ? 'p-guarded' : 'p-open')))
  const agentAccess = vi.fn(overrides.agentAccess ?? ((id: string) => id !== 'p-guarded'))
  return { profileOf, agentAccess, check: createBrowserAutomationGate({ automation: () => overrides.automation ?? true, profileOf, agentAccess }) }
}
const agent = { agentSessionId: 'agent-1' }

describe('Browser automation gate', () => {
  it('the global switch refuses Agents and people alike, by code', async () => {
    const { check, profileOf } = gate({ automation: false })
    for (const caller of [agent, undefined]) {
      await expect(check('b-open', caller)).rejects.toMatchObject({ code: 'BROWSER_AUTOMATION_DISABLED', message: expect.stringContaining('Settings › Browser') })
    }
    expect(profileOf).not.toHaveBeenCalled()
  })

  it('a Profile with Agents off refuses an Agent and still lets the person run', async () => {
    const { check, profileOf } = gate()
    await expect(check('b-guarded', agent)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_AGENT_ACCESS_OFF' })
    await expect(check('b-guarded', undefined)).resolves.toBeUndefined()
    await expect(check('b-open', agent)).resolves.toBeUndefined()
    // A person's run reads no Profile at all.
    expect(profileOf.mock.calls.map(([id]) => id)).toEqual(['b-guarded', 'b-open'])
  })

  it('the decision itself lets a person through a Profile with Agents off or an unread Profile', () => {
    for (const profile of [{ agentAccess: false }, 'unknown' as const]) {
      expect(() => assertBrowserAutomation({ kind: 'person' }, { automation: true, profile })).not.toThrow()
      expect(() => assertBrowserAutomation({ kind: 'agent', agentSessionId: 'agent-1' }, { automation: true, profile })).toThrow()
    }
  })

  it('a page without a Profile follows the global switch only', async () => {
    const { check, agentAccess } = gate()
    await expect(check('b-private', agent)).resolves.toBeUndefined()
    expect(agentAccess).not.toHaveBeenCalled()
  })

  it('an unread Profile or list is unknown and refuses an Agent instead of guessing it allowed', async () => {
    for (const unknown of [gate({ profileOf: async () => { throw new Error('saved Tabs unreadable') } }), gate({ agentAccess: () => undefined })]) {
      await expect(unknown.check('b-open', agent)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_AGENT_ACCESS_UNKNOWN' })
      await expect(unknown.check('b-open', undefined)).resolves.toBeUndefined()
    }
  })
})

describe('Task control asks the one gate with its caller, and never for stop', () => {
  function owner() {
    return {
      getTaskAssets: vi.fn(async () => ({ assets: [], runs: [], batches: [] }) as never),
      getOperation: vi.fn(async () => null),
      runControlledTaskBatch: vi.fn(async () => { throw new Error('ran batch') }),
      runControlledTaskAsset: vi.fn(async () => { throw new Error('ran task') }),
      stopTaskBatch: vi.fn(async () => null),
      stopTaskAsset: vi.fn(async () => null)
    }
  }
  const run = { operation: 'browser.task.run', browserId: 'b-guarded', assetId: 'asset-1', version: 1, parameters: {} }
  const batch = { operation: 'browser.task.batch', browserId: 'b-guarded', assetId: 'asset-1', version: 1, parameters: {}, items: [{ id: 'i1', parameters: {} }] }

  it('an Agent task run and batch are refused in a Profile with Agents off; a person reaches the run', async () => {
    const { check } = gate(), tasks = owner()
    await expect(executeBrowserTaskControl({ ...run, caller: agent }, tasks, check)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_AGENT_ACCESS_OFF' })
    await expect(executeBrowserTaskControl({ ...batch, caller: agent }, tasks, check)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_AGENT_ACCESS_OFF' })
    expect(tasks.runControlledTaskAsset).not.toHaveBeenCalled()
    expect(tasks.runControlledTaskBatch).not.toHaveBeenCalled()
    await expect(executeBrowserTaskControl(run, tasks, check)).rejects.toThrow('ran task')
    await expect(executeBrowserTaskControl(batch, tasks, check)).rejects.toThrow('ran batch')
  })

  it('stopping a task or batch never asks the gate, even with automation off', async () => {
    const { check } = gate({ automation: false }), tasks = owner()
    const asked = vi.fn(check)
    await executeBrowserTaskControl({ operation: 'browser.task.stop', browserId: 'b-guarded', runId: 'run-1', caller: agent }, tasks, asked)
    await executeBrowserTaskControl({ operation: 'browser.task.batch-stop', browserId: 'b-guarded', batchId: 'batch-1', caller: agent }, tasks, asked)
    expect(asked).not.toHaveBeenCalled()
    expect(tasks.stopTaskAsset).toHaveBeenCalledOnce()
    expect(tasks.stopTaskBatch).toHaveBeenCalledOnce()
  })
})
