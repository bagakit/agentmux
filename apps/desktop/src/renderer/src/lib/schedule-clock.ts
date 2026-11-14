import { useEffect, useState } from 'react'

/** One presentation clock per visible surface; it never observes or fires a schedule. */
export function useScheduleClock(visible: boolean, precision = 1000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), precision)
    return () => clearInterval(timer)
  }, [visible, precision])
  return now
}
