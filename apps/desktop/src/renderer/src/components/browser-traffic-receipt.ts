import { useEffect, useRef, useState } from 'react'

export function useTrafficReceipt<T extends { endedAt: number | null }>(visible: boolean, inspect: () => Promise<T | null>) {
  const [receipt, setReceipt] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const version = useRef(0)
  const recording = receipt !== null && receipt.endedAt === null

  useEffect(() => {
    if (!visible || busy) return
    let live = true, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      const expected = version.current
      try {
        const value = await inspect()
        if (live && version.current === expected) setReceipt(value)
      } catch (failure) {
        if (live && version.current === expected) setError(String(failure))
      } finally { pending = false }
    }
    void refresh()
    const timer = recording ? setInterval(() => void refresh(), 750) : undefined
    return () => { live = false; clearInterval(timer) }
  }, [busy, inspect, recording, visible])

  async function act(action: () => Promise<T | null>) {
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
