import { useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { useMoteQuickDraft } from './useMoteQuickDraft'

type Props = { target: MotePreferencesTarget; client: AgentMuxHostedClient | null; visible: boolean;
  copyText: ClientUiPlatform['copyText']; onClose(): void; onSaved(): void }
export function MobileMoteQuickEditor({ target, client, visible, copyText, onClose, onSaved }: Props) {
  const model = useMoteQuickDraft(target, client, visible, onSaved), { draft, read } = model
  const [copyIssue, setCopyIssue] = useState('')
  const copy = (value: unknown) => { setCopyIssue(''); void copyText(JSON.stringify(value, null, 2), error => setCopyIssue(error instanceof Error ? error.message : String(error))) }
  const executor = draft.values.executorId ?? '', conversations = read?.choices.conversations ?? [], executors = read?.choices.executors ?? []
  const conversation = draft.values.conversation ? JSON.stringify(draft.values.conversation) : ''
  const destinations = read?.choices.destinations ?? [], destination = model.destination ? JSON.stringify(model.destination) : ''
  const blocked = draft.attempts.find(a => a.input.operationId === draft.blockedAttemptId)
  return <section className="mobile-mote-quick-editor" aria-label="Mote 快捷配置编辑">
    <button type="button" className="mobile-text-button" onClick={onClose}>返回 Profile</button><h3>快捷配置</h3>
    <p>设置新对话使用的 Agent、原主对话和接回时机。保存不启动会话。</p>
    <p role="status">{model.busy ? '正在保存原配置…' : model.adoptionBusy ? '正在采用当前修订…' : blocked ? '原保存未确认；选择和请求保留。' : model.notice || '正在核对原配置…'}</p>
    <form onSubmit={event => { event.preventDefault(); void model.save() }}>
      <label>新对话使用的 Agent<select aria-label="新对话使用的 Agent" value={executor} onChange={event => {
        const { executorId: _old, ...values } = draft.values; model.edit(event.target.value ? { ...values, executorId: event.target.value } : values)
      }}><option value="">未设置</option>{executor && !executors.some(e => e.id === executor) && <option value={executor}>保留已保存的 Agent（尚未确认）</option>}
        {executors.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <label>原主对话<select aria-label="原主对话" value={conversation} onChange={event => {
        const { conversation: _old, ...values } = draft.values, choice = conversations.find(c => JSON.stringify(c.reference) === event.target.value)
        model.edit(choice ? { ...values, conversation: choice.reference } : values)
      }}><option value="">未选择</option>{conversation && !conversations.some(c => JSON.stringify(c.reference) === conversation) && <option value={conversation}>保留原主对话引用（尚未确认）</option>}
        {conversations.map(c => <option key={JSON.stringify(c.reference)} value={JSON.stringify(c.reference)}>{c.label}</option>)}</select></label>
      {read?.main ? <p>Main Mote 在启动时接回原主对话。{draft.values.recovery === 'on-open' && <button type="button" className="mobile-text-button" onClick={() => model.edit({ ...draft.values, recovery: 'startup' })}>设为启动时</button>}</p>
        : <label>接回时机<select aria-label="接回时机" value={draft.values.recovery ?? ''} onChange={event => {
          const { recovery: _old, ...values } = draft.values, next = event.target.value
          model.edit(next === 'startup' || next === 'on-open' ? { ...values, recovery: next } : values)
        }}><option value="">未设置</option><option value="startup">启动时</option><option value="on-open">打开时</option></select></label>}
      {destinations.length > 1 ? <label>保存位置<select aria-label="保存位置" value={destination} onChange={event => model.setDestination(destinations.find(d => JSON.stringify(d.reference) === event.target.value)?.reference ?? null)}>
        <option value="">选择原展示位置</option>{destinations.map(d => <option key={JSON.stringify(d.reference)} value={JSON.stringify(d.reference)}>{d.label}</option>)}</select></label>
        : <p>{destinations.length === 1 ? `保存位置：${destinations[0]!.label}` : '原保存位置尚未确认；可保留或复制选择，重新核对。'}</p>}
      <div className="mobile-mote-file-editor__actions"><button type="submit" className="mobile-text-button" disabled={model.busy || model.adoptionBusy}>保存快捷配置</button>
        <button type="button" className="mobile-text-button" onClick={() => { void model.inspect() }}>核对当前配置</button>
        <button type="button" className="mobile-text-button" onClick={() => copy(draft)}>复制配置与请求</button></div>
    </form>
    {read?.status === 'ready' && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.adopt() }}>采用当前修订，保留我的选择</button>}
    {model.storageIssue && <><p role="status">设备备份尚未确认；本页选择与请求保留。</p><details><summary>设备保存详情</summary><p>{model.storageIssue}</p></details>

      {model.conflict && <button type="button" className="mobile-text-button" disabled={model.busy || model.adoptionBusy} onClick={() => { void model.chooseStored() }}>保全本页并采用设备原稿</button>}</>}
    {model.notice && <details><summary>本次操作详情</summary><p>{model.notice}</p></details>}
    {copyIssue && <details open><summary>复制未完成</summary><p>{copyIssue}</p></details>}
    {read && <details><summary>当前原文与修订</summary><p>当前读取不确认旧保存。</p><pre>{JSON.stringify(read.source, null, 2)}</pre>{read.issue && <p>{read.issue}</p>}</details>}
    {!!draft.attempts.length && <details><summary>原保存请求 · {draft.attempts.length}</summary>{draft.attempts.map(a => <article key={a.input.operationId}>
      <p>{a.phase} · {a.input.operationId}</p>{a.issue && <p>{a.issue}</p>}<pre>{JSON.stringify(a.input, null, 2)}</pre>{a.result && <pre>{JSON.stringify(a.result, null, 2)}</pre>}</article>)}</details>}
    {!!model.copies.length && <details><summary>保全的本页配置 · {model.copies.length}</summary>{model.copies.map((value, index) => <button type="button" className="mobile-text-button" key={index} onClick={() => copy(value)}>复制第 {index + 1} 份配置与请求</button>)}</details>}
  </section>
}
