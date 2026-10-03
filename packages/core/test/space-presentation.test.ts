import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
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
  const survey = { items: [{ zoneId: 'absent-zone', name: '原研究😀' }], selection: { zoneId: 'absent-zone', selection: [{ tabId: 'original-tab', regionId: 'original-region' }], active: { tabId: 'original-tab', regionId: 'original-region' } }, issue: 'Topology unavailable; retain references' }
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
