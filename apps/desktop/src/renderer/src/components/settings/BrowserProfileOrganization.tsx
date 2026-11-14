import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { Button } from '@agentmux/client-ui/components/Button'
import { submitProfileCreation } from '../../lib/browser-profile-creations'
import { useRef, useState } from 'react'
import { NativeSelect, TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { BrowserProfileEdit, BrowserProfileFolder, BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import * as Menu from '../HoverDropdownMenu'
import { DocumentOverlayPortal } from '../WindowOverlayHost'

const MoreIcon = semanticIconComponent('action.more')
const NextIcon = semanticIconComponent('navigation.next')
type FolderDraft = { kind: 'new'; name: string } | { kind: 'rename'; id: string; name: string }

/** Organization stays in the original Profile metadata; these are only the person's unfinished inputs. */
export function BrowserProfileOrganization({ profile, folders, revision, busy, run, onEdit }: {
  profile: BrowserProfileSummary
  folders: BrowserProfileFolder[]
  revision: number
  busy: boolean
  run(key: string, action: () => Promise<unknown>): Promise<boolean>
  onEdit(edit: BrowserProfileEdit): Promise<boolean>
}) {
  const [tag, setTag] = useState(''), [folderDraft, setFolderDraft] = useState<FolderDraft | null>(null), [notice, setNotice] = useState('')
  const folderSelect = useRef<HTMLSelectElement>(null)
  const tags = profile.tags ?? []
  const addTag = async () => {
    if (!tag.trim()) return
    if (await onEdit({ tags: [...tags, tag] })) setTag('')
  }
  const saveFolder = async () => {
    const draft = folderDraft
    if (!draft?.name.trim()) return
    if (await run('folder', () => draft.kind === 'new' ? submitProfileCreation({ operation: 'browser.profile.folder.create', label: draft.name.trim(), expectedRevision: revision })
      : api.browser.renameProfileFolder(draft.id, draft.name.trim(), revision))) {
      setFolderDraft(null); setNotice(draft.kind === 'new' ? 'Folder created. Choose it to assign this Profile.' : 'Folder renamed.')
    }
  }
  const deleteFolder = async (folder: BrowserProfileFolder) => {
    let kept = 0
    if (await run('folder-delete', async () => { kept = (await api.browser.deleteProfileFolder(folder.id, revision)).unassignedProfileIds.length })) {
      setNotice(`“${folder.label}” removed. ${kept ? `${kept} Profile${kept === 1 ? '' : 's'} kept and unassigned.` : 'All Profiles are kept.'}`)
      if (folderDraft?.kind === 'rename' && folderDraft.id === folder.id) setFolderDraft(null)
      folderSelect.current?.focus()
    }
  }
  return <section className="browser-profile-editor__section browser-profile-organization" aria-label="Organization">
    <h4>Organization</h4>
    <div className="browser-profile-organization__folder">
      <label>Folder<NativeSelect ref={folderSelect} aria-label="Profile folder" value={profile.folderId ?? ''} disabled={busy}
        onChange={event => void onEdit({ folderId: event.target.value || null })}>
        <option value="">Unassigned</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
      </NativeSelect></label>
      <Menu.Root>
        <Menu.Trigger asChild><IconButton type="button" aria-label="Manage folders" title="Manage folders" disabled={busy}><MoreIcon size={14} /></IconButton></Menu.Trigger>
        <DocumentOverlayPortal component={Menu.Portal}>
          <Menu.Content className="tab-context-menu" align="end" collisionPadding={8}>
            <Menu.Item className="tab-context-menu__item" onSelect={() => { setFolderDraft({ kind: 'new', name: '' }); setNotice('') }}>New folder…</Menu.Item>
            {folders.length ? <Menu.Separator className="tab-context-menu__separator" /> : null}
            {folders.map(folder => <Menu.Sub key={folder.id}>
              <Menu.SubTrigger className="tab-context-menu__item">{folder.label}<NextIcon size={11} /></Menu.SubTrigger>
              <DocumentOverlayPortal component={Menu.Portal}><Menu.SubContent className="tab-context-menu" collisionPadding={8}>
                <Menu.Item className="tab-context-menu__item" onSelect={() => { setFolderDraft({ kind: 'rename', id: folder.id, name: folder.label }); setNotice('') }}>Rename folder…</Menu.Item>
                <Menu.Item className="tab-context-menu__item" onSelect={() => void deleteFolder(folder)}>Delete folder</Menu.Item>
              </Menu.SubContent></DocumentOverlayPortal>
            </Menu.Sub>)}
          </Menu.Content>
        </DocumentOverlayPortal>
      </Menu.Root>
    </div>
    {folderDraft ? <div className="browser-profile-organization__folder-draft">
      <TextInput autoFocus aria-label={folderDraft.kind === 'new' ? 'New folder name' : 'Rename folder'} value={folderDraft.name} maxLength={128}
        onChange={event => setFolderDraft({ ...folderDraft, name: event.target.value })} onKeyDown={event => {
          if (isImeOwnedKeyboardEvent(event)) return
          if (event.key === 'Enter') { event.preventDefault(); void saveFolder() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFolderDraft(null) }
        }} />
      <Button type="button" disabled={busy || !folderDraft.name.trim()} onClick={() => void saveFolder()}>{folderDraft.kind === 'new' ? 'Create folder' : 'Rename'}</Button>
      <Button type="button" onClick={() => setFolderDraft(null)}>Cancel</Button>
    </div> : null}
    <p className="browser-profile-editor__quiet">Deleting a folder keeps its Profiles and their sign-ins.</p>
    <div className="browser-profile-organization__tags" aria-label="Profile tags">
      {tags.map(name => <span key={name} className="browser-profile-organization__tag">{name}<button type="button" aria-label={`Remove tag ${name}`} disabled={busy}
        onClick={() => void onEdit({ tags: tags.filter(value => value !== name) })}>×</button></span>)}
    </div>
    <div className="browser-profile-organization__tag-draft">
      <TextInput aria-label="New Profile tag" placeholder="Add a tag" value={tag} maxLength={128} onChange={event => setTag(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event)) { event.preventDefault(); void addTag() } }} />
      <Button type="button" disabled={busy || !tag.trim()} onClick={() => void addTag()}>Add tag</Button>
    </div>
    <label className="browser-profile-organization__pin"><input type="checkbox" checked={profile.pinned === true} disabled={busy}
      onChange={event => void onEdit({ pinned: event.target.checked })} />Pin this Profile near the top</label>
    {notice ? <p role="status" className="browser-profile-editor__quiet">{notice}</p> : null}
  </section>
}
