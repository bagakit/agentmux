import { Copy, LoaderCircle, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'

type DeviceList = AgentMuxRpcResult<'device.ls'>
type DeviceInvitation = AgentMuxRpcResult<'device.link'>

/** Person-only controls for the original Host Authority; a click is never a confirmation fact. */
export function DeviceManagementSettings({ active }: { active: boolean }) {
  const [list, setList] = useState<DeviceList | null>(null)
  const [invitation, setInvitation] = useState<DeviceInvitation | null>(null)
  const [notice, setNotice] = useState('')
  const [readIssue, setReadIssue] = useState('')
  const [busy, setBusy] = useState(false)
  const [needsRead, setNeedsRead] = useState(false)
  const [accessReadUnconfirmed, setAccessReadUnconfirmed] = useState(false)
  const needsReadRef = useRef(needsRead)
  needsReadRef.current = needsRead
  const epoch = useRef(0), alive = useRef(false), working = useRef(false)
  const visible = useRef(active)
  visible.current = active

  async function read(expected = epoch.current): Promise<boolean> {
    try {
      const value = await api.deviceManagement.ls({})
      if (alive.current && expected === epoch.current) { setList(value); setNeedsRead(false); setAccessReadUnconfirmed(false); setReadIssue('') }
      return true
    } catch (error) {
      if (alive.current && expected === epoch.current) setAccessReadUnconfirmed(true)
      if (alive.current && expected === epoch.current) setReadIssue(`设备列表尚未核实，原结果保留。请刷新原 Mac 的设备状态。${presentError(error)}`)
      return false
    }
  }
  useEffect(() => {
    alive.current = true; const expected = ++epoch.current
    setInvitation(null)
    if (active) void read(expected)
    const timer = active ? setInterval(() => { if (!working.current && !needsReadRef.current) void read(epoch.current) }, 5000) : undefined
    return () => { clearInterval(timer); alive.current = false; epoch.current++ }
  }, [active])

  async function mutate(action: () => Promise<unknown>, success: string | (() => string)): Promise<void> {
    if (!active || working.current || needsRead) return
    ++epoch.current
    working.current = true; setBusy(true)
    try {
      await action()
      if (!alive.current) return
      setNotice(typeof success === 'function' ? success() : success)
      if (visible.current) await read(++epoch.current)
      else { ++epoch.current; setNeedsRead(true) }
    } catch (error) {
      if (alive.current) {
        ++epoch.current
        setNeedsRead(true)
        setNotice(`这次操作的结果尚未确认，未自动重做。请先刷新原设备事实，再决定下一次明确操作；原会话与其他设备保留。${presentError(error)}`)
      }
    } finally { working.current = false; if (alive.current) setBusy(false) }
  }
  async function invite(): Promise<void> {
    let message = '连接链接已复制。手机打开即可操作本 Mac 的 Agent，无需再次批准。'
    await mutate(async () => {
      const expected = epoch.current
      const value = await api.deviceManagement.link({})
      if (alive.current && expected === epoch.current) {
        setInvitation(value)
        try { await api.ui.writeClipboardText(value.url) }
        catch (error) { message = `连接链接已生成但尚未复制，请点击复制链接重试。${presentError(error)}` }
      }
    }, () => message)
  }
  async function copyInvitation(): Promise<void> {
    if (!invitation || Date.now() >= invitation.expiresAt) {
      setInvitation(null); setNotice('链接已过期。请生成新连接链接。'); return
    }
    try {
      await api.ui.writeClipboardText(invitation.url)
      setNotice('连接链接已复制。请在要连接的手机打开。')
    } catch (error) { setNotice(`链接尚未复制；原链接保留至到期。${presentError(error)}`) }
  }
  async function copyAccess(value: string, label: string): Promise<void> {
    try {
      await api.ui.writeClipboardText(value)
      setNotice(`${accessReadUnconfirmed ? '上次读取的' : ''}${label}已复制；复制不会生成、信任或激活服务。`)
    } catch (error) { setNotice(`${label}尚未复制，原接入事实保留。${presentError(error)}`) }
  }
  if (!active) return null
  const disabled = busy || needsRead || !list
  return <section className="settings-group">
    <header><span>手机与设备授权</span><small>{list ? `${list.devices.filter(device => device.online).length} 当前在线 · ${list.devices.filter(device => device.revokedAt === undefined).length} 已授权` : '状态尚未核实'}</small></header>
    <p className="settings-group-note">生成并复制连接链接，在手机打开即可继续操作本 Mac 的 Agent。链接 5 分钟内有效，仅能连接一台新设备。</p>
    {list && <p className="field-hint">Mac 身份：<code>{list.hostId}</code></p>}
    <div className="settings-pane-toolbar">
      <button className="small-button" disabled={busy} onClick={() => void read()}><RefreshCw size={13} />刷新设备状态</button>
      <button className="small-button" disabled={disabled} onClick={() => void invite()}>{busy ? <LoaderCircle size={13} className="spin" /> : <ShieldCheck size={13} />}生成并复制连接链接</button>
    </div>
    {invitation && <div className="host-edit-grid">
      <label className="host-edit-grid__wide"><span>连接链接 · 到期 {new Date(invitation.expiresAt).toLocaleString()}</span>
        <input type="text" aria-label="手机连接链接" autoComplete="off" readOnly value={invitation.url} /></label>
      <p className="field-hint host-edit-grid__wide">连接的 Mac：<code>{invitation.hostId}</code>。关闭设置后不在页面保留连接码。</p>
      <button className="small-button" disabled={busy} onClick={() => void copyInvitation()}><Copy size={13} />复制链接</button>
    </div>}
    {list && <PrivateAccessDetails access={list.privateAccess} unconfirmed={accessReadUnconfirmed} onCopy={copyAccess} />}
    <div className="host-settings-list">
      {list?.requests.map(request => <section className="host-settings-card" key={request.device.deviceId}>
        <header><span className="host-card__icon"><Smartphone size={16} /></span>
          <div><strong><bdi>{request.device.name}</bdi></strong><small>等待本机确认 · {new Date(request.expiresAt).toLocaleString()} 到期</small></div>
          <span className="check-pill">确认码 {request.confirmationCode}</span>
          <button className="small-button" disabled={disabled || Date.now() >= request.expiresAt} onClick={() => void mutate(
            () => api.deviceManagement.approve({ deviceId: request.device.deviceId, confirmationCode: request.confirmationCode }),
            'Mac 已确认批准。请在手机继续领取授权；原会话保持。')}>批准 <bdi>{request.device.name}</bdi></button>
          <button className="small-button" disabled={disabled} onClick={() => void mutate(
            () => api.deviceManagement.reject({ deviceId: request.device.deviceId }), 'Mac 已确认拒绝此请求；已有授权与原会话保持。')}>拒绝 <bdi>{request.device.name}</bdi></button>
        </header><p className="field-hint">完整设备身份：<code>{request.device.deviceId}</code></p>
      </section>)}
      {list?.devices.map(device => <section className="host-settings-card" key={device.deviceId}>
        <header><span className="host-card__icon"><Smartphone size={16} /></span>
          <div><strong><bdi>{device.name}</bdi></strong><small>{device.revokedAt === undefined ? device.online ? '在线' : '离线' : '已撤销'} · {new Date(device.createdAt).toLocaleString()}</small></div>
          <span className="check-pill">{device.revokedAt === undefined ? '可操作本 Mac' : '授权已撤销'}</span>
          {device.revokedAt === undefined && <button className="small-button" disabled={disabled} onClick={() => void mutate(
            () => api.deviceManagement.revoke({ deviceId: device.deviceId }), 'Mac 已确认撤销此设备，结束它的读者；其他设备和原 Agent 会话保持。')}>撤销 <bdi>{device.name}</bdi></button>}
        </header><p className="field-hint">完整设备身份：<code>{device.deviceId}</code></p>
      {device.operationIssue && <p role="status" className="field-hint">{device.operationIssue}</p>}
      {device.operations?.length ? <details><summary>最近操作 · {device.operations.length} 条</summary><ol>{[...device.operations].reverse().map(operation => <li key={operation.id}><time>{new Date(operation.at).toLocaleString()}</time> · {operation.method} · <code>{operation.target}</code> · {operation.result === 'confirmed' ? '已提交' : operation.result === 'failed' ? '失败' : '结果未确认'}</li>)}</ol></details> : null}
      </section>)}
    </div>
    {list && !list.requests.length && !list.devices.length && <p className="settings-group-note">暂无已授权设备。生成并复制连接链接，在手机打开即可连接。</p>}
    {readIssue && <p className="settings-group-note" role="status">{readIssue}</p>}
    {notice && <p className="settings-group-note" role="status">{notice}</p>}
  </section>
}


/** Copy data as shell arguments; this view has no execution channel. */
function quotePosix(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function PrivateAccessDetails({ access, unconfirmed, onCopy }: {
  access: DeviceList['privateAccess']; unconfirmed: boolean;
  onCopy: (value: string, label: string) => Promise<void>
}) {
  const preparation = access.certificatePreparation
  const configurationPath = access.configurationPath
  const template = preparation ? `${preparation.electronRunAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${[
    preparation.executable, preparation.entry, '<私网 IP，请替换>', '<证书目录绝对路径，请替换>'
  ].map(quotePosix).join(' ')}` : null
  return <section className="host-settings-card" aria-label="Mac 私网接入">
    <header><span className="host-card__icon"><ShieldCheck size={16} /></span>
      <div><strong>Mac 私网连接</strong><small>{unconfirmed ? '上次读取的接入事实' : '原 Host 的接入事实'}</small></div>
      <span className="check-pill">{access.state === 'listening' ? 'HTTPS 已监听' : access.state === 'unavailable' ? '手机入口不可用' : '尚未配置手机入口'}</span>
    </header>
    {unconfirmed && <p className="host-check-detail" role="status">当前接入状态未重新核实；以下保留上次读取的事实，请刷新后核对。</p>}
    <p className="host-check-detail">{access.message}</p>
    {access.state === 'listening' && <>
      <div className="host-edit-grid">
        <label className="host-edit-grid__wide"><span>Mac 的 HTTPS 地址</span><input aria-label="Mac 的 HTTPS 地址" readOnly value={access.origin} /></label>
        <button className="small-button" onClick={() => void onCopy(access.origin, 'HTTPS 地址')}><Copy size={13} />复制 HTTPS 地址</button>
      </div>
      <p className="host-check-detail">当前服务器叶证书 SHA-256 指纹：<code>{access.certificateFingerprint}</code><br />有效期至：{new Date(access.expiresAt).toLocaleString()}</p>
      <p className="host-check-detail">这不是签发根证书指纹；请沿原证书准备输出核对手机需安装的公开根证书。监听不代表手机已可达，手机系统信任和设备授权仍需分别确认。</p>
      {access.assetIssue && <p className="host-check-detail" role="status">HTTPS 已监听，手机页面尚不可用：{access.assetIssue}。原会话和已授权设备保留；请修正原手机产物目录。</p>}
    </>}
    <details className="host-edit-disclosure" open={access.state !== 'listening'}>
      <summary>证书准备与启动配置</summary>
      <div className="host-edit-grid">
        {template !== null ? <>
          <label className="host-edit-grid__wide"><span>证书准备模板</span><textarea aria-label="证书准备命令模板" readOnly spellCheck={false} rows={3} value={template} /></label>
          <p className="field-hint host-edit-grid__wide">请先替换模板中的私网 IP 和证书目录绝对路径，再在 Mac 终端明确运行。此工具只准备材料，不修改手机系统信任或激活服务。</p>
          <button className="small-button" onClick={() => void onCopy(template, '证书准备模板')}><Copy size={13} />复制证书准备模板</button>
        </> : <p className="field-hint host-edit-grid__wide">证书准备入口尚未确认，没有生成可执行模板。请先确认原 Host 同一交付产物里的准备工具；已有连接和会话保持。</p>}
        {configurationPath ? <>
          <p className="field-hint host-edit-grid__wide">原启动 manifest：<code>{configurationPath}</code></p>
          <button className="small-button" onClick={() => void onCopy(`--private-access ${quotePosix(configurationPath)}`, 'manifest 启动参数')}><Copy size={13} />复制 manifest 启动参数</button>
        </> : <p className="field-hint host-edit-grid__wide">启动 manifest 来源未提供；请在原 Host 的明确启动动作中指定绝对路径，不按当前目录猜默认位置。</p>}
        <p className="field-hint host-edit-grid__wide">把明确的私网 IP、端口及证书绝对路径保存到原启动 manifest；手机页面还需同一源码构建的手机产物目录。原 Host 下次明确启动时读取；这些只读操作不会写配置、生成邀请、改变信任或重启当前会话。</p>
      </div>
    </details>
  </section>
}
