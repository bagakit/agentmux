import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { browserAnnotationMarkers, type BrowserAnnotation } from '../lib/browser-annotations'
import { errorIdentity, presentError } from '../lib/error-presentation'
import type { RenderableServiceNotice } from '../lib/service-window-notice'

type Input = {
  browserId: string
  navigationId: string
  annotations: readonly BrowserAnnotation[]
  active: boolean
  nativeOwnerPresent(): boolean
}
type Failure = { subject: string; reason: string | null }

/** Markers consume a real Main snapshot; a restored durable shell is not a native document owner. */
export function useBrowserAnnotationMarkers(input: Input): {
  notice: RenderableServiceNotice | null
  retryAvailable: boolean
  available: boolean
  cause?: string
  retry(): void
} {
  const { browserId, navigationId, annotations, active, nativeOwnerPresent } = input
  const subject = `${browserId}\0${navigationId}`
  const latest = useRef(input)
  latest.current = input
  const request = useRef(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  useEffect(() => {
    const token = ++request.current
    if (!active || !navigationId || !nativeOwnerPresent()) return
    const isCurrent = (): boolean => token === request.current && latest.current.active &&
      latest.current.browserId === browserId && latest.current.navigationId === navigationId && latest.current.nativeOwnerPresent()
    const current = annotations.filter(annotation => annotation.navigationId === navigationId)
    void api.browser.setAnnotationMarkers(browserId, navigationId, browserAnnotationMarkers(current))
      .then(() => { if (isCurrent()) setFailure({ subject, reason: null }) })
      .catch(error => { if (isCurrent()) setFailure({ subject, reason: presentError(error) }) })
    return () => { ++request.current }
  }, [active, annotations, attempt, browserId, nativeOwnerPresent, navigationId, subject])
  if (!active) return { notice: null, retryAvailable: false, available: false, retry }
  if (!navigationId) return {
    notice: { kind: 'indeterminate', notice: {
      step: 'Restoring Browser annotations',
      mode: 'The saved page is retained; its native document is not confirmed yet.',
      restore: 'Markers synchronize when Browser recovery succeeds.'
    } }, retryAvailable: false, available: false, cause: 'native-document-unconfirmed', retry
  }
  if (failure?.subject !== subject) return { notice: null, retryAvailable: false, available: false, retry }
  if (failure.reason === null) return { notice: null, retryAvailable: false, available: true, retry }
  return {
    notice: { kind: 'indeterminate', notice: {
      step: `Synchronizing Browser annotations did not complete: ${failure.reason}`,
      mode: 'Annotation synchronization is unconfirmed; the page and other Browser work are retained.',
      restore: 'Retry annotations after the native page is available. A successful synchronization clears this notice.'
    } }, retryAvailable: true, available: true, cause: errorIdentity(failure.reason), retry
  }
}
