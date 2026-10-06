import { describe, expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import type { AgentMuxControlSettingsResourceResult } from '../src/control.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { parseRpcControlResult, rpcControlResult } from '../src/rpc-business-codec.js'
import { settingsIconCatalogFixture } from './helpers/settings-icon-catalog-fixture.js'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'portable-icon-catalog', ok: true, operation: 'settings.resource.list' }
const receipt = (iconCatalog: unknown) => ({ ...envelope, result: { resource: 'themes', items: [], partial: true, issues: [], iconCatalog } })

describe('portable theme icon catalog receipt', () => {
  it('keeps client-owned IDs, descriptions and same-drawing meanings through the Control and public RPC codecs', () => {
    const iconCatalog = settingsIconCatalogFixture()
    const parsed = parseAgentMuxControlReceipt(receipt(iconCatalog))
    expect(parsed).toEqual(receipt(iconCatalog))
    const result: AgentMuxControlSettingsResourceResult = { operation: 'settings.resource.list', resource: 'themes', items: [], partial: true, issues: [], iconCatalog }
    const wire = rpcControlResult('settings.themes.ls', result)
    expect(wire).toEqual(receipt(iconCatalog).result)
    expect(parseRpcControlResult('settings.themes.ls', wire, {})).toEqual(wire)
    expect(iconCatalog.icons[0]!.id).not.toBe(iconCatalog.icons[1]!.id)
    expect(iconCatalog.icons[0]!.defaultGlyph).toBe(iconCatalog.icons[1]!.defaultGlyph)
  })

  it.each([
    ['missing catalog', () => undefined],
    ['null catalog', () => null],
    ['extra catalog field', () => ({ ...settingsIconCatalogFixture(), unknown: true })],
    ['missing groups', () => { const { groups: _, ...value } = settingsIconCatalogFixture(); return value }],
    ['missing icons', () => { const { icons: _, ...value } = settingsIconCatalogFixture(); return value }],
    ['missing glyphs', () => { const { glyphs: _, ...value } = settingsIconCatalogFixture(); return value }],
    ['empty groups', () => ({ ...settingsIconCatalogFixture(), groups: [] })],
    ['empty icons', () => ({ ...settingsIconCatalogFixture(), icons: [] })],
    ['empty glyphs', () => ({ ...settingsIconCatalogFixture(), glyphs: [] })],
    ['missing group description', () => ({ ...settingsIconCatalogFixture(), groups: [{ id: 'portable', label: 'Group' }] })],
    ['missing meaning description', () => { const value = settingsIconCatalogFixture(); delete (value.icons[0] as Partial<typeof value.icons[number]>).description; return value }],
    ['extra meaning field', () => { const value = settingsIconCatalogFixture(); return { ...value, icons: [{ ...value.icons[0], nativePermission: true }] } }],
    ['blank meaning label', () => { const value = settingsIconCatalogFixture(); value.icons[0]!.label = ' '; return value }],
    ['non-string glyph identity', () => ({ ...settingsIconCatalogFixture(), glyphs: [1] })],
    ['duplicate group identity', () => { const value = settingsIconCatalogFixture(); value.groups.push(value.groups[0]!); return value }],
    ['duplicate meaning identity', () => { const value = settingsIconCatalogFixture(); value.icons.push(value.icons[0]!); return value }],
    ['duplicate glyph identity', () => ({ ...settingsIconCatalogFixture(), glyphs: ['drawing-a', 'drawing-a'] })],
    ['unknown group reference', () => { const value = settingsIconCatalogFixture(); value.icons[0]!.groupId = 'not-discovered'; return value }],
    ['unknown drawing reference', () => { const value = settingsIconCatalogFixture(); value.icons[0]!.defaultGlyph = 'not-discovered'; return value }],
    ['sparse meaning directory', () => ({ ...settingsIconCatalogFixture(), icons: Array(1) })],
    ['accessor metadata', () => ({ ...settingsIconCatalogFixture(), get glyphs() { throw new Error('Must not invoke untrusted getter') } })]
  ])('rejects %s as this discovery response, without guessing a usable catalog', (_label, invalid) => {
    expect(() => parseAgentMuxControlReceipt(receipt(invalid()))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it('requires the catalog on themes only and preserves other resource list contracts', () => {
    const body = { resource: 'executors', items: [], partial: true }
    expect(parseAgentMuxControlReceipt({ ...envelope, result: body })).toEqual({ ...envelope, result: body })
    expect(() => parseAgentMuxControlReceipt({ ...envelope, result: { ...body, iconCatalog: settingsIconCatalogFixture() } })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => parseRpcControlResult('settings.themes.ls', { resource: 'themes', items: [], partial: true }, {})).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
})
