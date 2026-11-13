import { DiagramFilePreview, type DiagramHost } from './DiagramFilePreview'

export function PlantUmlFilePreview({ content, path, visible = true, host }: { host: DiagramHost; content: string; path?: string; workspaceId?: string; visible?: boolean }) {
  if (!visible) return null
  return <DiagramFilePreview host={host} content={content} kind="plantuml" {...(path === undefined ? {} : { path })} visible={visible} />
}
