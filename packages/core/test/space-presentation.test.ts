import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
const catalog = { spaces: [{ spaceId:'s', kind:'mote', name:'Muse', hostId:'host', directoryPath:upstreamFixturePath("mote"), projectId:null }], zones:[],tabs:[],regions:[],bindings:[],locations:[],
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
