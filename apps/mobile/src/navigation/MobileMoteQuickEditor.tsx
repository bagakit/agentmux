import { MobileNotice } from '../notices/MobileNotice'
import { useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { Switch, TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { DEFAULT_MOTE_PRESENCE, moteMinutesToMs, sameMoteDefaultConversation, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { useMoteQuickDraft } from './useMoteQuickDraft'

const HEARTBEAT_MINUTES_ISSUE = '心跳间隔请填至少 1 分钟的整数。'
const ROLLOVER_MINUTES_ISSUE = '请填写大于 0 的空闲分钟数，例如 20 或 1.5。'

type Props = { target: MotePreferencesTarget; client: AgentMuxHostedClient | null; visible: boolean;
  copyText: ClientUiPlatform['copyText']; onClose(): void; onSaved(): void }
export function MobileMoteQuickEditor({ target, client, visible, copyText, onClose, onSaved }: Props) {
  const model = useMoteQuickDraft(target, client, visible, onSaved), { draft, read } = model
  const [copyIssue, setCopyIssue] = useState('')
  const presence = draft.values.presence ?? DEFAULT_MOTE_PRESENCE
  const minutes = draft.invalidHeartbeatInput ?? String(presence.intervalMs / 60000)
  const intervalIssue = draft.invalidHeartbeatInput === undefined ? null : HEARTBEAT_MINUTES_ISSUE
  const rollover = draft.values.conversationRollover
  const rolloverKind = draft.conversationRolloverEditor?.kind ?? rollover?.kind ?? 'keep-current'
  const rolloverMinutes = draft.conversationRolloverEditor?.minutes ?? (rollover?.kind === 'idle' ? String(rollover.idleMs / 60000) : '')
  const [rolloverIssue, setRolloverIssue] = useState('')
  function editRollover(kind: 'keep-current' | 'idle', value: string) {
    setRolloverIssue('')
    const values = kind === 'keep-current' ? { ...draft.values, conversationRollover: { kind } }
      : moteMinutesToMs(value) !== null ? { ...draft.values, conversationRollover: { kind, idleMs: moteMinutesToMs(value)! } } : draft.values
    model.edit(values, { kind, minutes: value })
  }
  const maintenance = read?.maintenance
  const maintenanceLabel = maintenance?.schedule?.status === 'stopped' ? '心跳安排已停止' : maintenance ? {
    active: '已安排自动心跳', paused: '心跳安排已暂停', disabled: '自动维持未启用', unbound: '主对话尚未绑定', unconfirmed: '实际安排尚未确认'
  }[maintenance.status] : '实际安排尚未读取'
  const copy = (value: unknown) => { setCopyIssue(''); void copyText(JSON.stringify(value, null, 2), error => setCopyIssue(error instanceof Error ? error.message : String(error))) }
  const executor = draft.values.executorId ?? '', conversations = read?.choices?.conversations ?? [], executors = read?.choices?.executors ?? []
  const conversation = draft.values.conversation ? JSON.stringify(draft.values.conversation) : ''
  const destinations = read?.choices?.destinations ?? [], destination = model.destination ? JSON.stringify(model.destination) : ''
  const changesMain = draft.baseline !== null && !sameMoteDefaultConversation(draft.baseline.defaults.conversation, draft.values.conversation)
  const blocked = draft.attempts.find(a => a.input.operationId === draft.blockedAttemptId)
  return <section className="mobile-mote-quick-editor" aria-label="Mote 快捷配置编辑">
    <button type="button" className="mobile-text-button" onClick={onClose}>返回 Profile</button><h3>快捷配置</h3>
    <p>设置主对话、自动流转策略与心跳。</p>
    {read?.status === 'ready' && (!read.choices || read.choices.executors === null || read.choices.destinations === null) && <p role="status">正在读取其余候选；已保存的配置仍可编辑和保存。</p>}
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
      if (rolloverKind === 'idle' && moteMinutesToMs(rolloverMinutes) === null) {
        setRolloverIssue(ROLLOVER_MINUTES_ISSUE)
        event.currentTarget.querySelector<HTMLInputElement>('input[name="rolloverMinutes"]')?.focus()
        return
      }
      void model.save()
    }}>
      <label>新对话使用的 Agent<select aria-label="新对话使用的 Agent" value={executor} onChange={event => {
        const { executorId: _old, ...values } = draft.values; model.edit(event.target.value ? { ...values, executorId: event.target.value } : values)
      }}><option value="">未设置</option>{executor && !executors.some(e => e.id === executor) && <option value={executor}>保留已保存的 Agent（尚未确认）</option>}
        {executors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <label>主对话<select aria-label="主对话" value={conversation} onChange={event => {
        const { conversation: _old, ...values } = draft.values, choice = conversations.find(c => JSON.stringify(c.reference) === event.target.value)
        model.edit(choice ? { ...values, conversation: choice.reference } : values)
      }}><option value="">未选择</option>{conversation && !conversations.some(c => JSON.stringify(c.reference) === conversation) && <option value={conversation}>保留已保存的主对话（尚未确认）</option>}
        {conversations.map(c => <option key={JSON.stringify(c.reference)} value={JSON.stringify(c.reference)}>{c.label}</option>)}</select></label>
      <fieldset className="mobile-mote-presence"><legend>主对话自动流转</legend>
        <label>自动流转策略<select aria-label="自动流转策略" value={rolloverKind} onChange={event => editRollover(event.target.value as 'keep-current' | 'idle', rolloverMinutes)}>
          <option value="keep-current">保持当前对话</option><option value="idle">空闲后新一轮</option>
        </select></label>
        {rolloverKind === 'idle' && <FormRow layout="stacked" label="对话空闲时长（分钟）"
          description="填写大于 0 的分钟数，可用小数。" error={rolloverIssue} invalid={Boolean(rolloverIssue)}>
          {field => <TextInput {...field} name="rolloverMinutes" type="number" inputMode="decimal" min="0" step="any" value={rolloverMinutes}
            onChange={event => editRollover('idle', event.target.value)} />}
        </FormRow>}
        <p>保存后才生效。达到空闲时长后，下次新问题再开启新一轮；旧对话保留。保存不会立即切换主对话，也不会发送消息。</p>
        {!read || read.status !== 'ready' ? <p>已保存的流转策略尚未确认；当前选择保留。</p> : !read.defaults?.conversationRollover && <p>配置中还没有流转策略，不修改时保持当前对话。</p>}
      </fieldset>
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
          {operation.phase === 'unknown' && <button type="button" className="mobile-text-button" onClick={() => { void model.resumeMaintenance(operation) }}>核对这次恢复</button>}
          <pre>{JSON.stringify(operation, null, 2)}</pre>
        </article>)}</details>}
      </fieldset>
      {changesMain ? destinations.length > 1 ? <label>主对话展示位置<select aria-label="主对话展示位置" value={destination} onChange={event => model.setDestination(destinations.find(d => JSON.stringify(d.reference) === event.target.value)?.reference ?? null)}>
        <option value="">选择展示位置</option>{destinations.map(d => <option key={JSON.stringify(d.reference)} value={JSON.stringify(d.reference)}>{d.label}</option>)}</select></label>
        : <p>{destinations.length === 1 ? `主对话展示位置：${destinations[0]!.label}` : '更换主对话需要确认展示位置，可以重新核对。'}</p>
        : draft.baseline ? <p>保存偏好无需选择展示位置，也不会切换主对话。</p> : null}
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
