import { mintObjectId } from '@agentmux/core/object-id'
import { useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import type { KnowledgeTopic, TopicCategory } from '@agentmux/core/control'
import type { TopicsRpc } from './MobileTopicKnowledge'

type Action = { kind: 'category-create' } | { kind: 'topic-create'; category: TopicCategory }
  | { kind: 'category-rename'; category: TopicCategory } | { kind: 'topic-move'; topic: KnowledgeTopic }
/** The editor captures the exact action at opening; names are never used as identities. */
export function MobileTopicOrganization({ rpc, categories, category, topic, onChanged, onRefresh }: {
  rpc: TopicsRpc; categories: TopicCategory[]; category: TopicCategory | null; topic: KnowledgeTopic | null; onChanged(): void; onRefresh?: () => void
}) {
  const [action, setAction] = useState<Action | null>(null), [open, setOpen] = useState(false)
  function begin(value: Action) { if (!action) setAction(value); setOpen(true) }
  return <details className="mobile-topic-organization"><summary>更多</summary>
    {!open && <div className="mobile-topics-actions"><button onClick={() => begin({ kind: 'category-create' })}>新建分类</button>
      {onRefresh && <button onClick={onRefresh}>刷新目录</button>}
      {category && <><button onClick={() => begin({ kind: 'topic-create', category })}>新建 Topic</button><button onClick={() => begin({ kind: 'category-rename', category })}>重命名分类</button></>}
      {topic && <button onClick={() => begin({ kind: 'topic-move', topic })}>移动 Topic</button>}
      {action && <button onClick={() => setOpen(true)}>继续管理草稿</button>}</div>}
    {action && <div hidden={!open}><OrganizationEditor rpc={rpc} action={action} categories={categories} onClose={() => setOpen(false)} onSaved={() => { setAction(null); setOpen(false); onChanged() }} /></div>}
  </details>
}
function OrganizationEditor({ rpc, action, categories, onClose, onSaved }: {
  rpc: TopicsRpc; action: Action; categories: TopicCategory[]; onClose(): void; onSaved(): void
}) {
  const [original] = useState(action)
  const [newId] = useState(() => mintObjectId())
  const [title, setTitle] = useState(original.kind === 'category-rename' ? original.category.title : '')
  const [destination, setDestination] = useState(''), [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [issue, setIssue] = useState('')
  const [checked, setChecked] = useState(false)
  const [revision, setRevision] = useState(original.kind === 'category-rename' ? original.category.revision : null)
  const [spatialRevision, setSpatialRevision] = useState(original.kind === 'topic-move' ? original.topic.spatialRevision : 0)
  async function save() {
    if (busy || unknown) return
    if (original.kind === 'topic-move' ? !destination : !title.trim()) { setIssue('请选择准确目标或填写名称，原草稿保留。'); return }
    if (original.kind === 'category-rename' && !revision) { setUnknown(true); setIssue('分类内容 revision 未确认；可检查原分类后继续。其他 Topic 与工作面仍可用。'); return }
    setBusy(true)
    try {
      if (original.kind === 'category-create') await rpc('topic.category.create', { categoryId: newId, title: title.trim() })
      else if (original.kind === 'topic-create') await rpc('topic.create', { topicId: newId, categoryId: original.category.categoryId, title: title.trim() })
      else if (original.kind === 'category-rename') await rpc('topic.category.rename', { categoryId: original.category.categoryId, expectedRevision: revision!, title: title.trim() })
      else await rpc('topic.move', { topicId: original.topic.topicId, categoryId: destination, expectedRevision: spatialRevision })
      onSaved()
    } catch (error) { setUnknown(true); setChecked(false); setIssue(`操作未确认：${error instanceof Error ? error.message : String(error)}。草稿与原身份保留，先检查原结果；不会自动重放。`) }
    finally { setBusy(false) }
  }
  async function inspect() {
    try {
      if (original.kind === 'topic-create' || original.kind === 'topic-move') {
        const result = await rpc('topic.inspect', { topicId: original.kind === 'topic-create' ? newId : original.topic.topicId })
        if (result.topic) setSpatialRevision(result.topic.spatialRevision)
        setChecked(result.unavailable.length === 0 && (original.kind === 'topic-create' || result.topic !== null))
        setIssue(result.topic ? `原 Topic 已读回：${result.topic.title}。请刷新目录核对分类与工作面；没有重放操作。` : '当前未找到原 Topic。草稿与创建身份保留，未重放操作。')
      } else {
        const result = await rpc('topic.category.ls', {})
        const category = result.categories.find(value => value.categoryId === (original.kind === 'category-create' ? newId : original.category.categoryId))
        setRevision(category?.revision ?? null)
        setChecked(result.unavailable.length === 0 && (original.kind === 'category-create' || Boolean(category?.revision)))
        setIssue(category ? `原分类已读回：${category.title}。请刷新目录核对结果；没有重放操作。` : '原分类暂未确认。草稿保留，未重放操作。')
      }
    } catch (error) { setIssue(`原操作结果仍不可读：${error instanceof Error ? error.message : String(error)}。草稿保留。`) }
  }
  return <form className="mobile-topic-editor" onSubmit={event => { event.preventDefault(); void save() }}>
    <h2>{{ 'category-create': '新建分类', 'topic-create': '新建 Topic', 'category-rename': '重命名分类', 'topic-move': '移动 Topic' }[original.kind]}</h2>
    {original.kind === 'topic-move' ? <><p>{original.topic.title} · 原 Topic 整体移动，内容与执行身份保留。</p><label>目标分类<select aria-label="目标分类" value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}>
      <option value="">选择分类</option>{categories.map(value => <option key={value.categoryId} value={value.categoryId}>{value.title}</option>)}</select></label></>
      : <label>名称<TextInput aria-label="分类或 Topic 名称" maxLength={120} value={title} readOnly={busy} onChange={event => setTitle(event.target.value)} /></label>}
    {issue && <p className="mobile-topics-issue" role="status">{issue}</p>}
    {unknown && <button type="button" onClick={() => { void inspect() }}>检查原操作结果</button>}
    {unknown && checked && <button type="button" onClick={() => { setUnknown(false); setChecked(false); setIssue('已采用检查结果；继续操作须明确确认保存。') }}>以检查结果为基准继续</button>}
    <div className="mobile-topics-actions"><button type="button" onClick={onClose}>保留草稿并返回</button><button type="submit" disabled={busy || unknown}>{busy ? '保存中…' : '确认保存'}</button>
      {unknown && <button type="button" onClick={onSaved}>刷新目录并结束本次编辑</button>}</div>
  </form>
}
