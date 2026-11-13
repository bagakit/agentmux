import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxNotebookStore } from '../src/notebook-store.js'
import { describe, expect, it, vi } from 'vitest'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseBrowserTarget } from '../src/control-browser-targets.js'

const intent = { kind: 'create' as const, url: 'https://example.test/' }
const receipt = { operationId: 'original-create', browserId: 'original-browser', intent, status: 'unknown' as const }
describe('Browser object lifecycle public contract', () => {
  it('keeps original operation identity through strict public request and receipt conversion', () => {
    const request=rpcControlRequest('browser.create',{operationId:'original-create',url:intent.url})
    expect(request).toMatchObject({operation:'browser.create',operationId:'original-create',url:intent.url})
    expect(parseRpcControlResult('browser.create',{receipt},{operationId:'original-create',url:intent.url})).toEqual({receipt})
    expect(()=>parseRpcControlResult('browser.create',{receipt:{...receipt,requestId:'transport-correlation'}},{operationId:'original-create',url:intent.url})).toThrow()
  })
  it('requires create intent identity and refuses implicit spatial, engine and actor fields', () => {
    for(const input of [{url:intent.url},{operationId:'op',url:intent.url,destination:{kind:'active'}},{operationId:'op',url:intent.url,executablePath:'/tmp/engine'},{operationId:'op',url:'file:///private/data'}])expect(()=>rpcControlRequest('browser.create',input)).toThrow()
    expect(()=>rpcControlRequest('browser.close',{operationId:'close',browserId:'b'})).toThrow()
  })
  it('joins close to the original Browser, document and operation', () => {
    const params={operationId:'close',browserId:'b',navigationId:'nav'}
    const close={receipt:{operationId:'close',browserId:'b',intent:{kind:'close',navigationId:'nav'},status:'kept'}}
    expect(parseRpcControlResult('browser.close',close,params)).toEqual(close)
    for(const change of [{operationId:'other'},{browserId:'other'},{intent:{kind:'close',navigationId:'other'}}])expect(()=>parseRpcControlResult('browser.close',{receipt:{...close.receipt,...change}},params)).toThrow()
  })
  it('keeps lifecycle receipts joined to their historical operation after restart reads', () => {
    const operation={id:receipt.operationId,browserId:receipt.browserId,operator:{id:'host',name:'Host'},startedAt:1,phase:'indeterminate',summary:'Unknown',url:intent.url,steps:[],lifecycleIntent:intent,lifecycleReceipt:receipt}
    expect(parseRpcControlResult('browser.inspect',{runOperation:operation},{operationId:receipt.operationId})).toEqual({runOperation:operation})
    expect(()=>parseRpcControlResult('browser.inspect',{runOperation:{...operation,lifecycleReceipt:{...receipt,browserId:'substitute'}}},{operationId:receipt.operationId})).toThrow()
  })
  it('registers actual create and close CLI commands with required original identity', async () => {
    expect(await parseAgentMuxCliInvocation(['browser','create','--url',intent.url,'--operation-id','op'])).toMatchObject({command:{method:'browser.create'},params:{operationId:'op',url:intent.url}})
    expect(await parseAgentMuxCliInvocation(['browser','close','--browser','b','--navigation','nav','--operation-id','op'])).toMatchObject({command:{method:'browser.close'},params:{operationId:'op',browserId:'b',navigationId:'nav'}})
    await expect(parseAgentMuxCliInvocation(['browser','create','--url',intent.url])).rejects.toThrow()
  })
  it('distinguishes an unavailable standalone identity from an observed native document', () => {
    expect(parseBrowserTarget({id:'b',source:'standalone',workspaceId:null,status:'unavailable',url:'about:blank',title:'',capabilities:[]})).not.toHaveProperty('navigationId')
    expect(()=>parseBrowserTarget({id:'b',source:'standalone',workspaceId:null,status:'ready',url:'about:blank',title:'',capabilities:[]})).toThrow()
  })
  it('a specialized host refuses uncomposed methods before default file owners run, while ordinary hosts retain their path', async () => {
    const read=vi.spyOn(AgentMuxNotebookStore.prototype,'read').mockRejectedValue(new Error('Would read the default user files'))
    try {
      const service=new AgentMuxRpcService({exposedMethods:new Set(['browser.targets','system.endpoint']),execute:async()=>({operation:'browser.targets',targets:[],coverage:'complete'})})
      await expect(service.call('notebook.ls',{})).rejects.toMatchObject({code:'HOST_CAPABILITY_UNAVAILABLE'})
      expect(read).not.toHaveBeenCalled()
      await expect(service.call('browser.targets',{})).resolves.toEqual({targets:[],coverage:'complete'})
      const endpoint=await service.call('system.endpoint',{})
      expect(endpoint.methods).toEqual(['browser.targets','system.endpoint'])
      const ordinary=new AgentMuxRpcService({})
      await expect(ordinary.call('notebook.ls',{})).rejects.toThrow('Would read the default user files')
      expect(read).toHaveBeenCalledTimes(1)
    } finally {read.mockRestore()}
  })
})
