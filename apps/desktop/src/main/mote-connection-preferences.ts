import { MoteConnectionPreferences as ConnectionPreferencesOwner, type MoteConnectionPreferencesPorts } from '@agentmux/host/mote-connection-preferences'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core/control'
type Request = Extract<AgentMuxControlRequest, { operation: 'space.mote.preferences.read' | 'space.mote.preferences.save' }>
/** Only the original Main control adapter owns Quick; connection read/save share the Host owner. */
export class MoteConnectionPreferences extends ConnectionPreferencesOwner {
  private readonly quick: (request: Request, signal?: AbortSignal) => Promise<AgentMuxControlResult>
  constructor(ports: MoteConnectionPreferencesPorts & { quick(request: Request, signal?: AbortSignal): Promise<AgentMuxControlResult> }) {
    super(ports); this.quick = ports.quick
  }
  async execute(request: Request, signal?: AbortSignal): Promise<AgentMuxControlResult> {
    if (request.kind === 'quick') return this.quick(request, signal)
    if (request.operation === 'space.mote.preferences.read') return { operation: request.operation, ...await this.read(request) }
    const { operationId: _operationId, ...body } = await this.save({ kind: request.kind, target: request.target,
      baseline: request.baseline, values: request.values, operationId: request.requestId })
    return { operation: request.operation, requestId: request.requestId, ...body }
  }
}
