import { useCallback, useEffect, useState } from 'react'
import { MobileApp } from '../MobileApp'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { openBrowserHttpLink } from '../platform/browser'
import { PrivateConnectionPanel } from './PrivateConnectionPanel'
import { PrivateConnection, type AuthorizedHostedClientFactory, type NativePrivateAdmission } from './private-connection'
import { getDeviceWorkface } from '../recovery/device-workface'

function confirmDeviceHost(host: { origin: string; hostId: string }): string | null {
  const owner = getDeviceWorkface()
  const previous = owner.snapshot().record.host
  if (previous && (previous.origin !== host.origin || previous.hostId !== host.hostId)) {
    throw new Error('Original workface Host differs')
  }
  try { owner.confirmHost(host); return null }
  catch (error) {
    const current = owner.snapshot().record.host
    if (!current || current.origin !== host.origin || current.hostId !== host.hostId) throw error
    // Durable storage failure leaves the authentic binding in the existing in-memory owner.
    return '原 Mac 的身份仅在当前设备内存中保全，设备保存尚未确认。请保全工作面或恢复设备存储；原会话与草稿保留。'
  }
}

/** The only application connection owner. It receives the genuine public SDK factory. */
export function MobileConnectionRoot({ platform, native, nativeAccess, focusComposer, connectClient }: {
  platform: ClientUiPlatform; native: boolean; focusComposer?: () => boolean
  connectClient?: AuthorizedHostedClientFactory
  nativeAccess?: NativePrivateAdmission
}) {
  const [controller] = useState(() => new PrivateConnection({ native, confirmHost: confirmDeviceHost,
    ...(connectClient ? { connectClient } : {}), ...(nativeAccess ? { nativeAccess } : {}) }))
  const [snapshot, setSnapshot] = useState(() => controller.snapshot())
  const [target, setTarget] = useState<string | null>(null)
  useEffect(() => {
    const release = controller.observe(setSnapshot)
    if (!native && location.protocol === 'https:') void controller.resume(location.origin)
    if (native && nativeAccess) {
      const saved = getDeviceWorkface().snapshot().record
      const origin = saved.host?.origin ?? saved.hostUrl
      if (origin) void controller.resume(origin)
    }
    return () => { release(); controller.stop() }
  }, [controller, native, nativeAccess])
  const savedHost = useCallback((address: string) => {
    setTarget(address); void controller.resume(address)
  }, [controller])
  const connection = { ...snapshot.connection, message: [snapshot.hostBindingNotice, snapshot.connection.message].filter(Boolean).join(' ') }
  return <MobileApp client={snapshot.client} connection={connection} platform={platform} native={native}
    {...(focusComposer ? { focusComposer } : {})} onHostAddressSaved={savedHost}
    connectionPanel={<>
      {target && target !== location.origin && <button className="mobile-secondary"
        onClick={() => openBrowserHttpLink(target)}>打开 Mac 的 HTTPS 手机入口</button>}
      <PrivateConnectionPanel controller={controller} snapshot={snapshot} native={native} />
    </>} />
}
