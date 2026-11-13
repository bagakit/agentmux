import { useCallback, type ComponentProps } from 'react'
import { VegaFilePreview as Preview } from '@agentmux/editor-extensions/ui/VegaFilePreview'
import { createWorkspaceVegaLoader } from '../../lib/file-formats/workspace-vega-loader'
import { useWorkspaceResourceKey } from '../../lib/workspace-resource-key'

/** The Host binds chart-relative reads to the exact Workspace resource. */
export function VegaFilePreview({ workspaceId, path, ...props }: Omit<ComponentProps<typeof Preview>, 'createLoader' | 'resource'> & { workspaceId: string }) {
  const resource = useWorkspaceResourceKey(workspaceId)
  const createLoader = useCallback((signal: AbortSignal) => createWorkspaceVegaLoader(workspaceId, path, signal), [workspaceId, path, resource])
  return <Preview {...props} path={path} resource={resource} createLoader={createLoader} />
}
