/**
 * What one page call caused, as Main saw it.
 *
 * A program's click can open another page, move this page to a new document, or both, and the page's
 * own text says nothing reliable about which. Main knows: it creates every child Browser a page opens,
 * and it gives every document its own navigation id. This module turns those facts into the step's
 * `effects`, so the program and the person reading the operation history learn what the action did
 * without reading the page.
 *
 * Only facts Main itself observed during the call are recorded. A page opened by a timer or by page
 * code that ran after the call settled is not attributed to it; nothing is guessed from timing.
 */

export type BrowserStepEffects = {
  /** Child Browsers the page opened while this call ran, by their own Browser ids. */
  opened?: string[]
  /** The document this page moved to while the call ran; absent when it stayed on the same one. */
  navigatedTo?: string
}

const MAX_OPENED = 16

export type BrowserStepEffectRecorder = ReturnType<typeof createBrowserStepEffectRecorder>

/** One recorder per run: steps start and finish around their page calls; opens arrive from Main's child creation. */
export function createBrowserStepEffectRecorder() {
  const running = new Map<number, { opened: string[]; navigationAtStart: string | undefined }>()
  return {
    begin(sequence: number, navigationId: string | undefined): void {
      running.set(sequence, { opened: [], navigationAtStart: navigationId })
    },
    /** A child Browser the page opened; every call running now may have caused it. */
    opened(browserId: string): void {
      for (const step of running.values()) if (step.opened.length < MAX_OPENED && !step.opened.includes(browserId)) step.opened.push(browserId)
    },
    /** End one call and return what it caused; nothing is returned for a call that caused nothing. */
    finish(sequence: number, navigationId: string | undefined): BrowserStepEffects | undefined {
      const step = running.get(sequence)
      running.delete(sequence)
      if (!step) return undefined
      const effects: BrowserStepEffects = {
        ...(step.opened.length ? { opened: step.opened } : {}),
        ...(navigationId !== undefined && step.navigationAtStart !== undefined && navigationId !== step.navigationAtStart ? { navigatedTo: navigationId } : {})
      }
      return effects.opened || effects.navigatedTo ? effects : undefined
    }
  }
}

/** Parse effects read back from disk; anything malformed is dropped, never repaired into a claim. */
export function normalizeBrowserStepEffects(value: unknown): BrowserStepEffects | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as { opened?: unknown; navigatedTo?: unknown }
  const opened = Array.isArray(raw.opened)
    ? raw.opened.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128).slice(0, MAX_OPENED)
    : []
  const navigatedTo = typeof raw.navigatedTo === 'string' && raw.navigatedTo.length > 0 && raw.navigatedTo.length <= 128 ? raw.navigatedTo : undefined
  const effects: BrowserStepEffects = { ...(opened.length ? { opened } : {}), ...(navigatedTo ? { navigatedTo } : {}) }
  return effects.opened || effects.navigatedTo ? effects : undefined
}
