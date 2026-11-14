import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { parseConnectionOfferUrl } from '@agentmux/relay/offer'
import '@agentmux/client-ui/styles.css'
import { createBrowserPlatform } from '../platform/browser'
import { MobileConnectionRoot } from './MobileConnectionRoot'
import { deviceRelayIdentity } from './relay-identity'
import { bindDesktopNodeLocation } from './desktop-device-location'

const platform = createBrowserPlatform({ overlayContainer: () => document.getElementById('mobile-overlays')! })

function DeviceAccess({ retry, connected }: { retry: () => void; connected: boolean }) {
  const [notice, setNotice] = useState('')
  const [key, setKey] = useState('')
  async function copy() {
    try {
      const publicKey = exportPublicKey((await deviceRelayIdentity()).publicKey)
      setKey(publicKey)
      if (await platform.copyText(publicKey, cause => setNotice(String(cause)))) setNotice('访问公钥已复制')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <div className="mobile-startup-observation">
    {!connected && <p>首次连接，请把访问公钥交给目标设备的管理者。获准后即可打开会话。</p>}
    <button type="button" onClick={() => void copy()}>复制访问公钥</button>
    {!connected && <button className="mobile-secondary" type="button" onClick={retry}>重新连接</button>}
    {key && <p><code>{key}</code></p>}{notice && <p role="status">{notice}</p>}
  </div>
}

const root = createRoot(document.getElementById('root')!)
try {
  // The desktop supplies data, never a page to navigate to or a private key.
  if (location.protocol !== 'file:') throw new Error('请在 AgentMux 的 Mesh 设置中打开设备访问链接。')
  const link = new URLSearchParams(location.hash.slice(1)).get('link')
  const offer = link ? parseConnectionOfferUrl(link) : undefined
  if (!offer) throw new Error('此链接缺少设备身份。请从网关复制完整访问链接。')
  root.render(<MobileConnectionRoot onDeviceClient={bindDesktopNodeLocation} platform={platform} native={false} offer={offer}
    deviceAccess={(retry, connected) => <DeviceAccess retry={retry} connected={connected} />} />)
} catch (cause) {
  root.render(<main className="mobile-startup" role="alert">{cause instanceof Error ? cause.message : String(cause)}</main>)
}
