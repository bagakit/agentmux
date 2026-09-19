import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, type AgentMuxControlSettingsBrowserLinksRequest,
  type AgentMuxControlResult } from '@agentmux/core'
import { APP_LINK_SCHEME_CHOICES, type AppLinkSchemeChoice } from '../shared/contracts.js'
import { applyAppLinkForget } from '../shared/browser-settings.js'
import type { ConfigOwner } from './config-owner.js'

function invalid(): never {
  throw Object.assign(new Error('An exact app-link scheme and a valid displayed choice are required.'), { code: 'INVALID_SETTING_VALUE' })
}

/** One short Main owner transaction; neither entry point writes an old answer map. */
export async function forgetBrowserAppLink(owner: ConfigOwner, scheme: string, expected?: AppLinkSchemeChoice) {
  if (typeof scheme !== 'string' || Buffer.byteLength(scheme) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES ||
      (expected !== undefined && !APP_LINK_SCHEME_CHOICES.includes(expected))) invalid()
  let changed = false
  await owner.update((current) => {
    const next = applyAppLinkForget(current, scheme, expected)
    changed = next !== current
    return next
  })
  return { scheme, changed }
}

export async function executeSettingsBrowserControl(
  request: AgentMuxControlSettingsBrowserLinksRequest, owner: ConfigOwner
): Promise<Extract<AgentMuxControlResult, { operation: 'settings.browser.links.list' | 'settings.browser.links.forget' }>> {
  if (request.operation === 'settings.browser.links.list') return {
    operation: request.operation,
    entries: Object.entries(owner.current.browser.appLinkSchemes ?? {}).map(([scheme, choice]) => ({ scheme, choice }))
  }
  return { operation: request.operation, ...await forgetBrowserAppLink(owner, request.scheme) }
}
