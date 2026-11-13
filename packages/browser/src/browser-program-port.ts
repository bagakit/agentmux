import type { BrowserPageTransport } from './browser-page-transport.js'
import type { BrowserOperation, BrowserOperator } from './model/browser-operation.js'
import type { BrowserPageNode } from './model/page.js'

/** Original native target facts belong to the host adapter; the program owner never reselects them. */
export type BrowserProgramTarget = {
  id: string; workspaceId: string | null; navigationId: string; url: string; title: string
  status: 'ready' | 'disconnected' | 'revoked' | 'closed' | 'unavailable'
  connection: { id: string } | null; ledgerNavigationId?: string | undefined; warning?: string | undefined
}
export type BrowserProgramSession = BrowserPageTransport & { detach(): Promise<string | null | undefined> }
export type BrowserProgramFeedback = {
  begin(method: string, key?: unknown): Promise<number | undefined>
  clear(): Promise<void>; observe(): Promise<void>
  showTarget(node: BrowserPageNode, send: BrowserPageTransport['sendCommand'], action?: number): Promise<void>
  completeAction(action?: number): Promise<void>; end(completed: boolean): Promise<void>
}
export type BrowserProgramPort = {
  has(id: string): boolean
  require(id: string): BrowserProgramTarget
  stopOperation(id: string): { message: string } | void
  attach(target: BrowserProgramTarget, owner: { operationId: string; callerId: string }): Promise<BrowserProgramSession>
  observe(id: string, listener: (event: { method: string; params: unknown; navigationId: string; sessionId?: string; mainDocumentNavigation: boolean }) => void): () => void
  observeAvailability(id: string, listener: () => void): () => void
  recordLedger(id: string, navigationId: string): void
  feedback?(target: BrowserProgramTarget, session: BrowserProgramSession, operation: BrowserOperation, current: () => void): BrowserProgramFeedback
  dispose(): Promise<void>
}
/** A command may already have reached its original native target. Uncertainty never authorizes replay. */
export class BrowserRequestFailure extends Error {
  constructor(message: string, readonly sent: boolean, readonly uncertain = sent) { super(message); this.name = 'BrowserRequestFailure' }
}
