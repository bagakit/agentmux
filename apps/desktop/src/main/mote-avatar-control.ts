import { parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult, type MoteAvatarSeriesMethod,
  type MoteAvatarSeriesParameterMap, type MoteAvatarSeriesResultMap } from '@agentmux/core/mote-avatar-series'
import { isMoteAvatarWriteMethod, parseMoteAvatarWriteParams, parseMoteAvatarWriteResult, type AgentMuxRpcMoteAvatarsOwner,
  type MoteAvatarMethod, type MoteAvatarParameterMap, type MoteAvatarResultMap } from '@agentmux/core/mote-avatar-write'
import { AgentMuxError } from '@agentmux/core'
import type { MoteAvatarSeriesOwner } from './mote-avatar-series.js'
import type { MoteAvatarWriter } from './mote-avatar-writer.js'

/** Trusted IPC and native RPC consume the same original Host source owner. */
export class MoteAvatarControl implements AgentMuxRpcMoteAvatarsOwner {
  constructor(private readonly sources: MoteAvatarSeriesOwner, private readonly writer?: MoteAvatarWriter) {}
  async call<M extends MoteAvatarMethod>(method: M, params: MoteAvatarParameterMap[M]): Promise<MoteAvatarResultMap[M]> {
    if (isMoteAvatarWriteMethod(method)) {
      if (!this.writer) throw new AgentMuxError('The original saved-avatar owner is unavailable. Its source reader and existing appearance remain available.', 'CONTROL_UNAVAILABLE')
      const input = parseMoteAvatarWriteParams(method, params)
      const result = method === 'space.mote.avatar.read' ? await this.writer.read(input.target, input.operationId)
        : await this.writer.save(input as MoteAvatarParameterMap['space.mote.avatar.save'])
      return parseMoteAvatarWriteResult(method,result,input) as MoteAvatarResultMap[M]
    }
    const sourceMethod=method as MoteAvatarSeriesMethod
    const input = parseMoteAvatarSeriesParams(sourceMethod, params)
    const result = method === 'space.mote.avatar.list' ? await this.sources.list()
      : await this.sources.preview(input as MoteAvatarSeriesParameterMap['space.mote.avatar.preview'])
    return parseMoteAvatarSeriesResult(sourceMethod, result, input) as MoteAvatarResultMap[M]
  }
}
