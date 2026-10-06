import { parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult, type MoteAvatarSeriesMethod,
  type MoteAvatarSeriesParameterMap, type MoteAvatarSeriesResultMap } from '@agentmux/core/mote-avatar-series'
import { isMoteAvatarWriteMethod, parseMoteAvatarWriteParams, parseMoteAvatarWriteResult, type AgentMuxRpcMoteAvatarsOwner,
  type MoteAvatarMethod, type MoteAvatarParameterMap, type MoteAvatarResultMap } from '@agentmux/core/mote-avatar-write'
import { AgentMuxError } from '@agentmux/core'
import type { MoteAvatarSeriesOwner } from './mote-avatar-series.js'
import type { MoteAvatarWriter } from './mote-avatar-writer.js'

/** Trusted IPC and native RPC consume the same original Host source owner. */
export class MoteAvatarControl implements AgentMuxRpcMoteAvatarsOwner {
  constructor(private readonly sources: MoteAvatarSeriesOwner, private readonly writer?: MoteAvatarWriter,
    private readonly revealPath?: (path: string) => Promise<void>) {}
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
    let result
    if (method === 'space.mote.avatar.list') result = await this.sources.list()
    else if (method === 'space.mote.avatar.series.create') result = await this.sources.createSeries(input as MoteAvatarSeriesParameterMap['space.mote.avatar.series.create'])
    else if (method === 'space.mote.avatar.series.reveal') {
      if (!this.revealPath) throw new AgentMuxError('Opening this Host avatar folder is unavailable. Its sources, created files and existing avatars remain available.', 'CONTROL_UNAVAILABLE')
      const path = await this.sources.revealSeries(input as MoteAvatarSeriesParameterMap['space.mote.avatar.series.reveal'])
      await this.revealPath(path)
      result = { seriesId: (input as MoteAvatarSeriesParameterMap['space.mote.avatar.series.reveal']).seriesId, path, outcome: 'requested' }
    } else result = await this.sources.preview(input as MoteAvatarSeriesParameterMap['space.mote.avatar.preview'])
    return parseMoteAvatarSeriesResult(sourceMethod, result, input) as MoteAvatarResultMap[M]
  }
}
