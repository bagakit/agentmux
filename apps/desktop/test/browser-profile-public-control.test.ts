import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, session: { fromPartition: () => ({ clearStorageData: async () => {}, flushStorageData: async () => {} }) }, BrowserWindow: class {} }))

import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '@agentmux/core'
import type { AgentMuxControlRequest, AgentMuxNameActor } from '@agentmux/core/control'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileUsage } from '../src/main/browser-profile-usage.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111'
const WORK_ID = '22222222-2222-4222-8222-222222222222'
const person: AgentMuxNameActor = { kind: 'device', id: 'local-user:1', verified: true }
const agent: AgentMuxNameActor = { kind: 'agent', id: 'managed-session', verified: true }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function owners(open: Array<{ profileId: string; browserId: string }> = [], savedRead: () => Promise<unknown> = async () => null) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-browser-profile-control-'))
  roots.push(root)
  const path = join(root, 'browser-profiles.json')
  await writeFile(path, JSON.stringify({ version: 1, defaultProfileId: DEFAULT_ID, pendingImports: [], profiles: [
    { id: DEFAULT_ID, label: 'Personal', createdAt: 1, source: null },
    { id: WORK_ID, label: 'Work', createdAt: 2, source: { browserLabel: 'Chrome', profileLabel: 'Person 1', importedAt: 3, importedCookies: 4, skippedCookies: 1 } }] }))
  const profiles = new BrowserProfileManager(new BrowserProfileStore(path))
  const announced: number[] = []
  profiles.onChange(snapshot => announced.push(snapshot.revision))
  const clearPreviews = vi.fn(async () => ({ status: 'removed' as const }))
  // The same usage owner the Settings delete uses, with its real manager delete.
  const usage = createBrowserProfileUsage({
    open: profileId => open.filter(use => use.profileId === profileId).map(use => ({ browserId: use.browserId, workspaceId: 'w-1', title: 'Board', url: 'https://example.invalid/' })),
    readSaved: savedRead as never,
    deleteProfile: (profileId, approval) => profiles.deleteProfile(profileId, approval),
    clearPreviews
  })
  return { profiles, usage, announced, clearPreviews }
}

// Build each request with the public codec, as the Core service does before Main sees it.
const request = (fields: Record<string, unknown>) => parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'op-1', ...fields }) as AgentMuxControlRequest
// The actor is passed through exactly; an omitted argument means a person, an explicit null means no recorded caller.
async function call(ports: Awaited<ReturnType<typeof owners>>, fields: Record<string, unknown>, given: AgentMuxNameActor | null = person) {
  const actor = given ?? undefined
  const parsed = request(fields)
  if (!isBrowserProfileControlRequest(parsed)) throw new Error('not a Profile request')
  const { operation, ...result } = await executeBrowserProfileControl(parsed, ports, actor)
  // Every answer must pass the public receipt codec that the CLI client applies.
  const receipt = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'op-1', ok: true, operation, result })
  expect(receipt.ok).toBe(true)
  return result as Record<string, any>
}

