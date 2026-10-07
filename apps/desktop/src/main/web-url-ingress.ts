import { randomUUID } from 'node:crypto'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, formatAmuxObjectLink } from '@agentmux/core'
import { isSystemWebUrl, type SystemWebUrlRequest, type SystemWebUrlResult } from '../shared/system-web-url.js'
import type { SpatialLinkIngress } from './spatial-link-ingress.js'

type Execute = (request: SystemWebUrlRequest, signal: AbortSignal) => Promise<SystemWebUrlResult>

/** Each system event is a new page intent. Only an undispatched intent may wait for readiness. */
export class WebUrlIngress {
  private pending: SystemWebUrlRequest[] = []
  private execute: Execute | null = null
  private report: ((message: string) => void) | null = null
  private active: { controller: AbortController; request: SystemWebUrlRequest } | null = null
  private issues: string[] = []

  receive(url: string): void {
    if (!isSystemWebUrl(url)) {
      this.issues.push('This system link is not a valid HTTP(S) URL. Existing pages and drafts are kept.')
    } else this.pending.push({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), operation: 'browser.openFromSystem', url })
    this.drain()
  }
  ready(execute: Execute, report: (message: string) => void): void { this.execute = execute; this.report = report; this.drain() }
  unavailable(): void {
    this.execute = null; this.report = null
    if (this.active) {
      this.issues.push(this.recovery(this.active.request, 'System page opening was interrupted before confirmation. Its original Survey preparation may already exist; inspect that item before retrying. Existing pages and healthy Agents are kept.'))
      this.active.controller.abort(); this.active = null
    }
  }
  private recovery(request: SystemWebUrlRequest, message: string, reference?: SystemWebUrlResult['reference']): string {
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
      if (result.operation !== request.operation || result.requestId !== request.requestId) throw new Error('The system URL owner returned another request.')
      if (result.state === 'unconfirmed') this.issues.push(this.recovery(request, result.message, result.reference))
    }).catch(error => {
      if (this.active?.controller === controller) this.issues.push(this.recovery(request, `System page opening is unconfirmed. ${error instanceof Error ? error.message : String(error)} Inspect its prepared Survey item before retrying; existing pages and healthy Agents are kept.`))
    }).finally(() => {
      if (this.active?.controller !== controller) return
      this.active = null; this.drain()
    })
  }
}

/** amux keeps its original object-navigation semantics; ordinary argv is not navigation. */
export function receiveDesktopUrl(spatial: SpatialLinkIngress, web: WebUrlIngress, url: string): void {
  if (/^amux:/iu.test(url)) spatial.receive(url)
  else web.receive(url)
}
export function receiveDesktopUrlArguments(spatial: SpatialLinkIngress, web: WebUrlIngress, argv: readonly string[]): void {
  for (const argument of argv) if (/^(amux|https?):/iu.test(argument)) receiveDesktopUrl(spatial, web, argument)
}
