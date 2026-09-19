import type { AppConfig, AppLinkSchemeChoice } from './contracts'
import { ConfigConflict } from './config-edit'

/** CLI forgets the current answer; the UI also compares the answer it displayed. */
export function applyAppLinkForget(config: AppConfig, scheme: string, expected?: AppLinkSchemeChoice): AppConfig {
  const remembered = config.browser.appLinkSchemes
  if (!remembered || !Object.hasOwn(remembered, scheme)) return config
  if (expected !== undefined && remembered[scheme] !== expected) throw new ConfigConflict(`browser.appLinkSchemes.${scheme}`)
  const next = { ...remembered }
  delete next[scheme]
  return { ...config, browser: { ...config.browser, appLinkSchemes: next } }
}
