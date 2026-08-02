import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitAheadBehind } from '../../../shared/contracts'
import { gitBridge } from '../lib/git-bridge'

export type GitAheadBehindRequestState = {
  workspaceId: string
  facts: GitAheadBehind | null
  loading: boolean
  error: string | null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读「当前分支相对 upstream 领先/落后多少」。
 *
 * 桥从 {@link gitBridge} 取——不再自己摸 `window.agentmux`，缺席时的说法也由那一层给（见该文件注释
 * 里记的那次手抄事故）。
 *
 * 与 `useGitStatus` / `useWorkspaceBranches` 同一套 request-id 纪律：每次取数captures一个单调 id，
 * 写 state 前核对。切 workspace 后一个慢响应回来时，它写的是**上一个** workspace 的计数——那会让
 * 用户看到别的仓库的 ↑↓，而界面上没有任何线索表明数字来自别处。
 *
 * 失败与缺席刻意分开：`error` 是「问过了但没答上来」（比如不是 git 仓库），`facts === null` 且无
 * error 是「还没问」。徽标据此决定画不画，而不是把两种情况都当成 0/0——0/0 在这个域里有意义
 * （已同步），不能拿来当「不知道」的占位。
 */
export function useGitAheadBehind(workspaceId: string | null): GitAheadBehindRequestState & {
  refresh: () => Promise<boolean>
} {
  const [state, setState] = useState<GitAheadBehindRequestState | null>(null)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setState(null)
      return false
    }
    const lookup = gitBridge()
    if (!lookup.available) {
      setState({ workspaceId, facts: null, loading: false, error: lookup.reason })
      return false
    }
    const id = ++requestId.current
    setState((current) => ({
      workspaceId,
      facts: current?.workspaceId === workspaceId ? current.facts : null,
      loading: true,
      error: null
    }))
    try {
      const next = await lookup.bridge.aheadBehind(workspaceId)
      if (requestId.current !== id) return false
      setState({ workspaceId, facts: next, loading: false, error: null })
      return true
    } catch (cause) {
      if (requestId.current !== id) return false
      setState((current) => ({
        workspaceId,
        facts: current?.workspaceId === workspaceId ? current.facts : null,
        loading: false,
        error: message(cause)
      }))
      return false
    }
  }, [workspaceId])

  useEffect(() => {
    void refresh()
    return () => { requestId.current += 1 }
  }, [refresh])

  const visible = state?.workspaceId === workspaceId
    ? state
    : { workspaceId: workspaceId ?? '', facts: null, loading: workspaceId !== null, error: null }
  return { ...visible, refresh }
}
