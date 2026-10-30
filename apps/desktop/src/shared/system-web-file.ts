import type { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { SystemPageOutcome } from './system-web-url.js'

/** Desktop-internal request created only by the native OS open-file event. */
export type SystemWebFileRequest = { schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string; operation: 'browser.openFileFromSystem'; path: string; url: string }
export type SystemWebFileResult = { operation: 'browser.openFileFromSystem'; requestId: string } & SystemPageOutcome

export function isSystemWebFilePath(path: string): boolean {
  return path.startsWith('/') && !path.includes('\0') && /\.(?:html?|xhtml|xht)$/iu.test(path)
}
export function isSystemWebFileRequest(request: Pick<SystemWebFileRequest, 'path' | 'url'>): boolean {
  try {
    const url = new URL(request.url)
    return isSystemWebFilePath(request.path) && url.protocol === 'file:' && !url.hostname && !url.search && !url.hash && decodeURIComponent(url.pathname) === request.path
  } catch { return false }
}
