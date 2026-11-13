import { MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { NOTE_FILE_EXTENSION } from '@agentmux/client-ui/note/note-format'
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
  return value.path.endsWith(NOTE_FILE_EXTENSION) && client?.forwardRpc
    ? <MobileNoteFile rpc={client.forwardRpc} params={value.params} read={value.read} visible={visible} />
    : /\.(md|markdown|mdx)$/iu.test(value.path) ? <AgentMarkdown content={value.content} documentMode sourcePath={value.path} workspaceRoot={value.params.expectedResource.workspacePath} {...(openHttpLink ? { openHttpLink } : {})} />
      : <><LegacyConversionNotice value={value} client={client} visible={visible} /><pre className="mobile-region-source">{value.content}</pre></>
}
/** A remote/failed legacy Note remains a readable original file; conversion observation grants no write. */
function LegacyConversionNotice({ value, client, visible }: { value: Content; client: AgentMuxHostedClient | null; visible: boolean }) {
  const [message, setMessage] = useState(''), [attempt, retry] = useState(0)
  useEffect(() => {
    if (!visible || !value.path.endsWith('.note.json') || !client?.forwardRpc || !value.read.resource) return
    let disposed = false
    const resource = value.read.resource
    void client.forwardRpc('notebook.inspect', {}).then(result => {
      if (!disposed) setMessage((result.conversionIssues ?? []).filter(issue => issue.resource?.hostId === resource.hostId && issue.resource.workspaceId === resource.workspaceId && issue.resource.workspacePath === resource.workspacePath && issue.resource.path === resource.path).map(issue => issue.message).join(' '))
    }).catch(error => { if (!disposed) setMessage('格式转换状态还没确认，文件仍可阅读。' + String(error)) })
    return () => { disposed = true }
  }, [visible, client, value.path, value.read.resource, attempt])
  return message ? <MobileNotice identity={[message]} role="status">{message}<button type="button" onClick={() => retry(value => value + 1)}>刷新转换状态</button></MobileNotice> : null
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
  useEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(null)
    return () => onBackChange(null)
  }, [visible, onBackChange])
  useEffect(() => {
    if (!visible || !connected) return
    let disposed = false
    const read = async () => {
    try {
      if (!client?.forwardRpc) throw new Error('连接暂不可用，暂时读不到内容')
      if (kind === 'file') {
        if (!file || !zoneId || file.zoneRelativePath === undefined) throw new Error(file?.issue ?? '文件位置还没确认')
        const snapshot = await client.forwardRpc('app.snapshot', { include: ['workspaces'], workspaceId: file.workspaceId })
        if (disposed) return
        const workspaces = snapshot.workspaces.filter(value => value.workspaceId === file.workspaceId)
        if (workspaces.length !== 1) throw new Error('文件所在的工作区还没确认')
        const workspace = workspaces[0]!, previous = valueRef.current
        const expected = previous?.params.expectedResource
        if (expected && (workspace.hostId !== expected.hostId || workspace.path !== expected.workspacePath)) throw new Error('文件所在的工作区已改变')
        const params = previous?.params ?? { zoneId, path: file.zoneRelativePath, expectedResource: { hostId: workspace.hostId, workspaceId: workspace.workspaceId, workspacePath: workspace.path } }
        const result = await client.forwardRpc('file.read', params)
        if (disposed) return
        if (result.result.status === 'read') {
          if (!confirmsOriginalResource(result.resource, params, file.path, previous?.read.resource)) throw new Error('文件位置与读取结果对不上')
          setValue({ workspaceId: file.workspaceId, path: file.path, content: result.result.document.content, revision: result.result.document.revision, params, read: result }); setIssue('')
        } else setIssue(result.result.status === 'unknown' || result.result.status === 'error' ? result.result.message : `文件状态：${result.result.status}，显示的是上次读取的内容`)
      } else {
        const id = browserId
        if (!id) throw new Error('所选网页还没确认')
        const result = await client.forwardRpc('browser.targets', {})
        if (disposed) return
        const targets = result.targets.filter(target => target.id === id)
        if (targets.length !== 1) throw new Error('这个网页的当前网址还没确认')
        const target = targets[0]!
        setBrowser({ id, url: target.url, title: target.title }); setIssue(target.warning ?? (target.status === 'ready' ? '' : `网页状态：${target.status}`))
      }
    } catch (error) { if (!disposed) setIssue(`${error instanceof Error ? error.message : String(error)}。可以刷新重试。`) }
    }
    void read()
    return () => { disposed = true }
  }, [client, connected, visible, tabId, regionId, kind, browserId, zoneId, file?.workspaceId, file?.path, file?.zoneRelativePath, file?.issue, revision])
  let externalUrl: string | null = null
  try { if (browser && ['http:', 'https:'].includes(new URL(browser.url).protocol)) externalUrl = browser.url } catch { /* Invalid URL remains visible below. */ }
  return <MobileNoticeScope owner={client} identity={[regionId,tabId,zoneId]}><section className="mobile-region-content" aria-label={kind === 'file' ? '文件阅读' : '网页地址'}>
    {showTitle && kind === 'file' && file && <h4>{file.path.split('/').at(-1)}</h4>}
    <button type="button" onClick={() => refresh(value => value + 1)}>{kind === 'file' ? '刷新文件' : '刷新网页当前网址'}</button>
    {!connected && <MobileNotice owner={client} identity={[regionId,connected]} role="status">连接暂不可用，连上 Mac 后可以刷新。</MobileNotice>}
    {issue && <MobileNotice owner={client} identity={[regionId,issue]} role="status">{issue}</MobileNotice>}
    {!value && !browser && !issue && <MobileNotice owner={client} identity={[regionId]} role="status">内容还没确认，可以刷新读取。</MobileNotice>}
    {value && <><OriginalFile value={value} client={client} visible={visible} openHttpLink={openHttpLink} /><details><summary>文件来源与修订</summary><code>{value.workspaceId} / {value.path}</code><small>{value.revision ?? '修订未确认'}</small></details></>}
    {browser && <><strong>{browser.title}</strong><details><summary>网页地址与来源</summary><p>{browser.url}</p><code>{browser.id}</code></details>{externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer">在手机浏览器打开当前网址</a>}<p>在手机上单独打开这个网页，不会控制 Mac 上的浏览器。</p></>}
  </section></MobileNoticeScope>
}
