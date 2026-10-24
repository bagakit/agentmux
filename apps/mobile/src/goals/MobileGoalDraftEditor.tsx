import { MobileNotice } from '../notices/MobileNotice'
import { useState } from 'react'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { useGoalDraft } from './useGoalDraft'

export function MobileGoalDraftEditor({ model, editing, onEditingChange, refresh, copyText }: {
  model: ReturnType<typeof useGoalDraft>; editing: boolean; onEditingChange(editing: boolean): void; refresh(): void
  copyText?: ClientUiPlatform['copyText'] | undefined
}) {
  const { draft, saving } = model
  const [copyNotice, setCopyNotice] = useState('')
  return <section className="mobile-goal-editor" aria-label="原目标正文草稿">
    <button onClick={() => onEditingChange(!editing)}>{editing ? '返回目标正文' : '编辑目标正文'}</button>
    {editing && <form onSubmit={event => {
      event.preventDefault()
      const patch = { ...(draft.title !== draft.baseline.title ? { title: draft.title } : {}), ...(draft.description !== draft.baseline.description ? { description: draft.description } : {}) }
      if (Object.keys(patch).length) void model.save(patch)
    }}>
      <label>标题<TextInput aria-label="目标草稿标题" value={draft.title} required onChange={event => model.editText('title', event.target.value)} /></label>
      <label>目标原意<ComposerTextarea aria-label="目标正文草稿" value={draft.description} onValueChange={value => model.editText('description', value)} /></label>
      <div className="mobile-goal-editor-actions"><button disabled={saving}>保存正文</button><button type="button" onClick={() => {
        if (!copyText) { setCopyNotice('复制通道暂不可用，当前正文仍可选中后手动复制。'); return }
        void copyText(`${draft.title}\n\n${draft.description}`, error => setCopyNotice(`复制未完成：${error instanceof Error ? error.message : String(error)}；当前正文保留。`))
          .then(copied => { if (copied) setCopyNotice('已复制当前标题与完整正文。') }).catch(error => setCopyNotice(`复制未完成：${String(error)}；当前正文保留。`))
      }}>复制当前草稿</button></div>
    </form>}
    {copyNotice && <MobileNotice kind="feedback" identity={[draft.goalId,copyNotice]} role="status">{copyNotice}</MobileNotice>}
    {model.remoteChanged && <div><MobileNotice identity={[draft.goalId,draft.baseline.updatedAt]} role="status">原目标已有新版本，当前正文与原请求保留。保存仍使用草稿原版本。</MobileNotice>
      <button onClick={model.rebase}>采用已读新版本；下次保存当前草稿将覆盖该版本</button></div>}
    {model.storageIssue && <MobileNotice identity={[draft.goalId,model.storageIssue]} role="status">{model.storageIssue}</MobileNotice>}
    {model.storageConflict && <button onClick={model.keepDeviceConflict}>明确保留本页正文与双方原请求</button>}
    {Object.entries(model.messages).map(([field, text]) => <MobileNotice kind="feedback" identity={[draft.goalId,field,text]} key={field} role="status">{field}：{text}</MobileNotice>)}
    {!!draft.operations.length && <div className="mobile-goal-unknown">
      <MobileNotice dismissible={!saving} kind={saving ? 'feedback' : 'warning'} identity={[draft.goalId,...draft.operations.map(operation => operation.request.operationId)]} role="status">{saving ? '原保存正在等待回执。' : '原保存回执未确认。'}正文与完整原请求保留，不会自动重发。</MobileNotice>
      <button onClick={refresh}>读取当前目标核对</button>
      <details><summary>回执未确认的保存 · {draft.operations.length}</summary>{draft.operations.map(write => <div key={write.request.operationId}>
        <p>{write.issue ?? '原请求尚无确认回执。'}其他字段的保存不代签此次结果。</p>
        <dl><dt>原目标</dt><dd><code>{draft.goalId}</code></dd><dt>原 Host</dt><dd>{draft.scope?.deviceHostId ?? '设备 Host ID 尚未记录'}</dd>
          <dt>原 Runtime／实例</dt><dd>{draft.scope?.runtimeId ?? '未核实'}／{write.ownerInstanceId}</dd></dl>
        <pre>{JSON.stringify(write.request, null, 2)}</pre>
      </div>)}</details>
    </div>}
    {!!model.conflicts.length && <details><summary>分别保全的设备草稿 · {model.conflicts.length}</summary>{model.conflicts.map((value, index) =>
      <div key={index}><p className="mobile-goals-body">{value.title}</p><p className="mobile-goals-body">{value.description}</p>
        <details><summary>这份草稿的原版本与请求</summary><pre>{JSON.stringify(value, null, 2)}</pre></details></div>)}</details>}
  </section>
}
