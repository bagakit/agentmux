import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { AgentMuxError, browserDefaultOutcome, type BrowserDefaultInspection, type BrowserDefaultProtocolFact, type BrowserDefaultSettingsRequest, type BrowserDefaultPayload, type BrowserDefaultResult } from '@agentmux/core'

const runFile = promisify(execFile)
export type BrowserDefaultPort = {
  platform: string
  handler(scheme: 'http' | 'https'): Promise<{ isCurrentApplication: boolean; application: { name: string; path: string } }>
  openSettings(): Promise<void>
}
const nativePort: BrowserDefaultPort = {
  platform: process.platform,
  async handler(scheme) {
    const application = await app.getApplicationInfoForProtocol(`${scheme}://`)
    return { isCurrentApplication: app.isDefaultProtocolClient(scheme), application: { name: application.name, path: application.path } }
  },
  async openSettings() { await runFile('/usr/bin/open', ['-b', 'com.apple.systempreferences']) }
}

function failure(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'SYSTEM_OBSERVATION_FAILED'
  return { code, message: error instanceof Error ? error.message : String(error) }
}

export async function inspectDefaultBrowser(port: BrowserDefaultPort = nativePort): Promise<BrowserDefaultInspection> {
  if (port.platform !== 'darwin') return { platform: port.platform, outcome: 'unsupported', protocols: null }
  const read = async (scheme: 'http' | 'https'): Promise<BrowserDefaultProtocolFact> => {
    try { return { state: 'known', ...await port.handler(scheme) } }
    catch (error) { return { state: 'unknown', cause: failure(error) } }
  }
  const [http, https] = await Promise.all([read('http'), read('https')]), protocols = { http, https }
  return { platform: port.platform, outcome: browserDefaultOutcome(protocols), protocols }
}

/** LaunchServices accepts a request; only a later observation can confirm the person's choice. */
export async function openDefaultBrowserSettings(port: BrowserDefaultPort = nativePort): Promise<BrowserDefaultSettingsRequest> {
  if (port.platform !== 'darwin') throw new AgentMuxError('Default-browser settings are not supported by this desktop host.', 'CONTROL_UNAVAILABLE')
  await port.openSettings()
  return { requested: true, target: 'default-web-browser', platform: port.platform }
}

export async function executeBrowserDefaultControl(request: BrowserDefaultPayload): Promise<BrowserDefaultResult> {
  return request.operation === 'settings.browser.default.inspect'
    ? { operation: request.operation, ...await inspectDefaultBrowser() }
    : { operation: request.operation, ...await openDefaultBrowserSettings() }
}
