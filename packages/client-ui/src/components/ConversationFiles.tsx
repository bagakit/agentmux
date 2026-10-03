import { File, FileText, Image } from 'lucide-react'
import type { ConversationFile } from '../lib/conversation-files.js'
import { referenceRevealLocation } from '../lib/markdown-file-reference.js'
import type { OpenWorkspaceFile } from './AgentMarkdown.js'

export function ConversationFiles({ files, openFile }: { files: readonly ConversationFile[]; openFile: OpenWorkspaceFile }) {
  function items(values: readonly ConversationFile[]) {
    return values.map(({ reference, name, kind }) => {
      const Icon = kind === 'image' ? Image : kind === 'document' ? FileText : File
      const location = reference.line === undefined ? '' : `:${reference.line}${reference.column === undefined ? '' : `:${reference.column}`}`
      return <button type="button" className="conversation-file" key={JSON.stringify([reference.path, location])}
        title={`${reference.path}${location}`} aria-label={`Open ${reference.path}${location}`}
        onClick={() => openFile(reference.path, referenceRevealLocation(reference))}>
        <Icon size={16} aria-hidden="true" />
        <span className="conversation-file__label"><span className="conversation-file__name">{name}</span>
          <span className="conversation-file__path">{reference.path}{location}</span></span>
      </button>
    })
  }
  return <div className="conversation-files" aria-label="Files mentioned in this reply">
    <span className="conversation-files__caption">Files in this reply</span>
    <div className="conversation-files__items">{items(files.slice(0, 6))}</div>
    {files.length > 6 ? <details className="conversation-files__more"><summary>{files.length - 6} more files</summary>
      <div className="conversation-files__items">{items(files.slice(6))}</div></details> : null}
  </div>
}
