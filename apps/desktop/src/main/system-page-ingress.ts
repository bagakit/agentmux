import { formatAmuxObjectLink } from '@agentmux/core'
import type { SystemWebUrlResult } from '../shared/system-web-url.js'
import type { SystemWebFileResult } from '../shared/system-web-file.js'

export type SystemPageExecutor<Request> = (request: Request, signal: AbortSignal) => Promise<SystemWebUrlResult | SystemWebFileResult>

/** Each system event is a new page intent. Only an undispatched intent may wait for readiness. */
export class SystemPageIngress<Request extends { operation: string; requestId: string; url: string }> {
  private pending: Request[] = []
  private execute: SystemPageExecutor<Request> | null = null
  private report: ((message: string) => void) | null = null
  private active = new Map<AbortController, Request>()
  private issues: string[] = []

  protected issue(message: string): void { this.issues.push(message); this.drain() }
  protected enqueue(request: Request): void { this.pending.push(request); this.drain() }
  ready(execute: SystemPageExecutor<Request>, report: (message: string) => void): void { this.execute = execute; this.report = report; this.drain() }
  unavailable(): void {
    this.execute = null; this.report = null
    for (const [controller, request] of this.active) {
      this.issues.push(this.recovery(request, 'System page opening was interrupted before confirmation. Its original Survey preparation may already exist; inspect that item before retrying. Existing pages and healthy Agents are kept.'))
      controller.abort()
    }
    this.active.clear()
  }
  private recovery(request: Request, message: string, reference?: SystemWebUrlResult['reference']): string {
    return `${message}\nRequest: ${request.requestId}\nOriginal address: ${request.url}${reference ? `\nOriginal prepared page: ${formatAmuxObjectLink({ kind: 'region', regionId: reference.regionId })} (Tab ${reference.tabId}, Group ${reference.groupId}, Workspace ${reference.displayWorkspaceId}).` : '\nNo exact page position was confirmed for this request; inspect Survey before opening it again.'}`
  }
  private drain(): void {
    if (!this.execute || !this.report) return
    for (const issue of this.issues.splice(0)) this.report(issue)
    // A slow original page must not hold the next explicit input behind it.
    // Bound Native work in flight; this is scheduling, not a limit on saved pages.
    while (this.active.size < 2 && this.pending.length) {
      const request = this.pending.shift()!
      const controller = new AbortController(), execute = this.execute
      this.active.set(controller, request)
      void Promise.resolve().then(() => execute(request, controller.signal)).then(result => {
        if (this.active.get(controller) !== request) return
        if (result.operation !== request.operation || result.requestId !== request.requestId) throw new Error('The system page owner returned another request.')
        if (result.state === 'unconfirmed') this.issues.push(this.recovery(request, result.message, result.reference))
      }).catch(error => {
        if (this.active.get(controller) === request) this.issues.push(this.recovery(request, `System page opening is unconfirmed. ${error instanceof Error ? error.message : String(error)} Inspect its prepared Survey item before retrying; existing pages and healthy Agents are kept.`))
      }).finally(() => {
        if (this.active.get(controller) !== request) return
        this.active.delete(controller); this.drain()
      })
    }
  }
}

