import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseAmuxObjectLink, agentSessionInspectCommand, type AgentMuxControlFocusRequest, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core'
import type { CapsuleOpenResult } from '@agentmux/core/capsule'

type Execute = (request: AgentMuxControlRequest, signal: AbortSignal) => Promise<AgentMuxControlResult>
type Opening = { target: ReturnType<typeof parseAmuxObjectLink>; finish: (issue: string | null) => void }
type Execution = Opening & { controller: AbortController }
const SUPERSEDED = 'This object link opening was superseded by a newer link before confirmation. Inspect its exact original object before retrying. The original workface and healthy Agents are kept.'
const INTERRUPTED = 'Object link opening was interrupted before confirmation. Your current workface and healthy Agents are kept; retry the exact object link.'

/** One native URL intent, handed to the original control owner after real renderer initialization. */
export class SpatialLinkIngress {
  private pending: Opening | null = null
  private execution: Execution | null = null
  private execute: Execute | null = null
  private report: ((message: string) => void) | null = null
  private issue: string | null = null
  private openCapsule: ((capsuleId: string, operationId: string, signal: AbortSignal) => Promise<CapsuleOpenResult>) | null = null

  /** Resolves only this opening's original diagnostic; fire-and-forget consumers never reject. */
  receive(raw: string): Promise<string | null> {
    const previous = this.execution
    this.execution = null
    previous?.controller.abort()
    previous?.finish(SUPERSEDED)
    this.pending?.finish(SUPERSEDED)
    this.pending = null
    let target: Opening['target']
    try { target = parseAmuxObjectLink(raw); this.issue = null }
    catch (error) {
      const issue = `This object link was not opened. ${error instanceof Error ? error.message : String(error)} Copy its exact object link again. Your current workface is kept.`
      this.publish(issue)
      return Promise.resolve(issue)
    }
    const result = new Promise<string | null>(finish => { this.pending = { target, finish } })
    this.drain()
    return result
  }

  ready(execute: Execute, report: (message: string) => void, openCapsule?: (capsuleId: string, operationId: string, signal: AbortSignal) => Promise<CapsuleOpenResult>): void {
    this.execute = execute; this.report = report
    this.openCapsule = openCapsule ?? null
    this.drain()
  }

  unavailable(): void {
    this.execute = null; this.report = null; this.openCapsule = null
    const execution = this.execution
    this.execution = null
    if (execution) {
      execution.controller.abort()
      this.issue = INTERRUPTED
      execution.finish(INTERRUPTED)
    }
  }

  private publish(issue: string): void {
    this.issue = issue
    if (!this.report) return
    try { this.report(issue); this.issue = null }
    catch { /* Keep the original diagnostic for readiness; reporting cannot reject the opening. */ }
  }

  private drain(): void {
    if (!this.execute || !this.report) return
    if (this.issue) this.publish(this.issue)
    const opening = this.pending
    if (!opening) return
    this.pending = null
    const { target } = opening
    const controller = new AbortController(), execute = this.execute
    const execution: Execution = { ...opening, controller }
    this.execution = execution
    const navigate = async (): Promise<string | null> => {
      if (target.kind === 'capsule') {
        if (!this.openCapsule) throw new Error('The original Capsule presentation owner is unavailable.')
        const operationId = mintObjectId()
        const result = await this.openCapsule(target.capsuleId, operationId, controller.signal)
        if (controller.signal.aborted || this.execution !== execution) return null
        if (result.capsuleId !== target.capsuleId || result.operationId !== operationId) throw new Error('The Capsule owner returned another object or operation.')
        return result.rendering.status === 'unavailable'
          ? `Capsule opening is unconfirmed. ${result.rendering.reason} Inspect original operation ${operationId}; the page and current workface are kept.` : null
      }
      let request: AgentMuxControlFocusRequest
      const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(), operation: 'focus' as const, inputPolicy: 'preserve' as const }
      if (target.kind === 'agent') {
        const discovery = await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(), operation: 'space.ls', target: {} }, controller.signal)
        if (controller.signal.aborted) return null
        if (discovery.operation !== 'space.ls') throw new Error('The spatial discovery owner returned another operation.')
        const regionIds = new Set(discovery.catalog.regions.filter(region => region.kind === 'agent' && region.agentSessionId === target.agentSessionId).map(region => region.regionId))
        const locations = discovery.catalog.locations.filter(location => regionIds.has(location.regionId))
        if (locations.length !== 1) throw new Error(`Agent ${JSON.stringify(target.agentSessionId)} has ${locations.length} confirmed display candidates. Its existence and health are not determined by this observation. Candidates: ${JSON.stringify(locations)}. Inspect the original Session with ${agentSessionInspectCommand(target.agentSessionId)}; use amux --skill to choose its exact current position or original open/resume action.`)
        const location = locations[0]!
        request = { ...base, target: { kind: 'space', regionId: location.regionId, tabId: location.tabId,
          displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId,
          ...(location.spaceId === null ? {} : { spaceId: location.spaceId }), ...(location.zoneId === null ? {} : { zoneId: location.zoneId }) },
          expectedAgentSessionId: target.agentSessionId }
      } else {
        const selector = target.kind === 'region' ? { regionId: target.regionId } : target.kind === 'tab' ? { tabId: target.tabId }
          : target.kind === 'space' ? { spaceId: target.spaceId } : { zoneId: target.zoneId }
        request = { ...base, target: { kind: 'space', ...selector } }
      }
      if (controller.signal.aborted) return null
      const result = await execute(request, controller.signal)
      if (result.operation === 'focus' && result.navigation.expectedAgentSessionId !== request.expectedAgentSessionId)
        throw new Error('The original navigation owner did not confirm the requested Agent identity condition.')
      if (controller.signal.aborted || this.execution !== execution) return null
      if (result.operation !== 'focus') throw new Error('The original navigation owner returned another operation.')
      if (result.navigation.state === 'rejected' || result.navigation.state === 'unconfirmed' ||
        (result.presentation.state !== 'main-visible' && result.presentation.state !== 'floating')) {
        const issue = result.issues.map(item => `${item.code}: ${item.message} ${item.recovery}${item.candidates ? ` Candidates: ${JSON.stringify(item.candidates)}` : ''}`).join('\n')
        return `Object link opening is unconfirmed. Navigation: ${result.navigation.state}; presentation: ${result.presentation.state}. ${issue} The original workface and healthy Agents are kept.`
      }
      return null
    }
    const complete = (issue: string | null): void => {
      if (controller.signal.aborted || this.execution !== execution) return
      this.execution = null
      if (issue) this.publish(issue)
      opening.finish(issue)
    }
    void navigate().then(complete, error => complete(`This object link could not be opened. ${error instanceof Error ? error.message : String(error)} Inspect its exact object and retry; the original workface is kept.`))
  }
}

/** Other arguments belong to Electron/the OS. Only this application's explicit URL is consumed. */
export function receiveSpatialLinkArguments(ingress: SpatialLinkIngress, argv: readonly string[]): void {
  for (const argument of argv) if (/^amux:/iu.test(argument)) ingress.receive(argument)
}
