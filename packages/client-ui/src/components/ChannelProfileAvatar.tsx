import { useState, type ReactNode } from 'react'

/** An observed avatar is display metadata; a failed image keeps the original identity mark. */
export function ChannelProfileAvatar({ url, size = 20, children }: { url?: string | undefined; size?: number; children: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null)
  return !url || failed === url ? children : <img src={url} alt="" width={size} height={size}
    style={{ borderRadius: '50%', objectFit: 'cover' }} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(url)} />
}
