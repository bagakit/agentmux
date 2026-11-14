// @vitest-environment happy-dom
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { directoryIdentity } from '@agentmux/host/mote-model'
import { MOTE_STATE_PATH, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.invoke.mockReset() })

it('archives through the production preload and registered Main into the original File writer', async () => {
  const original = await owningBridge(undefined, { scratchWorkspace: true })
  try {
    const initial = await bridge.api!.files.write(SCRATCH_WORKSPACE_ID, { path: 'plain.txt', content: 'original', expectedRevision: null })
    expect(initial.status).toBe('written')
    if (initial.status !== 'written') throw new Error('The original File creation was unconfirmed')
    const updated = await bridge.api!.files.write(SCRATCH_WORKSPACE_ID, { path: 'plain.txt', content: 'confirmed', expectedRevision: initial.revision })
    expect(updated.status).toBe('written')
    expect((await bridge.api!.files.write(SCRATCH_WORKSPACE_ID, { path: 'plain.txt', content: 'stale', expectedRevision: initial.revision })).status).toBe('conflict')
    expect(await bridge.api!.files.read(SCRATCH_WORKSPACE_ID, 'plain.txt')).toMatchObject({ status: 'read', document: { content: 'confirmed' } })
    const mote = await bridge.api!.scratch.ensureMote(SCRATCH_WORKSPACE_ID, 'view:archive-ipc')
    expect(mote.physicalDirectoryPath).toBeTruthy()
    const key = directoryIdentity('local', mote.identityDirectoryPath!)
    const archived = await bridge.api!.scratch.setMoteArchived(SCRATCH_WORKSPACE_ID, mote.id, true, key, 'unwritten')
    expect(archived.state).toBe('archived')
    const path = join(mote.physicalDirectoryPath!, MOTE_STATE_PATH)
    const saved = await readFile(path, 'utf8')
    expect(JSON.parse(saved)).toEqual({ archived: true, version: archived.version })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(bridge.api!.scratch.setMoteArchived(SCRATCH_WORKSPACE_ID, mote.id, false, key, 'unwritten')).rejects.toThrow('changed')
    expect(await readFile(path, 'utf8')).toBe(saved)
    expect((await bridge.api!.scratch.setMoteArchived(SCRATCH_WORKSPACE_ID, mote.id, false, key, archived.version)).state).toBe('active')
  } finally { await original.dispose() }
  expect(bridge.handlers.size).toBe(0)
})
