import { mintObjectId } from '@agentmux/core/object-id'
import { parseSpaceLinkResult } from '@agentmux/core/sharing'
import { api } from './api'
import { copyTextToClipboard, type CopyErrorReporter } from './clipboard-copy'
const publications=new Map<string,{spaceId:string;eventId?:string;operationId:string}>()
/** Publication and Copy share one frozen target. Unknown writes never fall back to a path URI. */
export async function copyMoteAddress(target: {spaceId:string;eventId?:string}, reportError: CopyErrorReporter): Promise<boolean> {
  const key=JSON.stringify([target.spaceId,target.eventId??null])
  const input=publications.get(key)??{...target,operationId:mintObjectId()}
  publications.set(key,input)
  try {
    const result=await api.spatial.ensureLink(input)
    const request={target:{runtimeId:result.address.runtimeId,...target},operationId:input.operationId}
    const confirmed=parseSpaceLinkResult('space.link.ensure',result,request)
    if(publications.get(key)===input)publications.delete(key)
    return await copyTextToClipboard(confirmed.url,reportError)
  } catch(error) { reportError(error);return false }
}
