import { useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { moteFileBaseline } from '../recovery/mote-file-drafts'
import { useMoteFileDraft, type MoteFileEditTarget } from './useMoteFileDraft'

type Props = { target: MoteFileEditTarget; client: AgentMuxHostedClient | null; visible: boolean;
  copyText: ClientUiPlatform['copyText']; onClose(): void; onSaved(): void; onRead(): void }
/** Plain original text only; semantic configuration stays with its existing owner. */
export function MobileMoteFileEditor({ target, client, visible, copyText, onClose, onSaved, onRead }: Props) {
  const model = useMoteFileDraft(target, client, visible, onSaved, onRead)
  const { draft, checked } = model
  const [copyIssue, setCopyIssue] = useState('')
  const copy = (text: string) => { setCopyIssue(''); void copyText(text, error => setCopyIssue(error instanceof Error ? error.message : String(error))) }
  const pending = draft.attempts.find(value => value.attemptId === draft.blockedAttemptId)
  const baseline = checked ? moteFileBaseline(checked.read) : null
  const status = model.notice.startsWith('原文件已保存') ? model.notice : model.notice.startsWith('已核对') ? '已核对当前原文件；未知保存仍未确认。'
    : model.notice.startsWith('已采用') ? '已采用原修订；下次保存须明确提交。' : model.notice ? '本次操作未完成；正文保留，可查看详情。' : '编辑原稿；保存只影响这份原文件。'
  return <section className="mobile-mote-file-editor" aria-label="Mote 原稿编辑" data-mote-file-path={target.path}>
    <button type="button" className="mobile-text-button" onClick={onClose}>返回原文件</button>
    <h3>{target.path}</h3>
    <p role="status">{model.saving ? '正在保存原文件…' : model.adopting ? '正在采用当前修订…' : pending
      ? pending.phase === 'failed' ? '保存未完成；原稿与请求保留。' : '保存回执未确认；原稿与请求保留。'
      : status}</p>
    <form onSubmit={event => { event.preventDefault(); void model.save() }}>
      <label>原文件正文<ComposerTextarea aria-label="Mote 原文件正文" rows={10} value={draft.body} onValueChange={model.edit} /></label>
      <div className="mobile-mote-file-editor__actions">
        <button type="submit" className="mobile-text-button" disabled={model.saving || model.adopting}>保存原文件</button>
        <button type="button" className="mobile-text-button" onClick={() => copy(draft.body)}>复制原稿</button>
        <button type="button" className="mobile-text-button" onClick={() => { void model.inspect() }}>核对原文件</button>
      </div>
    </form>
    {checked && <div className="mobile-mote-file-editor__checked">
      <p>已核对当前原文件；读取没有确认未知保存。</p>
      {baseline && <button type="button" className="mobile-text-button" onClick={() => { void model.adoptChecked() }}>采用当前修订</button>}
      <details><summary>当前原文与修订</summary>{checked.read.result.status === 'read'
        ? <><p>{checked.read.result.document.revision}</p><pre>{checked.read.result.document.content}</pre></>
        : <p>{'message' in checked.read.result ? checked.read.result.message : checked.read.result.status}</p>}</details>
    </div>}
    {model.storageIssue && <><p role="status">{model.storageIssue.includes('未进入设备备份') ? '本次未进入设备备份；原稿仍可复制。' : '设备草稿尚未确认保存；可复制保全。'}</p><details><summary>设备保存详情</summary><p>{model.storageIssue}</p></details></>}
    {model.storageConflict && model.canonical && <button type="button" className="mobile-text-button" onClick={() => { void model.chooseStored(model.canonical!) }}>采用设备原稿</button>}
    {copyIssue && <><p role="status">复制未完成；当前正文保留。</p><details><summary>复制详情</summary><p>{copyIssue}</p></details></>}
    {model.notice && <details><summary>本次操作详情</summary><p>{model.notice}</p></details>}
    {!!draft.attempts.length && <details><summary>原保存请求 · {draft.attempts.length}</summary>{draft.attempts.map(attempt => <article key={attempt.attemptId}>
      <p>{attempt.phase === 'sending' ? '原保存尚未确认' : attempt.phase === 'unknown' ? '未知原保存' : '未完成的原保存'} · {attempt.attemptId}</p>
      {attempt.issue && <p>{attempt.issue}</p>}<pre>{JSON.stringify(attempt.input, null, 2)}</pre>
    </article>)}</details>}
    {draft.scope && <details><summary>原文件来源与基线</summary><p>{draft.baseline?.status === 'read' ? draft.baseline.revision
      : draft.baseline?.status === 'deleted' ? '原文件已确认不存在；新建不会覆盖已有文件' : '原基线尚未确认'}</p>
      <pre>{JSON.stringify(draft.scope, null, 2)}</pre></details>}
    {!!model.choices.length && <details><summary>保留的原 Host 草稿</summary>{model.choices.map((value, index) => <div key={index}>
      <p>{value.scope.origin} · {value.scope.runtimeId}</p><button type="button" className="mobile-text-button" onClick={() => { void model.chooseStored(value) }}>采用这份设备稿</button>
      <button type="button" className="mobile-text-button" onClick={() => copy(value.body)}>复制保留原稿</button></div>)}</details>}
    {!!model.copies.length && <details><summary>保全的冲突稿 · {model.copies.length}</summary>{model.copies.map((value, index) => <article key={index}>
      <pre>{value.body}</pre><button type="button" className="mobile-text-button" onClick={() => copy(value.body)}>复制冲突原稿</button>
      <pre>{JSON.stringify(value.attempts, null, 2)}</pre></article>)}</details>}
    {!!model.localCopies.length && <details><summary>采用前保留的本页原稿 · {model.localCopies.length}</summary>{model.localCopies.map((value, index) => <article key={index}>
      <pre>{value.body}</pre><button type="button" className="mobile-text-button" onClick={() => copy(value.body)}>复制采用前原稿</button>
      <pre>{JSON.stringify(value, null, 2)}</pre></article>)}</details>}
  </section>
}
