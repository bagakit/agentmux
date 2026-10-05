import { useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileNoteFile } from './MobileNoteFile'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import type { FileReadParams, FileReadResult } from '@agentmux/core/files'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'

type Content = { workspaceId: string; path: string; content: string | null; revision: string | null; params: FileReadParams; read: FileReadResult }
function OriginalFile({ value, client, visible }: { value: Content; client: AgentMuxHostedClient | null; visible: boolean }) {
  if (value.content === null) return null
  return value.path.endsWith('.note.json') && client?.forwardRpc
    ? <MobileNoteFile rpc={client.forwardRpc} params={value.params} read={value.read} visible={visible} />
    : /\.(md|markdown|mdx)$/iu.test(value.path)
      ? <AgentMarkdown content={value.content} documentMode sourcePath={value.path} workspaceRoot={value.params.expectedResource!.workspacePath} />
      : <pre>{value.content}</pre>
}
export type MobileRegionContentProps = { client: AgentMuxHostedClient | null; visible?: boolean; tabId: string; regionId: string; zoneId: string | null; kind: 'file' | 'browser'; browserId?: string | undefined; file?: AgentMuxSpaceCatalog['regions'][number]['file'] }
export function MobileRegionContent(props: MobileRegionContentProps) {
  return <RegionContent key={JSON.stringify([props.tabId, props.regionId, props.zoneId, props.kind, props.browserId, props.file?.workspaceId, props.file?.path, props.file?.zoneRelativePath])} {...props} />
}
function RegionContent({ client, visible = true, tabId, regionId, kind, browserId, file, zoneId }: MobileRegionContentProps) {
  const [value, setValue] = useState<Content | null>(null)
  const [browser, setBrowser] = useState<{ id: string; url: string; title: string } | null>(null)
  const [issue, setIssue] = useState('')
  const [revision, refresh] = useState(0)
  useEffect(() => {
    if (!visible) return
    let disposed = false
    const read = async () => {
    try {
      if (!client?.forwardRpc) throw new Error('原内容公共端口暂不可用')
      if (kind === 'file') {
        if (!file || !zoneId || file.zoneRelativePath === undefined) throw new Error(file?.issue ?? '原文件与 Zone 读取引用尚未确认')
        const snapshot = await client.forwardRpc('app.snapshot', { include: ['workspaces'], workspaceId: file.workspaceId })
        if (disposed) return
        const workspace = snapshot.workspaces.find(value => value.workspaceId === file.workspaceId)
        if (!workspace) throw new Error('原文件 Workspace 资源尚未确认')
        const params = { zoneId, path: file.zoneRelativePath, expectedResource: { hostId: workspace.hostId, workspaceId: workspace.workspaceId, workspacePath: workspace.path } }
        const result = await client.forwardRpc('file.read', params)
        if (disposed) return
        if (result.result.status === 'read') {
          if (result.result.document.path !== file.path) throw new Error('读取回执未确认同一原文件')
          setValue({ workspaceId: file.workspaceId, path: file.path, content: result.result.document.content, revision: result.result.document.revision, params, read: result }); setIssue('')
        } else setIssue(result.result.status === 'unknown' || result.result.status === 'error' ? result.result.message : `原文件状态：${result.result.status}；上次阅读保留`)
      } else {
        const id = browserId
        if (!id) throw new Error('所选原 Browser 身份未确认')
        const result = await client.forwardRpc('browser.targets', {})
        if (disposed) return
        const target = result.targets.find(target => target.id === id)
        if (!target) throw new Error('原 browserId 的当前网址未确认')
        setBrowser({ id, url: target.url, title: target.title }); setIssue(target.warning ?? (target.status === 'ready' ? '' : `原 Browser 状态：${target.status}`))
      }
    } catch (error) { if (!disposed) setIssue(`${error instanceof Error ? error.message : String(error)}；原引用保留，可重试读取。`) }
    }
    void read()
    return () => { disposed = true }
  }, [client, visible, tabId, regionId, kind, browserId, zoneId, file?.workspaceId, file?.path, file?.zoneRelativePath, file?.issue, revision])
  let externalUrl: string | null = null
  try { if (browser && ['http:', 'https:'].includes(new URL(browser.url).protocol)) externalUrl = browser.url } catch { /* Invalid URL remains visible below. */ }
  return <section aria-label={kind === 'file' ? '原文件阅读' : '原网页地址'}>
    {kind === 'file' && file && <h4>{file.path.split('/').at(-1)}</h4>}
    <button type="button" onClick={() => refresh(value => value + 1)}>{kind === 'file' ? '刷新原文件' : '刷新原 Browser 当前网址'}</button>
    {issue && <p role="status">{issue}</p>}
    {value && <><OriginalFile value={value} client={client} visible={visible} /><details><summary>文件来源与修订</summary><code>{value.workspaceId} / {value.path}</code><small>{value.revision ?? '修订未确认'}</small></details></>}
    {browser && <><strong>{browser.title}</strong><details><summary>网页地址与来源</summary><p>{browser.url}</p><code>{browser.id}</code></details>{externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer">在手机浏览器打开当前网址</a>}<p>打开独立手机网页；不控制 Mac 原 Browser 画面。</p></>}
  </section>
}
