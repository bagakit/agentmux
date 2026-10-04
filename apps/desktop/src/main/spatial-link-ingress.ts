import { randomUUID } from 'node:crypto'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseAmuxObjectLink, agentSessionInspectCommand, type AgentMuxControlFocusRequest, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core'

type Execute = (request: AgentMuxControlRequest, signal: AbortSignal) => Promise<AgentMuxControlResult>

/** One native URL intent, handed to the original control owner after real renderer initialization. */
export class SpatialLinkIngress {
  private pending: ReturnType<typeof parseAmuxObjectLink> | null = null
  private execution: AbortController | null = null
  private execute: Execute | null = null
  private report: ((message: string) => void) | null = null
  private issue: string | null = null

  receive(raw: string): void {
    this.execution?.abort()
    this.pending = null
    try { this.pending = parseAmuxObjectLink(raw); this.issue = null }
    catch (error) { this.issue = `This object link was not opened. ${error instanceof Error ? error.message : String(error)} Copy its exact object link again. Your current workface is kept.` }
    this.drain()
  }

  ready(execute: Execute, report: (message: string) => void): void {
    this.execute = execute; this.report = report
    this.drain()
  }

  unavailable(): void {
    this.execute = null; this.report = null
    if (this.execution && !this.execution.signal.aborted)
      this.issue = 'Object link opening was interrupted before confirmation. Your current workface and healthy Agents are kept; retry the exact object link.'
    this.execution?.abort()
  }

  private drain(): void {
    if (!this.execute || !this.report) return
    if (this.issue) { this.report(this.issue); this.issue = null }
    const target = this.pending
    if (!target) return
    this.pending = null
    const controller = new AbortController(), execute = this.execute
    this.execution = controller
    const navigate = async () => {
      let request: AgentMuxControlFocusRequest
      const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'focus' as const, inputPolicy: 'preserve' as const }
      if (target.kind === 'agent') {
        const discovery = await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'space.ls', target: {} }, controller.signal)
        if (controller.signal.aborted) return
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
      if (controller.signal.aborted) return
      const result = await execute(request, controller.signal)
      if (result.operation === 'focus' && result.navigation.expectedAgentSessionId !== request.expectedAgentSessionId)
        throw new Error('The original navigation owner did not confirm the requested Agent identity condition.')
      return result
    }
    void navigate().then(result => {
      if (!result) return
      if (controller.signal.aborted || this.execution !== controller) return
      if (result.operation !== 'focus') throw new Error('The original navigation owner returned another operation.')
      if (result.navigation.state === 'rejected' || result.navigation.state === 'unconfirmed' ||
        (result.presentation.state !== 'main-visible' && result.presentation.state !== 'floating')) {
        const issue = result.issues.map(item => `${item.code}: ${item.message} ${item.recovery}${item.candidates ? ` Candidates: ${JSON.stringify(item.candidates)}` : ''}`).join('\n')
        this.report?.(`Object link opening is unconfirmed. Navigation: ${result.navigation.state}; presentation: ${result.presentation.state}. ${issue} The original workface and healthy Agents are kept.`)
      }
    }).catch(error => {
      if (!controller.signal.aborted && this.execution === controller) {
        this.report?.(`This object link could not be opened. ${error instanceof Error ? error.message : String(error)} Inspect its exact object and retry; the original workface is kept.`)
      }
    }).finally(() => { if (this.execution === controller) this.execution = null })
  }
}

/** Other arguments belong to Electron/the OS. Only this application's explicit URL is consumed. */
export function receiveSpatialLinkArguments(ingress: SpatialLinkIngress, argv: readonly string[]): void {
  for (const argument of argv) if (/^amux:/iu.test(argument)) ingress.receive(argument)
}