describe('Public Browser Profile control runs through the Main Profile owners', () => {
  it('answers ls, inspect, create, update and set-default from the manager, each matching the GUI list', async () => {
    const ports = await owners([{ profileId: WORK_ID, browserId: 'b-open' }])
    expect(await call(ports, { operation: 'browser.profile.ls' })).toEqual({ revision: 0, profiles: ports.profiles.listProfiles() })
    expect(await call(ports, { operation: 'browser.profile.inspect', profileId: WORK_ID })).toEqual({ revision: 0,
      profile: expect.objectContaining({ id: WORK_ID, label: 'Work', source: expect.objectContaining({ importedCookies: 4 }) }),
      usage: { complete: true, browsers: [{ browserId: 'b-open', workspaceId: 'w-1', title: 'Board', url: 'https://example.invalid/', state: 'open' }] } })

    const created = await call(ports, { operation: 'browser.profile.create', label: 'Release review' })
    expect(created).toMatchObject({ revision: 1, profile: { label: 'Release review', isDefault: false } })
    expect(await call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 1, edit: { label: 'Northwind', hue: 288, notes: 'QA' } }))
      .toMatchObject({ revision: 2, profile: { id: WORK_ID, label: 'Northwind', hue: 288, notes: 'QA' } })
    expect(await call(ports, { operation: 'browser.profile.set-default', profileId: WORK_ID })).toEqual({ revision: 3, profileId: WORK_ID })
    expect(ports.profiles.defaultProfileId()).toBe(WORK_ID)
    // The manager announced every public write exactly as it does for the GUI.
    expect(ports.announced).toEqual([1, 2, 3])
    expect(await call(ports, { operation: 'browser.profile.ls' })).toEqual({ revision: 3, profiles: ports.profiles.listProfiles() })
  })

  it('keeps the owner refusal codes: stale revision, unknown Profile, status hue and Profile in use', async () => {
    const ports = await owners([{ profileId: WORK_ID, browserId: 'b-open' }])
    await expect(call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 7, edit: { label: 'Late' } }))
      .rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    await expect(call(ports, { operation: 'browser.profile.inspect', profileId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_NOT_FOUND' })
    await expect(call(ports, { operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 0, edit: { hue: 143 } }))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST', message: expect.stringContaining('clear of status colors') })
    await expect(call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE',
      details: { browsers: [expect.objectContaining({ browserId: 'b-open', state: 'open' })] } })
    expect(ports.profiles.listProfiles().map(profile => profile.id)).toEqual([DEFAULT_ID, WORK_ID])
    expect(ports.announced).toEqual([])
  })

  it('reports unreadable saved Tabs as unknown usage and refuses delete without removing anything', async () => {
    const ports = await owners([], async () => { throw new Error('EACCES') })
    expect((await call(ports, { operation: 'browser.profile.inspect', profileId: WORK_ID })).usage).toEqual({ browsers: [], complete: false })
    await expect(call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_USAGE_UNKNOWN' })
    expect(ports.profiles.listProfiles().some(profile => profile.id === WORK_ID)).toBe(true)
  })

  it('deletes for a verified person through the same usage owner and builds the approval itself', async () => {
    const ports = await owners()
    const spy = vi.spyOn(ports.usage, 'deleteProfile')
    expect(await call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID })).toEqual({ revision: 1, profileId: WORK_ID, deleted: true })
    expect(spy).toHaveBeenCalledWith(WORK_ID, { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: WORK_ID })
    expect(ports.clearPreviews).toHaveBeenCalledWith(WORK_ID)
    expect(ports.profiles.listProfiles().map(profile => profile.id)).toEqual([DEFAULT_ID])
  })

  it.each([['managed Agent', agent], ['unverified caller', { kind: 'user', id: null, verified: false } as AgentMuxNameActor], ['no recorded caller', null]])(
    'refuses delete for a %s and leaves the Profile, its data and the reads available', async (_name, actor) => {
      const ports = await owners()
      const spy = vi.spyOn(ports.usage, 'deleteProfile')
      await expect(call(ports, { operation: 'browser.profile.delete', profileId: WORK_ID }, actor)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DELETE_REQUIRES_PERSON' })
      expect(spy).not.toHaveBeenCalled()
      expect(ports.profiles.listProfiles().some(profile => profile.id === WORK_ID)).toBe(true)
      expect((await call(ports, { operation: 'browser.profile.ls' }, actor)).profiles).toHaveLength(2)
    })

  it('rejects an approval or partition smuggled into the public request before any owner runs', () => {
    expect(() => request({ operation: 'browser.profile.delete', profileId: WORK_ID, approval: { kind: 'user-confirmed' } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => request({ operation: 'browser.profile.create', label: 'x', partition: 'persist:other' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => request({ operation: 'browser.profile.update', profileId: WORK_ID, expectedRevision: 0, edit: { hue: 360 } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
})
