import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from '../src/control.js'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
const catalog = { spaces: [{ spaceId:'s', kind:'mote', name:'Muse', hostId:'host', directoryPath:fixturePath("mote"), projectId:null }], zones:[],tabs:[],regions:[],bindings:[],locations:[],
 appearance:[{spaceId:'s',parts:{kind:'face',shape:'soft',palette:'mint',eyes:'round',brows:'soft',mouth:'smile',accessory:'tuft'},image:{dataUrl:null}}] }
describe('public spatial presentation contract',()=>{
 it('retains bounded appearance and explicit read intent through the public carrier',()=>{
  expect(rpcControlRequest('space.ls',{target:{},presentation:true})).toMatchObject({operation:'space.ls',presentation:true})
  expect(parseRpcControlResult('space.ls',{catalog},{target:{},presentation:true})).toEqual({catalog})
  expect(rpcControlRequest('space.inspect',{target:{spaceId:'s'},presentation:true})).toMatchObject({target:{spaceId:'s'},presentation:true})
 })
 it('rejects another spatial identity and executable or oversized images',()=>{
  const withAppearance=(value:unknown)=>parseRpcControlResult('space.ls',{catalog:{...catalog,appearance:[value]}})
  expect(()=>withAppearance({spaceId:'wrong',glyph:'bot'})).toThrow()
  expect(()=>withAppearance({spaceId:'s',image:{dataUrl:'https://host/script'}})).toThrow()
  expect(()=>withAppearance({spaceId:'s',image:{dataUrl:'data:image/png;base64,'+'a'.repeat(700001)}})).toThrow()
  expect(()=>rpcControlRequest('space.ls',{target:{},presentation:'yes'})).toThrow()
 })
})

import { parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
const spaceId = JSON.stringify(['host', fixturePath("configured/mote")])
const boundedCatalog = { spaces: [{ spaceId, kind: 'mote', name: 'Mote', hostId: 'host', directoryPath: fixturePath("configured/mote"), projectId: null }], zones: [], tabs: [], regions: [], bindings: [], locations: [],
  appearance: [{ spaceId, expression: 'identity', activities: [{ agentSessionId: 'original', runId: 'original-run', expression: 'tool' }] }],
  agentPresentation: [{ agentSessionId: 'original', name: 'Actual name', project: 'Actual Project', group: 'working', state: 'working', providerId: 'provider', detail: 'Observed', recap: { text: 'Original recap', source: 'Last assistant message' }, avatar: { tint: '#aabbcc', badge: 'spark' } }] }
function receipt(value: unknown) { return parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'read', ok: true, operation: 'space.ls', result: { catalog: value } }) }
describe('public original owner presentation', () => {
  it('carries original Session/Run and presentation through the same public receipt', () => { expect(receipt(boundedCatalog).result).toMatchObject({ catalog: boundedCatalog }) })
  it('preserves long original display fields including UTF-8 recaps', () => {
    const original = { ...boundedCatalog.agentPresentation[0], name: '中文名字😀'.repeat(100), project: '中文项目🧑‍💻'.repeat(100), detail: '原状态'.repeat(200), recap: { text: '中文回复🧑‍💻'.repeat(200), source: 'Last assistant message' } }
    expect(receipt({ ...boundedCatalog, agentPresentation: [original] }).result).toMatchObject({ catalog: { agentPresentation: [original] } })
  })
  it('rejects duplicate activity identities', () => {
    expect(() => receipt({ ...boundedCatalog, appearance: [{ ...boundedCatalog.appearance[0], activities: [boundedCatalog.appearance[0]!.activities[0], boundedCatalog.appearance[0]!.activities[0]] }] })).toThrow()
  })
  it('rejects appearance attributed to a different original Space', () => { expect(() => receipt({ ...boundedCatalog, appearance: [{ ...boundedCatalog.appearance[0], spaceId: JSON.stringify(['other', fixturePath("wrong")]) }] })).toThrow() })
})

describe('original Survey presentation carrier', () => {
  const survey = { profileView: { kind: 'default' }, pages: [], items: [{ zoneId: 'absent-zone', name: '原研究😀' }], selection: { zoneId: 'absent-zone', selection: [{ tabId: 'original-tab', regionId: 'original-region' }], active: { tabId: 'original-tab', regionId: 'original-region' } }, issue: 'Topology unavailable; retain references' }
  it('retains original membership, names and references even with an unavailable topology', () => {
    expect(receipt({ ...boundedCatalog, survey }).result).toMatchObject({ catalog: { survey } })
    expect(parseRpcControlResult('space.ls', { catalog: { ...boundedCatalog, survey } }, { target: {}, presentation: true })).toMatchObject({ catalog: { survey } })
  })
  it('rejects duplicate members, malformed addresses, unknown fields while retaining full names', () => {
    expect(() => receipt({ ...boundedCatalog, survey: { ...survey, items: [...survey.items, ...survey.items] } })).toThrow()
    expect(() => receipt({ ...boundedCatalog, survey: { ...survey, selection: { ...survey.selection, active: { tabId: '', regionId: 'r' } } } })).toThrow()
    expect(() => receipt({ ...boundedCatalog, survey: { ...survey, inventedMembership: true } })).toThrow()
    expect(receipt({ ...boundedCatalog, survey: { ...survey, items: [{ zoneId: 'z', name: '中'.repeat(860) }] } }).result).toMatchObject({ catalog: { survey: { items: [{ zoneId: 'z', name: '中'.repeat(860) }] } } })
  })
  it('rejects invalid types and identities and the actual whole transport budget', () => {
    expect(() => receipt({ ...boundedCatalog, survey: { ...survey, items: [{ zoneId: 'z', name: 42 }] } })).toThrow()
    expect(() => receipt({ ...boundedCatalog, survey: { ...survey, items: [{ zoneId: '', name: '原名' }] } })).toThrow()
    expect(() => receipt({ ...boundedCatalog, survey: { ...survey, items: [{ zoneId: 'z', name: 'a'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES + 1) }] } })).toThrow()
  })

})

