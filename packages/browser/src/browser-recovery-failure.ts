/**
 * What Main refused or could not confirm. Only locator-changed and navigation-failed can earn a
 * bounded local retry; every other kind, and every error that is not this one, has none.
 */
export type BrowserRecoveryFailureKind = 'locator-changed' | 'navigation-failed' | 'cdp-scope' | 'page-dialog'

/** Only Main creates this error. Script/page error text never grants retry authority. */
export class BrowserLocalRecoveryFailure extends Error {
  readonly fact: Readonly<{ kind: BrowserRecoveryFailureKind; effects: 'not-dispatched' | 'unknown' }>
  constructor(message: string, kind: BrowserRecoveryFailureKind, effects: 'not-dispatched' | 'unknown') {
    super(message)
    this.name = 'BrowserLocalRecoveryFailure'
    this.fact = Object.freeze({ kind, effects })
  }
}
