import { useCallback } from 'react'
import { useAppStore } from '../store'
import { formatPathForDisplay } from '../lib/copy-path-display'

/** Presentation only; each caller keeps the original path and its exact Host. */
export function usePathDisplay(): (path: string, hostId: string | undefined) => string {
  const home = useAppStore(state => state.localHome)
  const absolute = useAppStore(state => state.config?.copyPathsAsAbsolute)
  const hosts = useAppStore(state => state.config?.hosts)
  return useCallback((path, hostId) => formatPathForDisplay(path, {
    home: hosts?.find(host => host.id === hostId)?.kind === 'local' ? home : '',
    copyPathsAsAbsolute: absolute
  }), [home, absolute, hosts])
}
