// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { NotificationItem } from '../src/renderer/src/components/NotificationItem'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { toggleNotificationCenter, toggleNotificationDetails, selectNotificationView } from './helpers/notification-center'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from '../../../packages/core/src/runtime-owner-protocol'
import type { RecoveryStatus } from '@agentmux/core'

const dom = composerDOM(), fence = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' }
const generation = { generationId: 'original-point', namespace: fence.runtimeId, createdAt: 1_800_000_000_000, memberCount: 2,
  gaps: [{ sourceId: 'original-owner', memberId: 'original-member', code: 'EIO' }], manifestHash: 'a'.repeat(64) }
const broken: RecoveryStatus = { state: 'unavailable', lastGeneration: generation, pending: true, issue: 'EIO' }
const restored: RecoveryStatus = { state: 'idle', lastGeneration: { ...generation, generationId: 'confirmed-new-point', gaps: [] }, pending: false, issue: null }
beforeEach(() => useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {},
  error: null, lastError: null, errorNoticeContext: null, environmentWarning: undefined, runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [],
  displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {}, workbenchSaveWarning: null, workbenchSaveWarningOwner: null }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the existing Details surface shows a short exact title once and still preserves an abbreviated full title', async () => {
  await dom.render(<NotificationItem title="Short exact title" kind="indeterminate" detail="Original owner details" />)
  await toggleNotificationDetails(dom.container.querySelector('article')!)
  expect(dom.container.textContent!.split('Short exact title')).toHaveLength(2)
  const original = 'Original complete diagnostic heading '.repeat(30)
  await dom.render(<NotificationItem title={original} kind="indeterminate" detail="Original owner details" />)
  expect(dom.container.querySelector('.notification-item__original')!.textContent).toContain(original)
})

async function originalBackupHost() {
  const f = await owningBridge()
  // Settle the exact unrelated Main startup owner before this case advances a
  // controlled Renderer clock; virtual time must not expire its real FS lease.
  await Promise.all([...bridge.notesInitializations])
  let status = broken, hold = false
  let release!: (value: { status: RecoveryStatus }) => void
  const forward = vi.fn(async (method: string, params: unknown, _context: unknown, expected: unknown) => {
    if (method === 'runtime.owner.identity') return { owner: { ...fence, protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION, processId: 1, ctxmux: null, availability: 'connected' } }
    expect(expected).toEqual(fence); expect(params).toEqual({})
    if (method === 'storage.backup.create') { status = restored; return { generation: restored.lastGeneration } }
    expect(method).toBe('storage.recovery.status')
    if (hold) { hold = false; return await new Promise<{ status: RecoveryStatus }>(resolve => { release = resolve }) }
    return { status }
  })
  Object.assign(f.client, { forwardRpc: forward })
  vi.spyOn(api.ui, 'readStorageRecovery').mockImplementation(() => bridge.api!.ui.readStorageRecovery())
  vi.spyOn(api.ui, 'createStorageBackup').mockImplementation(owner => bridge.api!.ui.createStorageBackup(owner))
  return { ...f, forward, hold: () => { hold = true }, release: () => release({ status: broken }) }
}

it('actual preload/Main/RuntimeController preserves the original Host fence for status and backup retry', async () => {
  const f = await originalBackupHost()
  try {
    expect(await bridge.api!.ui.readStorageRecovery()).toEqual({ owner: fence, status: broken })
    expect(await bridge.api!.ui.createStorageBackup(fence)).toEqual({ owner: fence, status: restored })
    expect(f.forward.mock.calls.map(call => call[0])).toEqual(['runtime.owner.identity', 'storage.recovery.status', 'storage.backup.create', 'storage.recovery.status'])
    const before = f.forward.mock.calls.length
    await expect(bridge.api!.ui.createStorageBackup(undefined as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(f.forward).toHaveBeenCalledTimes(before)
    const handler = bridge.handlers.get('ui:createStorageBackup')!
    await expect(async () => handler({ sender: { ...f.sender, id: 992 }, senderFrame: f.sender.mainFrame }, fence)).rejects.toThrow()
    expect(f.forward).toHaveBeenCalledTimes(before)
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.client.submitAgentPrompt).not.toHaveBeenCalled()
  } finally { await f.dispose() }
})

it('the real notice feed displays failure, retains the point through a lost read, and clears only after original backup recovery', async () => {
  const f = await originalBackupHost(), healthy = { ...composerSession('original-healthy-agent'), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined), stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'workspace', sessionId: healthy.id })
  useAppStore.setState({ sessions: [healthy], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) }, activeWorkspaceId: 'workspace', agentComposerDrafts: { [healthy.id]: 'Keep this independent draft' } })
  try {
    vi.useFakeTimers()
    await dom.render(<GlobalSystemNotices />)
    await toggleNotificationCenter(dom.container, 'open'); await selectNotificationView(dom.container, 'current')
    await vi.waitFor(() => expect(dom.container.querySelector('[data-notice-id="storage-recovery"]')).not.toBeNull())
    const row = () => dom.container.querySelector<HTMLElement>('[data-notice-id="storage-recovery"]')
    expect(row()!.textContent).toContain('Recovery point needs attention')
    // The original unhealthy backup never enters an Agent input gate.
    expect(useAppStore.getState().send(healthy.id, 'Explicit healthy input', undefined, 'manual')).toBe(true)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts[healthy.id]).toBe('Keep this independent draft')
    f.hold()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    const retry = [...row()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Retry backup'))!
    expect(retry).toBeDefined()
    await act(async () => { retry.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(f.forward.mock.calls.some(call => call[0] === 'storage.backup.create')).toBe(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(row()).toBeNull()
    await act(async () => { f.release(); await Promise.resolve(); await Promise.resolve() })
    expect(row()).toBeNull()
    expect(stop).not.toHaveBeenCalled(); expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  } finally { vi.useRealTimers(); await f.dispose() }
})
