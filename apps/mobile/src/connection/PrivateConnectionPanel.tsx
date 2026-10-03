import { useState } from 'react'
import type { PrivateConnection, PrivateConnectionSnapshot } from './private-connection'

export function PrivateConnectionPanel({ controller, snapshot, native }: {
  controller: PrivateConnection; snapshot: PrivateConnectionSnapshot; native: boolean
}) {
  const [invitation, setInvitation] = useState(''), [name, setName] = useState('我的手机')
  if (native && !controller.supportsNativeAccess()) return <p className="mobile-sheet-note">这台原生设备的安全授权尚未接通，请先在浏览器打开 Mac 的 HTTPS 手机入口。设备授权与当前草稿保持独立。</p>
  return <section aria-label="设备授权" className="mobile-device-approval">
    {native && snapshot.phase === 'needs-approval' && <>
      <label className="mobile-address-label" htmlFor="mobile-device-name">设备名称</label>
      <input id="mobile-device-name" className="mobile-address-input" value={name} maxLength={128} onChange={event => setName(event.target.value)} />
      <label className="mobile-address-label" htmlFor="mobile-device-invitation">Mac 的短时邀请</label>
      <input id="mobile-device-invitation" className="mobile-address-input" value={invitation} onChange={event => setInvitation(event.target.value)} autoComplete="off" />
      <button className="mobile-secondary" onClick={() => { const value = invitation; setInvitation(''); void controller.begin(value, name) }}>请求设备授权</button>
    </>}
    {!native && snapshot.phase === 'needs-approval' && <p>在 Mac 的设置 → 手机与设备中生成并复制连接链接，然后在这台手机打开。无需填写地址或配对码。</p>}
    {snapshot.confirmationCode && <><p>请核对手机与 Mac 显示的相同确认码：</p><output aria-label="设备确认码">{snapshot.confirmationCode}</output></>}
    {snapshot.nativeRecovery === 'save-secret' && <button className="mobile-primary" onClick={() => { void controller.claim() }}>解锁后重试系统保存</button>}
    {snapshot.nativeRecovery === 'unlock-resume' && <button className="mobile-primary" onClick={() => { void controller.resume(snapshot.origin!) }}>解锁后核对授权</button>}
    {snapshot.phase === 'waiting' && !snapshot.nativeRecovery && <button className="mobile-primary" onClick={() => { void controller.claim() }}>检查 Mac 批准</button>}
    {snapshot.phase === 'authorized' && <p>设备授权已确认；会话连接仍待核实。</p>}
    {snapshot.phase === 'connected' && snapshot.connection.state === 'connected' && <p>此设备已获独立授权，可继续原 Mac 的会话。</p>}
    {snapshot.origin && !snapshot.nativeRecovery && snapshot.phase !== 'waiting' && snapshot.connection.state !== 'connected'
      && <button className="mobile-secondary" onClick={() => { void controller.resume(snapshot.origin!) }}>重新核对连接</button>}
  </section>
}
