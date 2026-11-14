import '../browser-profiles-settings/entry'
import { api } from '../../../src/renderer/src/lib/api'
import type { BrowserProfileCookieFileReceipt as Receipt, BrowserProfileCookieScope as Scope } from '@agentmux/core/control'
// Safe owner DTOs for visual states. Native confirmation, files and durable receipts are tested separately.
const counts = { prepare: 0, imports: 0, exports: 0, checks: [] as string[] }
let mode: 'partial' | 'unknown' | 'refused' | 'confirmed-original' = 'partial', lastOperation = ''
const scope: Scope = { kind: 'sites', sites: ['identity-and-account.reference.example.test', 'workspace.example.test'] }
const record = (profileId: string, operationId: string, kind: Receipt['kind'] = 'export'): Receipt => ({ profileId, operationId, kind, scope, status: 'partial', fileOutcome: kind === 'export' ? 'written' : undefined, counts: { total: 7, applied: 4, skipped: 2, rejected: 1, unknown: 0, notAttempted: 0 }, warning: 'Some entries were skipped or rejected. The original Profile and confirmed item outcomes are kept.' })
api.browser.listProfileSites = async () => [{ site: scope.kind === 'sites' ? scope.sites[0]! : '', cookies: 6 }, { site: 'workspace.example.test', cookies: 3 }]
api.ui.chooseFiles = async () => ['/fixture/private-source.json']
api.ui.chooseDirectory = async () => '/fixture/private-destination'
api.browser.prepareProfileCookieImport = async (profileId, operationId, _source, selectedScope) => { counts.prepare++; lastOperation = operationId; return { profileId, reviewId: operationId, scope: selectedScope, total: 7, valid: 5, skipped: 2, sites: ['workspace.example.test'], sourceKind: 'local' } }
api.browser.importProfileCookies = async (profileId, operationId) => { counts.imports++; return record(profileId, operationId, 'import') }
api.browser.exportProfileCookies = async (profileId, operationId) => {
  counts.exports++; lastOperation = operationId
  if (mode === 'refused') throw Object.assign(new Error('Safe pre-admission refusal.'), { code: 'BROWSER_PROFILE_COOKIE_FILE_REFUSED' })
  if (mode === 'unknown') throw Object.assign(new Error('Acknowledgement unavailable.'), { code: 'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED' })
  return record(profileId, operationId)
}
api.browser.inspectProfileCookieFiles = async (profileId, operationId, offset = 0) => {
  if (operationId) counts.checks.push(operationId)
  const receipt = record(profileId, operationId ?? lastOperation)
  return { profileId, pending: [], recent: mode==='confirmed-original'?[receipt]:[], ...(operationId ? { receipt, items: [{ index: offset, status: 'skipped' as const, reason: 'unsupported-cookie' as const }] } : { items: [] }), offset, nextOffset: null }
}
Object.assign(window, { cookieFilesVisual: { counts, state: (value: typeof mode) => { mode = value }, get lastOperation() { return lastOperation } } })
