import type { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'

export type SystemWebUrlRequest = { schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string; operation: 'browser.openFromSystem'; url: string }
export type SystemWebUrlReference = { displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
export type SystemWebUrlResult = { operation: 'browser.openFromSystem'; requestId: string } & (
  | { state: 'opened'; browserId: string; reference: SystemWebUrlReference }
  | { state: 'unconfirmed'; browserId: string | null; reference: SystemWebUrlReference | null; message: string }
)

/** OS URLs are navigation intents, never search text or executable object links. */
export function isSystemWebUrl(raw: string): boolean {
  try { const url = new URL(raw); return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname }
  catch { return false }
}