describe('Survey environment view in the original public presentation carrier', () => {
  const base = { profileView: { kind: 'default' }, items: [], pages: [], selection: null }
  it.each([{ kind: 'default' }, { kind: 'profile', profileId: 'exact-empty-profile' }, null])('retains the exact known or unknown view %j through Control and the actual RPC result parser', profileView => {
    const original = { ...boundedCatalog, survey: { ...base, profileView } }
    expect(receipt(original).result).toMatchObject({ catalog: original })
    expect(parseRpcControlResult('space.ls', { catalog: original }, { target: {}, presentation: true })).toEqual({ catalog: original })
  })
  it('refuses missing, invented or malformed view facts instead of substituting default', () => {
    for (const value of [{ kind: 'profile' }, { kind: 'default', profileId: 'not-default' }, { kind: 'future' }, undefined]) {
      expect(() => receipt({ ...boundedCatalog, survey: { ...base, profileView: value } })).toThrow()
      expect(() => parseRpcControlResult('space.ls', { catalog: { ...boundedCatalog, survey: { ...base, profileView: value } } }, { target: {}, presentation: true })).toThrow()
    }
  })
})


describe('Desktop presentation over the original Host public catalog', () => {
  it('composes only the original Survey observation and preserves Host topology and other presentations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amx-survey-presentation-'))
    const state = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
    await state.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} } })
    const survey = { profileView: { kind: 'profile' as const, profileId: 'exact-empty-profile' }, items: [], pages: [], selection: null }
    const original = vi.fn(async () => ({ catalog: boundedCatalog }))
    const screen = vi.fn(async () => ({ survey, agentPresentation: [] }))
    const service = new AgentMuxRpcService({ spatialState: state, callOriginalCore: original as never, spatialPresentation: screen })
    try {
      const result = await service.call('space.ls', { target: {}, presentation: true })
      expect(original).toHaveBeenCalledTimes(1); expect(screen).toHaveBeenCalledTimes(1)
      expect(result.catalog).toEqual({ ...boundedCatalog, survey })
      expect(result.catalog.agentPresentation).toBe(boundedCatalog.agentPresentation)
      expect(parseRpcControlResult('space.ls', result, { target: {}, presentation: true })).toEqual(result)
      for (const params of [{ target: {} }, { target: { spaceId }, presentation: true }]) {
        expect(await service.call('space.ls', params)).toEqual({ catalog: boundedCatalog })
      }
      expect(screen).toHaveBeenCalledTimes(1)
      expect(await service.call('space.inspect', { target: { spaceId }, presentation: true })).toEqual({ catalog: boundedCatalog })
      expect(screen).toHaveBeenCalledTimes(1)
    } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
  it.each(['throw', 'null', 'bad-view'])('retains a healthy Host result with a typed unavailable observation when the original client read fails (%s)', async observation => {
    const directory = await mkdtemp(join(tmpdir(), 'amx-survey-presentation-'))
    const state = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
    await state.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} } })
    const screen = vi.fn(async () => {
      if (observation === 'throw') throw new Error('Original client observation unavailable')
      return { survey: observation === 'null' ? null : { profileView: { kind: 'future' }, items: [], pages: [], selection: null } } as never
    })
    const service = new AgentMuxRpcService({ spatialState: state,
      callOriginalCore: (async () => ({ catalog: boundedCatalog })) as never, spatialPresentation: screen })
    try {
      const result = await service.call('space.ls', { target: {}, presentation: true })
      expect(screen).toHaveBeenCalledTimes(1)
      expect(result.catalog).toBe(boundedCatalog)
      expect(result.catalog).not.toHaveProperty('survey')
      expect(result.presentation).toMatchObject({ region: null, tab: null, unavailable: [expect.objectContaining(observation === 'throw' ? { message: 'Original client observation unavailable' } : { code: 'CONTROL_PROTOCOL_ERROR' })] })
      expect(parseRpcControlResult('space.ls', result, { target: {}, presentation: true })).toEqual(result)
      expect(() => parseRpcControlResult('space.ls', { ...result, presentation: { ...result.presentation, unavailable: [{ message: 'missing machine code' }] } })).toThrow()
    } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
