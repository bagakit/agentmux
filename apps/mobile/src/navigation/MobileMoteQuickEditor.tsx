import { MobileNotice } from '../notices/MobileNotice'
import { useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { MoteExecutorPriority } from '@agentmux/client-ui/components/MoteExecutorPriority'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { Switch, TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { DEFAULT_MOTE_PRESENCE, moteMinutesToMs, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { useMoteQuickDraft } from './useMoteQuickDraft'

const HEARTBEAT_MINUTES_ISSUE = '心跳间隔请填至少 1 分钟的整数。'

type Props = { target: MotePreferencesTarget; client: AgentMuxHostedClient | null; visible: boolean;
  copyText: ClientUiPlatform['copyText']; onClose(): void; onSaved(): void }
export function MobileMoteQuickEditor({ target, client, visible, copyText, onClose, onSaved }: Props) {
  const model = useMoteQuickDraft(target, client, visible, onSaved), { draft, read } = model
  const [copyIssue, setCopyIssue] = useState('')
  const presence = draft.values.presence ?? DEFAULT_MOTE_PRESENCE
  const minutes = draft.invalidHeartbeatInput ?? String(presence.intervalMs / 60000)
  const intervalIssue = draft.invalidHeartbeatInput === undefined ? null : HEARTBEAT_MINUTES_ISSUE
  const maintenance = read?.maintenance
  const maintenanceLabel = maintenance?.schedule?.status === 'stopped' ? '心跳安排已停止' : maintenance ? {
    active: '已安排自动心跳', paused: '心跳安排已暂停', disabled: '自动维持未启用', unbound: '主对话尚未绑定', unconfirmed: '实际安排尚未确认'
  }[maintenance.status] : '实际安排尚未读取'
  const copy = (value: unknown) => { setCopyIssue(''); void copyText(JSON.stringify(value, null, 2), error => setCopyIssue(error instanceof Error ? error.message : String(error))) }
  const blocked = draft.attempts.find(a => a.input.operationId === draft.blockedAttemptId)
  return <section className="mobile-mote-quick-editor" aria-label="Mote 快捷配置编辑">
    <button type="button" className="mobile-text-button" onClick={onClose}>返回 Profile</button><h3>快捷配置</h3>
    <p>设置执行器顺序和心跳。</p>
    {read?.status === 'ready' && (!read.choices || read.choices.executors === null) && <p role="status">正在读取其余候选；已保存的配置仍可编辑和保存。</p>}
    {read?.choices?.issues && <MobileNotice kind="warning" owner={client} identity={[JSON.stringify(target),read.choices.issues.executors,read.choices.issues.locations]} role="status">{Object.values(read.choices.issues).join(' ')}<button type="button" className="mobile-text-button" onClick={() => { void model.inspect() }}>重新核对候选</button></MobileNotice>}
    <MobileNotice dismissible={!model.busy && !model.adoptionBusy} kind={blocked && !model.busy && !model.adoptionBusy ? "warning" : "feedback"} owner={client} identity={[JSON.stringify(target),blocked?.input.operationId,blocked?.phase,model.notice]} role="status">{model.busy ? '正在保存配置…' : model.adoptionBusy ? '正在采用当前修订…' : blocked ? '保存还没确认。' : model.notice || '正在核对配置…'}</MobileNotice>
    <form noValidate onKeyDown={event => {
      if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault()
    }} onSubmit={event => { event.preventDefault()
      if (moteMinutesToMs(minutes, { wholeMinutes: true }) === null) {
        if (draft.invalidHeartbeatInput === undefined) model.editHeartbeatMinutes(minutes)
        event.currentTarget.querySelector<HTMLInputElement>('input[name="heartbeatMinutes"]')?.focus()
        return
      }
      void model.save()
    }}>
      <MoteExecutorPriority language="zh" defaults={draft.values} choices={read?.choices?.executors ?? []} onChange={model.edit} />
      <fieldset className="mobile-mote-presence"><legend>主 Agent 驻留与心跳</legend>
        <label><Switch aria-label="启用 Mote 自动维持" checked={presence.enabled} onChange={event => model.edit({ ...draft.values, presence: { ...presence, enabled: event.target.checked } })} />启用自动维持</label>
        <FormRow layout="stacked" label="心跳间隔（分钟）"
          description="默认每 30 分钟核对目标、工作 thread 和未完成承诺；没有新进展时可保持安静。修改间隔不会恢复已经暂停的安排。"
          error={intervalIssue} invalid={Boolean(intervalIssue)}>
          {field => <TextInput {...field} name="heartbeatMinutes" type="number" inputMode="numeric" min="1" step="1" required value={minutes}
            onChange={event => model.editHeartbeatMinutes(event.target.value)} />}
        </FormRow>
        <p data-mote-maintenance-status={maintenance?.status ?? 'unread'}>{maintenanceLabel}</p>
        {maintenance?.issue && <p role="status">{maintenance.issue}</p>}
        {maintenance?.schedule && <>
          <p>心跳间隔：{maintenance.schedule.everyMs ? maintenance.schedule.everyMs / 60000 + ' 分钟' : '尚未确认'}。
            {maintenance.schedule.lastOutcome === 'unknown' ? '最近一次投递还没确认。' : maintenance.schedule.lastOutcome === 'sent' ? '最近一次投递已确认；不代表任务完成。' : maintenance.schedule.lastOutcome === 'skipped' ? '最近一次检查未投递。' : '尚无已确认投递。'}</p>
          <details><summary>心跳安排与来源</summary><pre>{JSON.stringify(maintenance.schedule, null, 2)}</pre></details>
        </>}
        <button type="button" className="mobile-text-button" onClick={() => { void model.inspect() }}>刷新实际安排</button>
        {maintenance?.schedule?.status === 'paused' && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.resumeMaintenance() }}>恢复心跳安排</button>}
        {!!draft.maintenanceAttempts?.length && <details><summary>心跳恢复请求 · {draft.maintenanceAttempts.length}</summary>{draft.maintenanceAttempts.map(operation => <article key={operation.input.operationId}>
          <p>{operation.phase === 'confirmed' ? '恢复已确认' : operation.phase === 'observed' ? '已读到恢复记录' : operation.phase === 'not-sent' ? '恢复尚未发送' : '恢复待核对'}</p>{operation.issue && <p>{operation.issue}</p>}
          {operation.phase === 'unknown' && <button type="button" className="mobile-text-button" disabled={model.busy} onClick={() => { void model.resumeMaintenance(operation) }}>{model.preparedResumeOperationId === operation.input.operationId ? '继续这次恢复' : '核对这次恢复'}</button>}
          <pre>{JSON.stringify(operation, null, 2)}</pre>
        </article>)}</details>}
      </fieldset>
      <div className="mobile-mote-file-editor__actions"><button type="submit" className="mobile-text-button" disabled={model.busy || model.adoptionBusy}>保存快捷配置</button>
        <button type="button" className="mobile-text-button" onClick={() => { void model.inspect() }}>核对当前配置</button>
        <button type="button" className="mobile-text-button" onClick={() => copy(draft)}>复制配置与请求</button></div>
    </form>
    {read?.status === 'ready' && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.adopt() }}>采用当前修订，保留我的选择</button>}
    {model.storageIssue && <><MobileNotice owner={client} identity={[JSON.stringify(target),model.storageIssue]} role="status">设备备份尚未确认；本页选择与请求保留。</MobileNotice><details><summary>设备保存详情</summary><MobileNotice owner={client} identity={[JSON.stringify(target),model.storageIssue]}>{model.storageIssue}</MobileNotice></details>

      {model.conflict && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.chooseStored() }}>保全本页并采用设备上的配置</button>}</>}
    {model.notice && <details><summary>本次操作详情</summary><p>{model.notice}</p></details>}
    {copyIssue && <details open><summary>复制未完成</summary><p>{copyIssue}</p></details>}
    {read && <details><summary>当前原文与修订</summary><p>当前读取不确认旧保存。</p><pre>{JSON.stringify(read.source, null, 2)}</pre>{read.issue && <p>{read.issue}</p>}</details>}
    {!!draft.attempts.length && <details><summary>上次保存请求 · {draft.attempts.length}</summary>{draft.attempts.map(a => <article key={a.input.operationId}>
      <p>{a.phase} · {a.input.operationId}</p>{a.issue && <p>{a.issue}</p>}<pre>{JSON.stringify(a.input, null, 2)}</pre>{a.result && <pre>{JSON.stringify(a.result, null, 2)}</pre>}</article>)}</details>}
    {!!model.copies.length && <details><summary>保全的本页配置 · {model.copies.length}</summary>{model.copies.map((value, index) => <button type="button" className="mobile-text-button" key={index} onClick={() => copy(value)}>复制第 {index + 1} 份配置与请求</button>)}</details>}
  </section>
}
