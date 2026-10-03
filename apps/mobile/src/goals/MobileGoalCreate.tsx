import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'

/** Creation goes through the original Goal owner and its Project/decision policy. */
export function MobileGoalCreate({ client, visible, created, refresh }: {
  client: AgentMuxHostedClient | null; visible: boolean; created(goal: AgentMuxRpcGoal): void; refresh(): void
}) {
  const [opened, open] = useState(false), [projects, setProjects] = useState<AgentMuxRpcResult<'app.snapshot'>['projects']>([])
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [projectId, setProjectId] = useState('')
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('medium')
  const [directoryIssue, setDirectoryIssue] = useState(''), [issue, setIssue] = useState(''), [revision, reread] = useState(0)
  const [unknown, setUnknown] = useState(false), [busy, setBusy] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState<AgentMuxRpcParams<'goal.create'>[]>([])
  const flight = useRef(false)
  useEffect(() => {
    if (!visible || !opened || !client?.forwardRpc) return
    let live = true
    void client.forwardRpc('app.snapshot', { include: ['projects'] }).then(result => {
      if (live) { setProjects(result.projects); setDirectoryIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setDirectoryIssue(`项目目录读取失败：${error instanceof Error ? error.message : String(error)}。原选择与草稿保留，可刷新核对。`) })
    return () => { live = false }
  }, [client, visible, opened, revision])
  async function save() {
    if (flight.current || unknown) return
    if (!client?.forwardRpc) { setIssue('创建未发送：原目标公共端口暂不可用；草稿保留。'); return }
    if (!title.trim() || !projectId) { setIssue('填写目标标题并选择准确项目，草稿保留。'); return }
    const input: AgentMuxRpcParams<'goal.create'> = { title: title.trim(), description, projectId, risk, confirmation: 'user', operationId: crypto.randomUUID() }
    flight.current = true; setBusy(true)
    try {
      const result = await client.forwardRpc('goal.create', input)
      created(result.goal); open(false); setTitle(''); setDescription(''); setIssue('')
    } catch (error) {
      setUnconfirmed(values => [...values, input]); setUnknown(true)
      setIssue(`创建回执未确认：${error instanceof Error ? error.message : String(error)}。原草稿和操作身份保留；先读取原目标核对，不会自动再次创建。`)
    } finally { flight.current = false; setBusy(false) }
  }
  return <section aria-label="新建目标">
    <button type="button" onClick={() => open(value => !value)}>{opened ? '收起创建草稿' : '新建目标'}</button>
    <div hidden={!opened}><form onSubmit={event => { event.preventDefault(); void save() }}>
      <label>目标标题<input aria-label="新目标标题" value={title} readOnly={busy} onChange={event => setTitle(event.target.value)} /></label>
      <label>目标原意<textarea aria-label="新目标原意" value={description} readOnly={busy} onChange={event => setDescription(event.target.value)} /></label>
      <label>项目<select aria-label="新目标项目" value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}><option value="">选择项目</option>{projects.map(project => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select></label>
      <label>工作风险<select aria-label="新目标风险" value={risk} disabled={busy} onChange={event => setRisk(event.target.value as typeof risk)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      <p>确认将目标保存到所选项目；创建目标不会开始执行。</p>
      <button type="button" onClick={() => reread(value => value + 1)}>刷新项目目录</button>
      <button type="submit" disabled={busy || unknown}>{busy ? '创建中…' : '确认创建目标'}</button>
    </form></div>
    {directoryIssue && <p role="status">{directoryIssue}</p>}{issue && <p role="status">{issue}</p>}
    {!!unconfirmed.length && <details open><summary>未确认的创建</summary>{unconfirmed.map(value => <div key={value.operationId}><p>此创建的回执尚未确认，其他目标不代签它的结果。</p><code>{value.operationId}</code><pre>{JSON.stringify(value, null, 2)}</pre></div>)}<button type="button" onClick={refresh}>读取目标列表核对</button>
      {unknown && <button type="button" onClick={() => { setUnknown(false); setTitle(''); setDescription(''); setIssue('原未知创建记录保留；当前为另一份新草稿。'); open(true) }}>新建另一个目标</button>}
    </details>}
  </section>
}
