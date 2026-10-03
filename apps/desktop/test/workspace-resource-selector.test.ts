import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/store', () => ({ useAppStore: vi.fn() }))
import { createWorkspaceResourceSelector } from '../src/renderer/src/hooks/useWorkspaceResource'
import type { AppConfig } from '../src/shared/contracts'

describe('retained File Workspace resource subscriptions', () => {
  it('scans once per resource change, independent of unrelated ticks and catalog size', () => {
    const workspaces = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), path: _hygiene_fixturePath("repo/") + i, hostId: 'local' }))
    const find = vi.spyOn(workspaces, 'find')
    const config = { workspaces } as AppConfig
    const consumers = Array.from({ length: 50 }, () => createWorkspaceResourceSelector('999'))
    expect(consumers).toHaveLength(50)
    for (const select of consumers) expect(select({ config })).toBe(workspaces[999])
    expect(find).toHaveBeenCalledTimes(50)
    for (let tick = 0; tick < 100; tick++) {
      for (const select of consumers) expect(select({ config: { ...config } })).toBe(workspaces[999])
    }
    expect(find).toHaveBeenCalledTimes(50)
    const rebound = { ...workspaces[999]!, hostId: 'server', path: _hygiene_fixturePath("new") }
    const next = { ...config, workspaces: [rebound] } as AppConfig
    for (const select of consumers) {
      expect(select({ config: next })).toBe(rebound)
      expect(select({ config: null })).toBeUndefined()
      expect(select({ config })).toBe(workspaces[999])
    }
    expect(find).toHaveBeenCalledTimes(100)
  })
})
