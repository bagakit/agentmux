import { formatAmuxObjectLink } from '@agentmux/core'
import type { SystemWebUrlResult } from '../shared/system-web-url.js'
import type { SystemWebFileResult } from '../shared/system-web-file.js'

export type SystemPageExecutor<Request> = (request: Request, signal: AbortSignal) => Promise<SystemWebUrlResult | SystemWebFileResult>

/** Each system event is a new page intent. Only an undispatched intent may wait for readiness. */
export class SystemPageIngress<Request extends { operation: string; requestId: string; url: string }> {
  private pending: Request[] = []
  private execute: SystemPageExecutor<Request> | null = null
  private report: ((message: string) => void) | null = null
  private active: { controller: AbortController; request: Request } | null = null
  private issues: string[] = []

  protected issue(message: string): void { this.issues.push(message); this.drain() }
  protected enqueue(request: Request): void { this.pending.push(request); this.drain() }
  ready(execute: SystemPageExecutor<Request>, report: (message: string) => void): void { this.execute = execute; this.report = report; this.drain() }
  unavailable(): void {
    this.execute = null; this.report = null
    if (this.active) {
      this.issues.push(this.recovery(this.active.request, 'System page opening was interrupted before confirmation. Its original Survey preparation may already exist; inspect that item before retrying. Existing pages and healthy Agents are kept.'))
      this.active.controller.abort(); this.active = null
    }
  }
  private recovery(request: Request, message: string, reference?: SystemWebUrlResult['reference']): string {
    return `${message}\nRequest: ${request.requestId}\nOriginal address: ${request.url}${reference ? `\nOriginal prepared page: ${formatAmuxObjectLink({ kind: 'region', regionId: reference.regionId })} (Tab ${reference.tabId}, Group ${reference.groupId}, Workspace ${reference.displayWorkspaceId}).` : '\nNo exact page position was confirmed for this request; inspect Survey before opening it again.'}`
  }
  private drain(): void {
    if (!this.execute || !this.report || this.active) return
    for (const issue of this.issues.splice(0)) this.report(issue)
    const request = this.pending.shift()
    if (!request) return
    const controller = new AbortController(), execute = this.execute
    this.active = { controller, request }
    void Promise.resolve().then(() => execute(request, controller.signal)).then(result => {
      if (this.active?.controller !== controller) return
      if (result.operation !== request.operation || result.requestId !== request.requestId) throw new Error('The system page owner returned another request.')
      if (result.state === 'unconfirmed') this.issues.push(this.recovery(request, result.message, result.reference))
    }).catch(error => {
      if (this.active?.controller === controller) this.issues.push(this.recovery(request, `System page opening is unconfirmed. ${error instanceof Error ? error.message : String(error)} Inspect its prepared Survey item before retrying; existing pages and healthy Agents are kept.`))
    }).finally(() => {
      if (this.active?.controller !== controller) return
      this.active = null; this.drain()
    })
  }
}

