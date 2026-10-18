import type { NoteImageInput } from '@agentmux/client-ui/platform'
import { NoteNetworkImage } from '@agentmux/client-ui/components/NoteImage'
import { classifyMarkdownLinkHref } from '@agentmux/client-ui/markdown-file-reference'
import { parseHttpLinkUrl } from '@agentmux/client-ui/link-url'
import { useAppStore } from '../store'
import { WorkspaceImage } from './WorkspaceImage'
import { useDesktopNoteLinkOpener } from '../lib/note-file-link'

/** Relative bytes belong to the body that authored them, not its current display Workspace. */
export function NoteImageResource({ resource, src, alt, title }: NoteImageInput) {
  const open = useDesktopNoteLinkOpener()
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === resource?.workspaceId))
  if (parseHttpLinkUrl(src)) return <NoteNetworkImage src={src} alt={alt} {...(title === undefined ? {} : { title })} />
  const reference = resource && classifyMarkdownLinkHref(src, resource.workspacePath, '', resource.path)
  if (!resource || !reference || !workspace || workspace.hostId !== resource.hostId || workspace.path !== resource.workspacePath)
    return <span className="note-image__unavailable" role="status">{alt || 'Image'} · {src || 'No image address'} · Original file resource unavailable</span>
  return <WorkspaceImage workspaceId={resource.workspaceId} path={reference.path} alt={alt} expectedResource={resource} {...(title === undefined ? {} : { title })}
    openFile={() => { void open(resource, src).catch(useAppStore.getState().reportError) }} />
}
