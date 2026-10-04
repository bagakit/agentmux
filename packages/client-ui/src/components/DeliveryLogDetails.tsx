import { useEffect, useRef, useState } from 'react'
import { deliveryLogNotice, type ClientDeliveryLog } from '../lib/delivery-diagnostics'

/** A diagnostic receipt, never a send receipt. Copy success follows the real clipboard result. */
export function DeliveryLogDetails({ logId, log, copyText }: {
  logId: string; log?: ClientDeliveryLog | undefined; copyText(text: string): Promise<boolean>
}) {
  const [copy, setCopy] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const current = useRef(logId)
  current.current = logId
  useEffect(() => { setCopy('idle') }, [logId])
  return <div className="delivery-log" role="status">
    <code>logid: {logId}</code>
    <button type="button" disabled={copy === 'copying'} onClick={async () => {
      setCopy('copying')
      try { const copied = await copyText(logId); if (current.current === logId) setCopy(copied ? 'copied' : 'failed') }
      catch { if (current.current === logId) setCopy('failed') }
    }}>{copy === 'copied' ? '已复制 logid' : copy === 'failed' ? '复制失败，重试' : '复制 logid'}</button>
    <small>{log ? deliveryLogNotice(log) : '本机日志状态尚未读取；不能确认远端可查询'}</small>
  </div>
}
