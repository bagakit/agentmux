import { useEffect, useState, type ReactNode } from 'react'
import type { FileDirectoryEntry, FileReadResource } from '@agentmux/core/files'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { SemanticIcon } from '../theme/semantic-icon.js'
import { AgentMarkdown, type OpenHttpLink } from './AgentMarkdown.js'
import { Button } from './Button.js'
import { Notice } from './Notice.js'
import type { MoteGroupCall } from './MoteGroupConversation.js'
import '../styles/mote-group-files.css'

type Contents = { kind: 'directory'; entries: FileDirectoryEntry[]; complete: boolean } |
  { kind: 'document'; body: string }
type Entry = { path: string; name: string; directory: boolean }

/** Reads through the original Group. Paths on this surface are relative to its bound Topic. */
export function MoteGroupFiles({ call, groupId, target, name, onBack, onBackChange, openHttpLink, actions }: {
  call: MoteGroupCall; groupId: string; target: MotePreferencesTarget; name?: string | undefined;
  onBack(): void; onBackChange?(back: (() => void) | null): void;
  openHttpLink?: OpenHttpLink | undefined; actions?: ReactNode
}) {
  const [route, setRoute] = useState<Entry[]>([])
  const [reading, setReading] = useState<{ entry: Entry | undefined; content?: Contents; issue?: string }>()
  const [retry, setRetry] = useState(0)
  const entry = route.at(-1)
  const path = entry?.path ?? '.'
  const visible = reading?.entry === entry ? reading : undefined
  useEffect(() => {
    onBackChange?.(entry ? () => setRoute(previous => previous.slice(0, -1)) : onBack)
    return () => onBackChange?.(null)
  }, [entry, onBack, onBackChange])
  useEffect(() => {
    let active = true
    const confirm = (resource: FileReadResource | null) => {
      if (resource && (resource.zoneId !== target.zoneId || resource.hostId !== target.expectedResource.hostId ||
        resource.workspaceId !== target.expectedResource.workspaceId || resource.workspacePath !== target.expectedResource.workspacePath)) {
        throw new Error('群文件绑定已变化，请返回群聊后重新打开。')
      }
    }
    async function read(): Promise<Contents> {
      if (!entry || entry.directory) {
        const { resource, result } = await call('space.mote.group.file.list', { groupId, path, limit: 100 })
        confirm(resource)
        if (result.status === 'directory-listed') return { kind: 'directory', entries: result.entries, complete: result.complete }
        throw new Error(result.status === 'unknown' ? result.message : '暂未读到该目录。')
      }
      const { resource, result } = await call('space.mote.group.file.read', { groupId, path })
      confirm(resource)
      if (result.status === 'read') return { kind: 'document', body: result.document.content }
      throw new Error('message' in result ? result.message : result.status === 'binary' ? '该文件需要在原 Topic 中打开。' : '暂未读到该文件。')
    }
    void read().then(content => { if (active) setReading({ entry, content }) },
      error => { if (active) setReading({ entry, issue: error instanceof Error ? error.message : String(error) }) })
    return () => { active = false }
  }, [call, entry, groupId, path, retry, target])
  return <section className="mote-group mote-group-files" aria-label="群文件">
    <header className="mote-group__header"><div><h2>{entry?.name ?? '群文件'}</h2><p>{name ?? '绑定的 Topic'}</p></div>
      <div className="mote-group__header-actions">{actions}<Button onClick={onBack}>返回群聊</Button></div>
    </header>
    <div className="mote-group-files__body">
      {entry && <Button onClick={() => setRoute(previous => previous.slice(0, -1))}>返回上层来源</Button>}
      {visible?.issue ? <Notice tone="warning" density="compact" messageRole="status" actions={<Button onClick={() => setRetry(value => value + 1)}>重读</Button>}>{visible.issue}</Notice>
      : !visible?.content ? <p role="status">正在读取群文件…</p>
      : visible.content.kind === 'document' ? <article><AgentMarkdown content={visible.content.body} documentMode {...(openHttpLink ? { openHttpLink } : {})} /></article>
      : <><ul className="mote-group-files__list">{visible.content.entries.map(item => <li key={item.path}>
        <button type="button" onClick={() => setRoute(previous => [...previous, {
          name: item.name, path: path === '.' ? item.name : `${path}/${item.name}`, directory: item.isDirectory
        }])}><SemanticIcon name={item.isDirectory ? 'object.folder' : 'object.document'} size={16} />{item.name}</button>
      </li>)}</ul>
      {!visible.content.entries.length && <p>这个目录暂无文件。</p>}
      {!visible.content.complete && <p>已显示当前可读取的文件。</p>}</>}
    </div>
  </section>
}
