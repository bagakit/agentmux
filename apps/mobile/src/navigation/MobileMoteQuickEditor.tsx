import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { DEFAULT_MOTE_PRESENCE, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { useMoteQuickDraft } from './useMoteQuickDraft'

type Props = { target: MotePreferencesTarget; client: AgentMuxHostedClient | null; visible: boolean;
  copyText: ClientUiPlatform['copyText']; onClose(): void; onSaved(): void }
export function MobileMoteQuickEditor({ target, client, visible, copyText, onClose, onSaved }: Props) {
  const model = useMoteQuickDraft(target, client, visible, onSaved), { draft, read } = model
  const [copyIssue, setCopyIssue] = useState('')
  const presence = draft.values.presence ?? DEFAULT_MOTE_PRESENCE
  const [minutes, setMinutes] = useState(String(presence.intervalMs / 60000))
  const [intervalIssue, setIntervalIssue] = useState('')
  useEffect(() => { setMinutes(String(presence.intervalMs / 60000)); setIntervalIssue('') }, [presence.intervalMs])
  const maintenance = read?.maintenance
  const maintenanceLabel = maintenance?.schedule?.status === 'stopped' ? '原安排已停止' : maintenance ? {
    active: '已安排自动心跳', paused: '原心跳安排已暂停', disabled: '自动维持未启用', unbound: '主对话尚未绑定', unconfirmed: '实际安排尚未确认'
  }[maintenance.status] : '实际安排尚未读取'
  const copy = (value: unknown) => { setCopyIssue(''); void copyText(JSON.stringify(value, null, 2), error => setCopyIssue(error instanceof Error ? error.message : String(error))) }
  const executor = draft.values.executorId ?? '', conversations = read?.choices.conversations ?? [], executors = read?.choices.executors ?? []
  const conversation = draft.values.conversation ? JSON.stringify(draft.values.conversation) : ''
  const destinations = read?.choices.destinations ?? [], destination = model.destination ? JSON.stringify(model.destination) : ''
  const blocked = draft.attempts.find(a => a.input.operationId === draft.blockedAttemptId)
  return <section className="mobile-mote-quick-editor" aria-label="Mote 快捷配置编辑">
    <button type="button" className="mobile-text-button" onClick={onClose}>返回 Profile</button><h3>快捷配置</h3>
    <p>设置承接主对话的 Agent 与自动心跳。配置保存、原会话接回和心跳投递分别确认。</p>
    <MobileNotice dismissible={!model.busy && !model.adoptionBusy} kind={blocked && !model.busy && !model.adoptionBusy ? "warning" : "feedback"} owner={client} identity={[JSON.stringify(target),blocked?.input.operationId,blocked?.phase,model.notice]} role="status">{model.busy ? '正在保存原配置…' : model.adoptionBusy ? '正在采用当前修订…' : blocked ? '原保存未确认；选择和请求保留。' : model.notice || '正在核对原配置…'}</MobileNotice>
    <form onSubmit={event => { event.preventDefault()
      if (!minutes.trim() || !Number.isSafeInteger(Number(minutes)) || !Number.isSafeInteger(Number(minutes) * 60000) || Number(minutes) < 1) { setIntervalIssue('心跳间隔请填至少 1 分钟的整数；原设置与选择保留。'); return }
      void model.save()
    }}>
      <label>新对话使用的 Agent<select aria-label="新对话使用的 Agent" value={executor} onChange={event => {
        const { executorId: _old, ...values } = draft.values; model.edit(event.target.value ? { ...values, executorId: event.target.value } : values)
      }}><option value="">未设置</option>{executor && !executors.some(e => e.id === executor) && <option value={executor}>保留已保存的 Agent（尚未确认）</option>}
        {executors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <label>原主对话<select aria-label="原主对话" value={conversation} onChange={event => {
        const { conversation: _old, ...values } = draft.values, choice = conversations.find(c => JSON.stringify(c.reference) === event.target.value)
        model.edit(choice ? { ...values, conversation: choice.reference } : values)
      }}><option value="">未选择</option>{conversation && !conversations.some(c => JSON.stringify(c.reference) === conversation) && <option value={conversation}>保留原主对话引用（尚未确认）</option>}
        {conversations.map(c => <option key={JSON.stringify(c.reference)} value={JSON.stringify(c.reference)}>{c.label}</option>)}</select></label>
      <fieldset className="mobile-mote-presence"><legend>主 Agent 驻留与心跳</legend>
        <label><input type="checkbox" aria-label="启用 Mote 自动维持" checked={presence.enabled} onChange={event => model.edit({ ...draft.values, presence: { ...presence, enabled: event.target.checked } })} />启用自动维持</label>
        <label>心跳间隔（分钟）<input type="number" inputMode="numeric" min="1" step="1" required aria-label="心跳间隔（分钟）" value={minutes} onChange={event => {
          const value = event.target.value; setMinutes(value)
          if (value.trim() && Number.isSafeInteger(Number(value)) && Number.isSafeInteger(Number(value) * 60000) && Number(value) >= 1) {
            setIntervalIssue(''); model.edit({ ...draft.values, presence: { ...presence, intervalMs: Number(value) * 60000 } })
          } else setIntervalIssue('心跳间隔请填至少 1 分钟的整数；原设置与选择保留。')
        }} /></label>
        <p>默认每 30 分钟核对目标、工作 thread 和未完成承诺；没有新进展时可保持安静。修改间隔不会恢复已经暂停的安排。</p>
        {intervalIssue && <p role="status">{intervalIssue}</p>}
        <p data-mote-maintenance-status={maintenance?.status ?? 'unread'}>{maintenanceLabel}</p>
        {maintenance?.issue && <p role="status">{maintenance.issue}</p>}
        {maintenance?.schedule && <>
          <p>原安排间隔：{maintenance.schedule.everyMs ? maintenance.schedule.everyMs / 60000 + ' 分钟' : '尚未确认'}。
            {maintenance.schedule.lastOutcome === 'unknown' ? '最近一次投递尚未确认，原操作保留。' : maintenance.schedule.lastOutcome === 'sent' ? '最近一次投递已确认；不代表任务完成。' : maintenance.schedule.lastOutcome === 'skipped' ? '最近一次检查未投递。' : '尚无已确认投递。'}</p>
          <details><summary>原心跳安排与来源</summary><pre>{JSON.stringify(maintenance.schedule, null, 2)}</pre></details>
        </>}
        <button type="button" className="mobile-text-button" onClick={() => { void model.inspect() }}>刷新实际安排</button>
        {maintenance?.schedule?.status === 'paused' && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.resumeMaintenance() }}>明确恢复原心跳安排</button>}
        {!!draft.maintenanceAttempts?.length && <details><summary>原心跳恢复请求 · {draft.maintenanceAttempts.length}</summary>{draft.maintenanceAttempts.map(operation => <article key={operation.input.operationId}>
          <p>{operation.phase === 'confirmed' ? '原恢复已确认' : operation.phase === 'observed' ? '已读到原恢复记录' : operation.phase === 'not-sent' ? '原恢复尚未发送' : '原恢复待核对'}</p>{operation.issue && <p>{operation.issue}</p>}
          {operation.phase === 'unknown' && <button type="button" className="mobile-text-button" onClick={() => { void model.resumeMaintenance(operation) }}>核对原恢复请求</button>}
          <pre>{JSON.stringify(operation, null, 2)}</pre>
        </article>)}</details>}
      </fieldset>
      {destinations.length > 1 ? <label>保存位置<select aria-label="保存位置" value={destination} onChange={event => model.setDestination(destinations.find(d => JSON.stringify(d.reference) === event.target.value)?.reference ?? null)}>
        <option value="">选择原展示位置</option>{destinations.map(d => <option key={JSON.stringify(d.reference)} value={JSON.stringify(d.reference)}>{d.label}</option>)}</select></label>
        : <p>{destinations.length === 1 ? `保存位置：${destinations[0]!.label}` : '原保存位置尚未确认；可保留或复制选择，重新核对。'}</p>}
      <div className="mobile-mote-file-editor__actions"><button type="submit" className="mobile-text-button" disabled={model.busy || model.adoptionBusy}>保存快捷配置</button>
        <button type="button" className="mobile-text-button" onClick={() => { void model.inspect() }}>核对当前配置</button>
        <button type="button" className="mobile-text-button" onClick={() => copy(draft)}>复制配置与请求</button></div>
    </form>
    {read?.status === 'ready' && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.adopt() }}>采用当前修订，保留我的选择</button>}
    {model.storageIssue && <><MobileNotice owner={client} identity={[JSON.stringify(target),model.storageIssue]} role="status">设备备份尚未确认；本页选择与请求保留。</MobileNotice><details><summary>设备保存详情</summary><MobileNotice owner={client} identity={[JSON.stringify(target),model.storageIssue]}>{model.storageIssue}</MobileNotice></details>

      {model.conflict && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.chooseStored() }}>保全本页并采用设备原稿</button>}</>}
    {model.notice && <details><summary>本次操作详情</summary><p>{model.notice}</p></details>}
    {copyIssue && <details open><summary>复制未完成</summary><p>{copyIssue}</p></details>}
    {read && <details><summary>当前原文与修订</summary><p>当前读取不确认旧保存。</p><pre>{JSON.stringify(read.source, null, 2)}</pre>{read.issue && <p>{read.issue}</p>}</details>}
    {!!draft.attempts.length && <details><summary>原保存请求 · {draft.attempts.length}</summary>{draft.attempts.map(a => <article key={a.input.operationId}>
      <p>{a.phase} · {a.input.operationId}</p>{a.issue && <p>{a.issue}</p>}<pre>{JSON.stringify(a.input, null, 2)}</pre>{a.result && <pre>{JSON.stringify(a.result, null, 2)}</pre>}</article>)}</details>}
    {!!model.copies.length && <details><summary>保全的本页配置 · {model.copies.length}</summary>{model.copies.map((value, index) => <button type="button" className="mobile-text-button" key={index} onClick={() => copy(value)}>复制第 {index + 1} 份配置与请求</button>)}</details>}
  </section>
}
