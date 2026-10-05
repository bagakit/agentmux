import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileNoteFile } from './MobileNoteFile'
import type { FileReadParams, FileReadResult, FileReadResource } from '@agentmux/core/files'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { AgentMarkdown, type OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import '../survey/survey.css'

type Content = { workspaceId: string; path: string; content: string | null; revision: string | null; params: FileReadParams; read: FileReadResult }
/** Correlate the public owner receipt to this selected original file and its previously confirmed mapping. */
function confirmsOriginalResource(resource: FileReadResource | null, params: FileReadParams, path: string, original?: FileReadResource | null): boolean {
  return Boolean(resource && resource.hostId === params.expectedResource.hostId && resource.workspaceId === params.expectedResource.workspaceId
    && resource.workspacePath === params.expectedResource.workspacePath && resource.zoneId === params.zoneId && resource.path === path
    && (!original || (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const).every(key => resource[key] === original[key])))
}
function OriginalFile({ value, client, visible, openHttpLink }: { value: Content; client: AgentMuxHostedClient | null; visible: boolean; openHttpLink?: OpenHttpLink | undefined }) {
  if (value.content === null) return null
  return value.path.endsWith('.note.json') && client?.forwardRpc
    ? <MobileNoteFile rpc={client.forwardRpc} params={value.params} read={value.read} visible={visible} />
    : /\.(md|markdown|mdx)$/iu.test(value.path) ? <AgentMarkdown content={value.content} documentMode sourcePath={value.path} workspaceRoot={value.params.expectedResource.workspacePath} {...(openHttpLink ? { openHttpLink } : {})} />
      : <pre className="mobile-region-source">{value.content}</pre>
}
export type MobileRegionContentProps = { client: AgentMuxHostedClient | null; connected?: boolean; visible?: boolean; showTitle?: boolean; tabId: string; regionId: string; zoneId: string | null; kind: 'file' | 'browser'; browserId?: string | undefined; file?: AgentMuxSpaceCatalog['regions'][number]['file']; openHttpLink?: OpenHttpLink; onBackChange?(back: (() => void) | null): void }
export function MobileRegionContent(props: MobileRegionContentProps) {
  return <RegionContent key={JSON.stringify([props.tabId, props.regionId, props.zoneId, props.kind, props.browserId, props.file?.workspaceId, props.file?.path, props.file?.zoneRelativePath])} {...props} />
}
function RegionContent({ client, connected = true, visible = true, showTitle = true, tabId, regionId, kind, browserId, file, zoneId, openHttpLink, onBackChange }: MobileRegionContentProps) {
  const [value, setValue] = useState<Content | null>(null)
  const [browser, setBrowser] = useState<{ id: string; url: string; title: string } | null>(null)
  const [issue, setIssue] = useState('')
  const [revision, refresh] = useState(0)
  const valueRef = useRef(value); valueRef.current = value
  const attempted = useRef<{ client: AgentMuxHostedClient | null; revision: number } | null>(null)
  useEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(null)
    return () => onBackChange(null)
  }, [visible, onBackChange])
  useEffect(() => {
    if (!visible || !connected || attempted.current?.client === client && attempted.current.revision === revision) return
    attempted.current = { client, revision }
    let disposed = false
    const read = async () => {
    try {
      if (!client?.forwardRpc) throw new Error('原内容公共端口暂不可用')
      if (kind === 'file') {
        if (!file || !zoneId || file.zoneRelativePath === undefined) throw new Error(file?.issue ?? '原文件与 Zone 读取引用尚未确认')
        const snapshot = await client.forwardRpc('app.snapshot', { include: ['workspaces'], workspaceId: file.workspaceId })
        if (disposed) return
        const workspaces = snapshot.workspaces.filter(value => value.workspaceId === file.workspaceId)
        if (workspaces.length !== 1) throw new Error('原文件 Workspace 资源尚未唯一确认')
        const workspace = workspaces[0]!, previous = valueRef.current
        const expected = previous?.params.expectedResource
        if (expected && (workspace.hostId !== expected.hostId || workspace.path !== expected.workspacePath)) throw new Error('原文件 Workspace 资源映射已改变；已有正文与原草稿保留')
        const params = previous?.params ?? { zoneId, path: file.zoneRelativePath, expectedResource: { hostId: workspace.hostId, workspaceId: workspace.workspaceId, workspacePath: workspace.path } }
        const result = await client.forwardRpc('file.read', params)
        if (disposed) return
        if (result.result.status === 'read') {
          if (!confirmsOriginalResource(result.resource, params, file.path, previous?.read.resource)) throw new Error('原文件资源或 Zone 映射未确认一致；已有正文、修订与原草稿保留')
          setValue({ workspaceId: file.workspaceId, path: file.path, content: result.result.document.content, revision: result.result.document.revision, params, read: result }); setIssue('')
        } else setIssue(result.result.status === 'unknown' || result.result.status === 'error' ? result.result.message : `原文件状态：${result.result.status}；上次阅读保留`)
      } else {
        const id = browserId
        if (!id) throw new Error('所选原 Browser 身份未确认')
        const result = await client.forwardRpc('browser.targets', {})
        if (disposed) return
        const targets = result.targets.filter(target => target.id === id)
        if (targets.length !== 1) throw new Error('原 browserId 的当前网址尚未唯一确认')
        const target = targets[0]!
        setBrowser({ id, url: target.url, title: target.title }); setIssue(target.warning ?? (target.status === 'ready' ? '' : `原 Browser 状态：${target.status}`))
      }
    } catch (error) { if (!disposed) setIssue(`${error instanceof Error ? error.message : String(error)}；原引用、已有正文（如有）和草稿保留，可明确刷新。`) }
    }
    void read()
    return () => { disposed = true }
  }, [client, connected, visible, tabId, regionId, kind, browserId, zoneId, file?.workspaceId, file?.path, file?.zoneRelativePath, file?.issue, revision])
  let externalUrl: string | null = null
  try { if (browser && ['http:', 'https:'].includes(new URL(browser.url).protocol)) externalUrl = browser.url } catch { /* Invalid URL remains visible below. */ }
  return <section className="mobile-region-content" aria-label={kind === 'file' ? '原文件阅读' : '原网页地址'}>
    {showTitle && kind === 'file' && file && <h4>{file.path.split('/').at(-1)}</h4>}
    <button type="button" onClick={() => refresh(value => value + 1)}>{kind === 'file' ? '刷新原文件' : '刷新原 Browser 当前网址'}</button>
    {!connected && <p role="status">连接暂不可用；原引用、已有正文（如有）与草稿保留。</p>}
    {issue && <p role="status">{issue}</p>}
    {!value && !browser && !issue && <p role="status">原内容尚未确认；原引用保留，可刷新读取。</p>}
    {value && <><OriginalFile value={value} client={client} visible={visible} openHttpLink={openHttpLink} /><details><summary>文件来源与修订</summary><code>{value.workspaceId} / {value.path}</code><small>{value.revision ?? '修订未确认'}</small></details></>}
    {browser && <><strong>{browser.title}</strong><details><summary>网页地址与来源</summary><p>{browser.url}</p><code>{browser.id}</code></details>{externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer">在手机浏览器打开当前网址</a>}<p>打开独立手机网页；不控制 Mac 原 Browser 画面。</p></>}
  </section>
}
