import { useEffect, useRef, useState } from 'react'
import type { BrowserTrafficReceipt } from '../../../shared/browser-traffic'
import { api } from '../lib/api'

export function useTrafficReceipt(visible: boolean) {
  const [receipt, setReceipt] = useState<BrowserTrafficReceipt | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const version = useRef(0)
  const recording = receipt !== null && receipt.endedAt === null

  useEffect(() => {
    if (!visible || busy) return
    let live = true, pending = false, latestRead = 0
    const refresh = async () => {
      pending = true
      const read = ++latestRead
      const expected = version.current
      const isCurrent = () => live && latestRead === read && version.current === expected
      try {
        const value = await api.browser.inspectTraffic()
        if (isCurrent()) setReceipt(value)
      } catch (failure) {
        if (isCurrent()) setError(String(failure))
      } finally {
        if (latestRead === read) pending = false
      }
    }
    const unsubscribe = api.browser.onTrafficChanged(() => void refresh())
    void refresh()
    const timer = recording ? setInterval(() => { if (!pending) void refresh() }, 750) : undefined
    return () => { live = false; unsubscribe(); clearInterval(timer) }
  }, [busy, recording, visible])

  async function act(action: () => Promise<BrowserTrafficReceipt | null>) {
    version.current++
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (result) setReceipt(result)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }
  return { receipt, error, busy, recording, act }
}
