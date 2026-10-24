import { mintObjectId, mintCapabilityToken } from '@agentmux/core/object-id'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { type AgentMuxClientIncidentReport, type AgentMuxClientIncidentProducer } from '@agentmux/core'
import { ClientIncidentArchive, type ClientIncidentReceipt } from '@agentmux/host/client-incident-archive'

/** The receipt describes diagnostic admission only. It grants no Run or input authority. */
export class ClientIncidentIpcOwner {
  private current: { generation: number; frame: unknown; token: string; producer: AgentMuxClientIncidentProducer } | null = null
  constructor(private readonly owner: {
    archive: ClientIncidentArchive; contents: WebContents; windowId: number
    generation(): number | null; buildId(): string | null; rendererBuildId?(): string | null
  }) {}
  private frame(event: IpcMainInvokeEvent): number | null {
    const { contents } = this.owner, generation = this.owner.generation()
    if (contents.isDestroyed() || event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame || generation === null) return null
    return generation
  }
  open(event: IpcMainInvokeEvent): { token: string } | null {
    const generation = this.frame(event)
    if (generation === null) return null
    if (!this.current || this.current.generation !== generation || this.current.frame !== event.senderFrame) {
      this.current = { generation, frame: event.senderFrame, token: mintCapabilityToken(), producer: {
        kind: 'renderer', appInstanceId: this.owner.archive.appInstanceId, producerInstanceId: mintObjectId(),
        windowId: String(this.owner.windowId), documentGeneration: String(generation), buildId: this.owner.rendererBuildId?.() ?? null
      } }
    }
    return { token: this.current.token }
  }
  report(event: IpcMainInvokeEvent, token: unknown, input: unknown): ClientIncidentReceipt {
    const generation = this.frame(event), current = this.current
    if (generation === null || !current || generation !== current.generation || current.frame !== event.senderFrame || token !== current.token) return { accepted: false }
    try { return this.owner.archive.enqueue(input as AgentMuxClientIncidentReport, current.producer) }
    catch { return { accepted: false } }
  }
  /** Main probe/connection owners reuse this archive without a Renderer token. */
  mainProducer(): AgentMuxClientIncidentProducer {
    return { kind: 'main', appInstanceId: this.owner.archive.appInstanceId, producerInstanceId: this.owner.archive.appInstanceId,
      windowId: null, documentGeneration: null, buildId: this.owner.buildId() }
  }
}
