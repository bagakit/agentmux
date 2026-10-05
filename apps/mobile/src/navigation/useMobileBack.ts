import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { useEffect, useLayoutEffect, useRef } from 'react'

/** One same-page history boundary delegates Back to the visible top layer. No Runtime navigation. */
export function useMobileBack(hasBack: boolean, onBack: () => void): () => void {
  const current = useRef({ hasBack, onBack })
  current.current = { hasBack, onBack }
  const binding = useRef<{ sync(): void; back(): void } | null>(null)
  useEffect(() => {
    const saved = window.history.state
    const restored = typeof saved?.agentmuxMobileBack === 'string' && saved.agentmuxMobileBack.startsWith('mobile-back:')
    const owner = restored ? saved.agentmuxMobileBack : `mobile-back:${randomClientRequestId()}`
    let guarded = restored, releasing = false, active = true
    let anchor: unknown = restored ? saved.anchor : saved
    const owns = () => window.history.state?.agentmuxMobileBack === owner
    const sync = () => {
      if (!active || releasing) return
      if (current.current.hasBack && !guarded) {
        anchor = window.history.state
        window.history.pushState({ agentmuxMobileBack: owner, anchor }, '')
        guarded = true
      } else if (!current.current.hasBack && guarded && owns()) {
        releasing = true; window.history.back()
      }
    }
    const pop = () => {
      if (!active || owns() || !guarded && !releasing) return
      guarded = false
      if (releasing) releasing = false
      else if (current.current.hasBack) current.current.onBack()
      // React commits the next layer before deciding whether to retain the same-page boundary.
      setTimeout(sync, 0)
    }
    window.addEventListener('popstate', pop)
    binding.current = { sync, back() {
      if (releasing) return
      if (guarded && owns()) window.history.back()
      else if (current.current.hasBack) current.current.onBack()
    } }
    sync()
    return () => {
      active = false; binding.current = null; window.removeEventListener('popstate', pop)
      // Preserve the host/router's state when a same-page shell is replaced.
      if (owns()) window.history.replaceState(anchor, '')
    }
  }, [])
  useLayoutEffect(() => { binding.current?.sync() })
  return () => binding.current?.back()
}
