import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { MemoryRandomAccessSource } from '@agentmux/editor-extensions/bytes'
import type { FileBuildKind } from '../../../../shared/file-build'
import { buildFileRegion, cancelFileRegionBuild, inspectFileRegionBuild, readFileRegionBuild, releaseFileRegionBuild, subscribeFileRegionBuild } from '../../lib/file-formats/build-file-region'

import { BuildPreview } from '@agentmux/editor-extensions/ui/BuildPreview'

/** Compilation is an explicit action on the original draft, not a preview side effect. */
export function BuildFilePreview({ regionId, kind, path, visible = true }: { regionId: string; kind: FileBuildKind; path: string; visible?: boolean }) {
  const subscribe = useCallback((listener: () => void) => subscribeFileRegionBuild(regionId, listener), [regionId])
  const read = useCallback(() => readFileRegionBuild(regionId), [regionId])
  const reading = useSyncExternalStore(subscribe, read, read)
  const result = reading?.result
  const pdf = useMemo(() => reading?.pdf ? new MemoryRandomAccessSource(reading.pdf) : null, [reading?.pdf])
  useEffect(() => {
    if (!visible) releaseFileRegionBuild(regionId)
    return () => releaseFileRegionBuild(regionId)
  }, [regionId, visible])
  useEffect(() => {
    if (!visible || result?.status !== 'running') return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await inspectFileRegionBuild(regionId, result.buildId)
      if (active) timer = setTimeout(() => { void poll() }, 500)
    }
    timer = setTimeout(() => { void poll() }, 500)
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [regionId, visible, result?.buildId, result?.status])
  if (!visible) return null
  return <BuildPreview kind={kind} path={path} result={result} pdf={pdf}
    onBuild={() => buildFileRegion(regionId)}
    onCancel={() => result && cancelFileRegionBuild(regionId, result.buildId)}
    onInspect={() => result && inspectFileRegionBuild(regionId, result.buildId)} />
}
