import { DiagramFilePreview } from './DiagramFilePreview'

export function PlantUmlFilePreview({ content, path, visible = true }: { content: string; path?: string; workspaceId?: string; visible?: boolean }) {
  if (!visible) return null
  return <DiagramFilePreview content={content} kind="plantuml" {...(path === undefined ? {} : { path })} visible={visible} />
}
