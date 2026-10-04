import { lazy, useEffect, useState } from 'react'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import type { WorkspaceSourcePreview } from '../../../../shared/workspace-file-format'
import { ImageContent } from '../FilePreviewPane'
import { WorkspaceImage } from '../WorkspaceImage'

const FileDataPreview = lazy(async () => ({ default: (await import('../FileDataPreview')).FileDataPreview }))
const HtmlFilePreview = lazy(async () => ({ default: (await import('../HtmlFilePreview')).HtmlFilePreview }))
const StructuredDataPreview = lazy(async () => ({ default: (await import('./StructuredDataPreview')).StructuredDataPreview }))
const NotebookFilePreview = lazy(async () => ({ default: (await import('./NotebookFilePreview')).NotebookFilePreview }))
const DiagramFilePreview = lazy(async () => ({ default: (await import('./DiagramFilePreview')).DiagramFilePreview }))
const DotFilePreview = lazy(async () => ({ default: (await import('./DotFilePreview')).DotFilePreview }))
const DrawioFilePreview = lazy(async () => ({ default: (await import('./DrawioFilePreview')).DrawioFilePreview }))
const PlantUmlFilePreview = lazy(async () => ({ default: (await import('./PlantUmlFilePreview')).PlantUmlFilePreview }))
const ExcalidrawFilePreview = lazy(async () => ({ default: (await import('./ExcalidrawFilePreview')).ExcalidrawFilePreview }))
const VegaFilePreview = lazy(async () => ({ default: (await import('./VegaFilePreview')).VegaFilePreview }))
const BuildFilePreview = lazy(async () => ({ default: (await import('./BuildFilePreview')).BuildFilePreview }))

function SourceImage({ content, name }: { content: string; name: string }) {
  const [loaded, setLoaded] = useState<{ content: string; url: string } | null>(null)
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
    setLoaded({ content, url })
    return () => URL.revokeObjectURL(url)
  }, [content])
  return loaded?.content === content ? <ImageContent key={loaded.url} src={loaded.url} name={name} /> : null
}

export type SourceFilePreviewProps = {
  regionId: string
  kind: WorkspaceSourcePreview
  content: string
  path: string
  workspaceId: string
  workspaceRoot: string
  visible: boolean
  openReference(path: string, location?: { line: number; column?: number }): void
  openHttpLink(url: string): void
}

/** The original File mounts one disposable adapter only while its preview is visible. */
export function SourceFilePreview(props: SourceFilePreviewProps) {
  const { kind, content, path, workspaceId, workspaceRoot, visible, openReference, openHttpLink } = props
  if (!visible) return null
  switch (kind) {
    case 'svg': return <SourceImage content={content} name={path} />
    case 'json': case 'csv': case 'tsv':
      return <FileDataPreview content={content} kind={kind} comments={path.toLowerCase().endsWith('.jsonc')} />
    case 'html': return <HtmlFilePreview workspaceId={workspaceId} path={path} content={content} />
    case 'jsonl': case 'yaml': case 'toml': return <StructuredDataPreview content={content} kind={kind} visible={visible} ownerKey={`${workspaceId}:${path}`} />
    case 'notebook': return <NotebookFilePreview content={content} visible={visible} ownerKey={`${workspaceId}:${path}`} />
    case 'mermaid': return <DiagramFilePreview content={content} kind={kind} path={path} visible={visible} />
    case 'dot': return <DotFilePreview content={content} path={path} visible={visible} />
    case 'drawio': return <DrawioFilePreview content={content} path={path} visible={visible} />
    case 'plantuml': return <PlantUmlFilePreview content={content} path={path} visible={visible} />
    case 'excalidraw': return <ExcalidrawFilePreview content={content} path={path} visible={visible} />
    case 'vega': case 'vega-lite': return <VegaFilePreview content={content} path={path} workspaceId={workspaceId} visible={visible} mode={kind} />
    case 'latex': case 'typst': return <BuildFilePreview regionId={props.regionId} kind={kind} path={path} visible={visible} />
    case 'markdown': return <AgentMarkdown documentMode outline className="file-markdown-preview" content={content} workspaceRoot={workspaceRoot} sourcePath={path}
      renderWorkspaceImage={(image, alt, linked) => <WorkspaceImage key={`${workspaceId}:${image}`} workspaceId={workspaceId} path={image} alt={alt} linked={Boolean(linked)} openFile={() => openReference(image)} />}
      openWorkspaceFile={openReference} openHttpLink={openHttpLink} />
    case 'note': return null // Note's editable block owner stays with FileSurfaceView.
    default: { const exhaustive: never = kind; return exhaustive }
  }
}
