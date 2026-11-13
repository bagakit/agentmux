import { describe, expect, it } from 'vitest'
import { coldBrowserTargets } from '../src/main/browser-cold-descriptor.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '@agentmux/core'
import { parseBrowserTargetsResult } from '../../../packages/core/src/control-browser-targets.js'

const PROFILE = '22222222-2222-4222-8222-222222222222'
function graph(resources: Record<string, Record<string, unknown>>) {
  const ids = Object.keys(resources)
  return { regions: ids.map(id => ({ kind: 'browser', browserId: id, regionId: `region-${id}`, tabId: 'tab' })),
    tabs: [{ tabId: 'tab', regionIds: ids.map(id => `region-${id}`) }],
    resources: Object.fromEntries(ids.map(id => [`region:region-${id}`, { browserId: id, workspaceId: 'workspace', url: 'https://example.invalid/', title: 'Saved', ...resources[id] }])) } as never
}
const labels = (id: string) => id === PROFILE ? 'Northwind client' : undefined

describe('Saved Browsers name their Profile with the label Main lists', () => {
  it('adds profile {id,label} to a saved normal page, and nothing to private pages, Capsules or unlisted ids', () => {
    const rows = Object.fromEntries(coldBrowserTargets(graph({
      saved: { mode: 'normal', profileId: PROFILE },
      'saved-private': { mode: 'private' },
      'saved-unlisted': { mode: 'normal', profileId: '33333333-3333-4333-8333-333333333333' },
      'saved-legacy': {}
    }), [], labels).map(row => [row.id, row]))
    expect(rows.saved!.profile).toEqual({ id: PROFILE, label: 'Northwind client' })
    for (const id of ['saved-private', 'saved-unlisted', 'saved-legacy']) expect(rows[id], id).not.toHaveProperty('profile')
    // The public parser accepts exactly what Main produced.
    expect(parseBrowserTargetsResult({ targets: Object.values(rows), coverage: 'complete' }).targets.find(row => row.id === 'saved')!.profile)
      .toEqual({ id: PROFILE, label: 'Northwind client' })
  })
})

describe('Public open and targets contracts carry only {id,label}', () => {
  const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'op-1', operation: 'open.browser', url: 'https://example.invalid/', destination: { kind: 'launcher', regionId: 'r-1' } }
  const region = { tabId: 'tab', regionId: 'r-1', workspaceId: 'workspace', kind: 'browser', browserId: 'b-1', mode: 'normal' }
  it('accepts --profile only for a normal page', () => {
    expect(parseAgentMuxControlRequest({ ...base, profileId: PROFILE })).toMatchObject({ profileId: PROFILE })
    expect(() => parseAgentMuxControlRequest({ ...base, profileId: PROFILE, mode: 'private' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseAgentMuxControlRequest({ ...base, profileId: PROFILE, capsuleId: 'C4psu1eObjId' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(() => parseAgentMuxControlRequest({ ...base, profileId: 'self' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  })
  it('rejects a Profile on a private receipt or target and any storage field beside {id,label}', () => {
    const receipt = (result: unknown) => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'op-1', ok: true, operation: 'open.browser', result })
    expect(parseAgentMuxControlReceipt(receipt({ region: { ...region, profile: { id: PROFILE, label: 'Work' } } }))).toMatchObject({ ok: true, result: { region: { profile: { id: PROFILE, label: 'Work' } } } })
    expect(() => parseAgentMuxControlReceipt(receipt({ region: { ...region, mode: 'private', profile: { id: PROFILE, label: 'Work' } } }))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => parseAgentMuxControlReceipt(receipt({ region: { ...region, profile: { id: PROFILE, label: 'Work', partition: 'persist:x' } } }))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const target = { id: 'b-1', workspaceId: 'workspace', source: 'embedded', mode: 'private', status: 'unavailable', url: '', title: '', capabilities: [] }
    expect(() => parseBrowserTargetsResult({ targets: [{ ...target, profile: { id: PROFILE, label: 'Work' } }], coverage: 'complete' })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
})
