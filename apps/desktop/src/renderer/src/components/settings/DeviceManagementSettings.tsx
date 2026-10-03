import { Copy, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'

type DeviceList = AgentMuxRpcResult<'device.ls'>
const operationLabels: Readonly<Record<string, string>> = { submitAgentPrompt: '发送消息', writeAgent: '终端输入', pasteAgent: '粘贴输入', respondAgentPermission: '回应权限请求', answerAgentRequest: '回答请求', resizeAgent: '调整终端尺寸', signalAgent: '发送进程信号', stopAgent: '停止 Agent', resumeAgent: '恢复 Agent', createAgent: '创建 Agent', removeAgent: '移除 Agent' }

export function DeviceManagementSettings({ active }: { active: boolean }) {
  const [list, setList] = useState<DeviceList | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(''), [readIssue, setReadIssue] = useState('')
  const [refreshing, setRefreshing] = useState(false), [observedAt, setObservedAt] = useState<number | null>(null)
  const generation = useRef(0), pending = useRef(false), readSequence = useRef(0)
  const read = async (epoch = generation.current) => {
    const sequence = ++readSequence.current
    setRefreshing(true)
    try { const facts = await api.deviceManagement.ls({}); if (epoch === generation.current && sequence === readSequence.current) { setList(facts); setReadIssue(''); setObservedAt(Date.now()) } }
    catch (error) { if (epoch === generation.current && sequence === readSequence.current) setReadIssue(`设备状态暂不可读，原记录保留。${presentError(error)}`) }
    finally { if (epoch === generation.current && sequence === readSequence.current) setRefreshing(false) }
  }
  useEffect(() => {
    const epoch = ++generation.current
    if (!active) return
    void read(epoch)
    const timer = setInterval(() => { void read(generation.current) }, 5000)
    return () => { generation.current++; clearInterval(timer) }
  }, [active])
  const link = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    const epoch = generation.current
    try {
      const value = await api.deviceManagement.link({})
      if (epoch !== generation.current) return
      setUrl(value.url)
      try { await api.ui.writeClipboardText(value.url); setNotice('链接已复制，在同一局域网的手机打开即可操作。') }
      catch { setNotice('链接已生成，请复制下方完整链接。') }
    } catch (error) { if (epoch === generation.current) setNotice(`暂时无法生成连接链接，可稍后重试。${presentError(error)}`) }
    finally { pending.current = false; setBusy(false) }
  }
  const revoke = async (deviceId: string) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    const epoch = ++generation.current
    try { await api.deviceManagement.revoke({ deviceId }); if (epoch === generation.current) { setNotice('已断开此设备，Agent 会话继续保留。'); await read(epoch) } }
    catch (error) { if (epoch === generation.current) { setNotice(`撤销结果尚未确认，请查看刷新后的设备状态。${presentError(error)}`); await read(epoch) } }
    finally { pending.current = false; setBusy(false) }
  }
  if (!active) return null
  const devices = list?.devices.filter(device => device.revokedAt === undefined) ?? []
  return <section className="settings-group" data-device-view="settings">
    <h3>连接手机</h3>
    <p className="settings-group-note">手机和 Mac 连接同一 Wi-Fi，复制完整链接到手机浏览器打开。无需填写地址或回到 Mac 批准。</p>
    <p className="settings-group-note">{list ? `${devices.filter(device => device.online).length} 当前在线 · ${devices.length} 已授权` : '设备状态尚未核实'}</p>

    <div className="settings-pane-toolbar">

      <button className="primary-button" disabled={busy} onClick={() => { void link() }}>{busy ? <LoaderCircle size={16} /> : <Copy size={16} />}生成并复制连接链接</button>
    </div>
    {list && <p className="settings-group-note" role="status">{list.mobileAccess.state === 'connected' ? '连接服务已就绪' : list.mobileAccess.state === 'starting' ? '连接服务正在启动，稍后可重试' : '连接服务暂不可用'}</p>}
    {list && list.mobileAccess.state !== 'connected' && <details><summary>查看连接详情</summary><p className="settings-group-note">{list.mobileAccess.message}</p></details>}
    {url && <input className="settings-input" aria-label="手机连接链接" readOnly value={url} onFocus={event => event.target.select()} />}
    <div className="settings-pane-toolbar"><h3>已连接设备</h3><button className="small-button" disabled={refreshing} onClick={() => { void read() }}>{refreshing ? <LoaderCircle size={16} /> : <RefreshCw size={16} />}{refreshing ? '查询中…' : '刷新状态'}</button></div>
    {observedAt && <p className="settings-hint">最近查询 {new Date(observedAt).toLocaleTimeString('zh-CN')}</p>}
    {devices.map(device => <section className="host-settings-card" key={device.deviceId}>
      <div className="settings-pane-toolbar"><Smartphone size={16} /><strong>{device.name}</strong><span>{device.online ? '在线' : '离线'}</span>
        <button className="small-button" disabled={busy} onClick={() => { void revoke(device.deviceId) }}>撤销访问</button></div>
      <><p className="settings-group-note">{device.lastSeenAt ? `最近活动 ${new Date(device.lastSeenAt).toLocaleString('zh-CN')}` : '暂无操作记录'}</p>
        {device.operations?.slice(-10).reverse().map(operation => <p className="settings-group-note" key={operation.id}><time>{new Date(operation.at).toLocaleString('zh-CN')}</time> · {operationLabels[operation.method] ?? operation.method} · {operation.target} · {operation.result === 'confirmed' ? '已提交' : operation.result === 'failed' ? '失败' : '结果未知'}</p>)}</>
      {device.operationIssue && <p className="settings-group-note" role="status">{device.operationIssue}</p>}
    </section>)}
    {list && !devices.length && <p className="settings-group-note">暂无连接设备，手机打开链接后会自动出现。</p>}
    {readIssue && <p className="settings-group-note" role="status">{readIssue}</p>}
    {notice && <p className="settings-group-note" role="status">{notice}</p>}
  </section>
}
