const host = (window as any).capsuleProbe
export const api = {
  capsules: { call: (...args: unknown[]) => host.call('capsule', ...args) },
  capsuleReplies: { confirm: () => { throw new Error('Answer submission is outside the stylesheet proof') } },
  ui: { getZoomFactor: () => 1, openObjectLink: () => { throw new Error('Opening another Browser is outside the stylesheet proof') } },
  browser: Object.fromEntries(['create', 'restore', 'release', 'registerPresentation', 'updatePresentation', 'removePresentation',
    'armPresentationCapture', 'ackPresentationCapture', 'activatePresentation'].map(method => [method, (...args: unknown[]) => host.call(method, ...args)])) as any
}
api.browser.onEvent = (listener: (event: unknown) => void) => host.onEvent(listener)
api.browser.onPresentationEvent = (listener: (event: unknown) => void) => host.onPresentation(listener)
