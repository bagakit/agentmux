import type { BrowserDemonstrationStep } from './browser-demonstration.js'

export type BrowserDemonstrationSuggestion = {
  stepId: string
  factRevision: string
  status: 'interpreting' | 'available' | 'unknown' | 'failed'
  source: 'recorded-target-rule'
  title?: string
  parameter?: { key: string; label: string; secret: true }
  reason?: string
}
export type BrowserDemonstrationInterpretation = Omit<BrowserDemonstrationSuggestion, 'stepId' | 'factRevision'>
const text = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 240)

/** Deterministic suggestions from recorded metadata; no model, page access, input values or new selector. */
export async function interpretBrowserDemonstrationStep(step: BrowserDemonstrationStep): Promise<BrowserDemonstrationInterpretation> {
  await Promise.resolve()
  const source = 'recorded-target-rule' as const
  if (step.method === 'gotoUrl') {
    try {
      const url = new URL(step.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Unretained destination')
      return { source, status: 'available', title: text(`Open ${url.hostname}${url.pathname}`) }
    } catch { return { source, status: 'unknown', reason: 'The retained destination is incomplete; review the original navigation.' } }
  }
  const target = step.target
  if (!target || target.count !== 1 || !target.role || /password/i.test(target.role)) {
    return { source, status: 'unknown', reason: 'The recorded target is ambiguous, private or unavailable; review the original step.' }
  }
  const label = text(target.name || target.role)
  if (!label) return { source, status: 'unknown', reason: 'The recorded target has no readable name.' }
  if (step.method === 'click') return { source, status: 'available', title: text(`Click ${label}`) }
  if (step.method === 'fillInput' && step.inputKey) return { source, status: 'available', title: text(`Enter ${label}`),
    parameter: { key: step.inputKey, label, secret: true } }
  return { source, status: 'unknown', reason: 'This recorded method has no supported suggestion.' }
}
