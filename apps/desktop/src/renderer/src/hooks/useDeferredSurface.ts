import { useEffect, useState, type ComponentType } from 'react'

type SurfaceModule<Props> =
  | { status: 'loaded'; Component: ComponentType<Props> }
  | { status: 'failed'; error: unknown }

/** Import on first use. Business state and view lifetime belong to the caller. */
export function useDeferredSurface<Props>(requested: boolean, load: () => Promise<ComponentType<Props>>) {
  const [entry, setEntry] = useState<SurfaceModule<Props>>()
  useEffect(() => {
    if (!requested || entry) return
    let current = true
    void load().then(Component => {
      if (current) setEntry({ status: 'loaded', Component })
    }, error => {
      if (current) setEntry({ status: 'failed', error })
    })
    return () => { current = false }
  }, [requested, load, entry])
  return entry
}
