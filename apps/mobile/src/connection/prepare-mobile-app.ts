/** One product module preparation; a rejected import is recovered by the original page reload owner. */
let preparation: Promise<typeof import('../MobileApp')> | undefined
export function prepareMobileApp() {
  return preparation ??= import('../MobileApp')
}
