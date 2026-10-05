import { parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult,
  type AgentMuxRpcMoteAvatarsOwner, type MoteAvatarSeriesMethod,
  type MoteAvatarSeriesParameterMap, type MoteAvatarSeriesResultMap } from '@agentmux/core/mote-avatar-series'
import type { MoteAvatarSeriesOwner } from './mote-avatar-series.js'

/** Trusted IPC and native RPC consume the same original Host source owner. */
export class MoteAvatarControl implements AgentMuxRpcMoteAvatarsOwner {
  constructor(private readonly sources: MoteAvatarSeriesOwner) {}
  async call<M extends MoteAvatarSeriesMethod>(method: M, params: MoteAvatarSeriesParameterMap[M]): Promise<MoteAvatarSeriesResultMap[M]> {
    const input = parseMoteAvatarSeriesParams(method, params)
    const result = method === 'space.mote.avatar.list' ? await this.sources.list()
      : await this.sources.preview(input as MoteAvatarSeriesParameterMap['space.mote.avatar.preview'])
    return parseMoteAvatarSeriesResult(method, result, input)
  }
}
