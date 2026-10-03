import { randomUUID } from 'node:crypto'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseAmuxSpatialLink, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core'

type Execute = (request: AgentMuxControlRequest, signal: AbortSignal) => Promise<AgentMuxControlResult>

/** One native URL intent, handed to the original control owner after real renderer initialization. */
export class SpatialLinkIngress {
  private pending: ReturnType<typeof parseAmuxSpatialLink> | null = null
  private execution: AbortController | null = null
  private execute: Execute | null = null
  private report: ((message: string) => void) | null = null
  private issue: string | null = null

  receive(raw: string): void {
    this.execution?.abort()
    this.pending = null
    try { this.pending = parseAmuxSpatialLink(raw); this.issue = null }
    catch (error) { this.issue = `This spatial link was not opened. ${error instanceof Error ? error.message : String(error)} Copy its exact Space or Zone link again. Your current workface is kept.` }
    this.drain()
  }

  ready(execute: Execute, report: (message: string) => void): void {
    this.execute = execute; this.report = report
    this.drain()
  }

  unavailable(): void {
    this.execute = null; this.report = null
    if (this.execution && !this.execution.signal.aborted)
      this.issue = 'Spatial link opening was interrupted before confirmation. Your current workface and healthy Agents are kept; retry the exact Space or Zone link.'
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
    const request: AgentMuxControlRequest = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'focus',
      target: target.kind === 'space' ? { kind: 'space', spaceId: target.spaceId } : { kind: 'space', zoneId: target.zoneId }, inputPolicy: 'preserve' }
    void execute(request, controller.signal).then(result => {
      if (controller.signal.aborted || this.execution !== controller) return
      if (result.operation !== 'focus') throw new Error('The original navigation owner returned another operation.')
      if (result.navigation.state === 'rejected' || result.navigation.state === 'unconfirmed' ||
        (result.presentation.state !== 'main-visible' && result.presentation.state !== 'floating')) {
        const issue = result.issues.map(item => `${item.code}: ${item.message} ${item.recovery}${item.candidates ? ` Candidates: ${JSON.stringify(item.candidates)}` : ''}`).join('\n')
        this.report?.(`Spatial link opening is unconfirmed. Navigation: ${result.navigation.state}; presentation: ${result.presentation.state}. ${issue} The original workface and healthy Agents are kept.`)
      }
    }).catch(error => {
      if (!controller.signal.aborted && this.execution === controller) {
        this.report?.(`This spatial link could not be opened. ${error instanceof Error ? error.message : String(error)} Inspect its exact Space or Zone and retry; the original workface is kept.`)
      }
    }).finally(() => { if (this.execution === controller) this.execution = null })
  }
}

/** Other arguments belong to Electron/the OS. Only this application's explicit URL is consumed. */
export function receiveSpatialLinkArguments(ingress: SpatialLinkIngress, argv: readonly string[]): void {
  for (const argument of argv) if (/^amux:/iu.test(argument)) ingress.receive(argument)
}
