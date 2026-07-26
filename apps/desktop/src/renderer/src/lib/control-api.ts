import {
  AGENTMUX_CONTROL_ERROR_CODES,
  type AgentMuxControlError,
  type AgentMuxControlErrorCode
} from '@agentmux/core/control'
import type {
  AgentMuxDesktopApi,
  AgentMuxPreloadApi,
  DesktopControlResponse
} from '../../../shared/contracts'
import { addressingRecovery } from './agent-address'

function cancellationError(code: AgentMuxControlErrorCode, message: string): Error & { code: AgentMuxControlErrorCode } {
  return Object.assign(new Error(message), { code })
}

const CONTROL_ERROR_CODES: ReadonlySet<string> = new Set(AGENTMUX_CONTROL_ERROR_CODES)

function controlErrorCode(value: unknown): value is AgentMuxControlErrorCode {
  return typeof value === 'string' && CONTROL_ERROR_CODES.has(value)
}

/**
 * 校验过的候选：`regionIds` 是**非空元组**。
 *
 * 非空不是这里新加的约束，是上游本就成立的事实（生产者只在遇到一格 Agent 时才建候选）。把它
 * 写进类型，下游就不必再为一个到不了的情况留分支——那种分支没有调用者、不会被执行，却要一直
 * 被读、被维护、还会让测试假装覆盖了它。
 */
type ValidatedCandidate = { agentSessionId: string; regionIds: [string, ...string[]] }

/** 单个 region id 的校验：非空、非 `self`、无换行/空字符、在本候选内不重复。 */
function validRegionId(value: unknown, seen: Set<string>): string | null {
  if (typeof value !== 'string' || !value || value === 'self' || /[\0\r\n]/u.test(value) || seen.has(value)) {
    return null
  }
  seen.add(value)
  return value
}

function messageTargetCandidates(value: unknown): ValidatedCandidate[] | null {
  if (!Array.isArray(value) || value.length > 64) return null
  const candidates: ValidatedCandidate[] = []
  const sessionIds = new Set<string>()
  for (const valueCandidate of value) {
    if (!valueCandidate || typeof valueCandidate !== 'object' || Array.isArray(valueCandidate)) return null
    const candidate = valueCandidate as Record<string, unknown>
    if (
      typeof candidate.agentSessionId !== 'string' ||
      !candidate.agentSessionId ||
      candidate.agentSessionId === 'self' ||
      /[\0\r\n]/u.test(candidate.agentSessionId) ||
      sessionIds.has(candidate.agentSessionId) ||
      !Array.isArray(candidate.regionIds) ||
      candidate.regionIds.length > 64
    ) return null
    // 拆头尾而不是先 `length === 0` 再遍历：一个没有任何一格的候选本就无从寻址，`first` 缺席
    // 与"某一格非法"是同一种拒绝，合成一处判断，元组类型也就自然成立，不需要断言。
    const [first, ...rest] = candidate.regionIds
    const seenRegionIds = new Set<string>()
    const firstRegionId = validRegionId(first, seenRegionIds)
    if (firstRegionId === null) return null
    const regionIds: [string, ...string[]] = [firstRegionId]
    for (const value of rest) {
      const regionId = validRegionId(value, seenRegionIds)
      if (regionId === null) return null
      regionIds.push(regionId)
    }
    sessionIds.add(candidate.agentSessionId)
    candidates.push({ agentSessionId: candidate.agentSessionId, regionIds })
  }
  return candidates
}

/**
 * 寻址失败自带下一步。
 *
 * 挂在这里而不是每个抛出点：`TAB_NOT_OPEN` 与 `REGION_NOT_OPEN` 在 `control.ts` 里各抛 3 处，逐点拼接
 * 必然漂移，而漂移那天不会有测试变红。控制错误离开渲染进程只有这一个出口，恢复文本要给的正是**出口
 * 对面那个调用方**——所以这层是它唯一该长出来的地方。
 *
 * 哪些码算"寻址失败"由 `addressingRecovery` 说了算，这里不再列第二份码表。
 *
 * 候选只接**已校验**的那份：未校验的 id 可能带换行或 `self`，会把恢复文本变成一段执行不了、
 * 甚至误导人的命令。所以这里不接 `unknown` 再自己判类型——那等于把校验又做了一遍。
 */
function withRecovery(
  message: string,
  error: { code: string; candidates?: readonly ValidatedCandidate[] }
): string {
  const recovery = addressingRecovery(error)
  return recovery === null ? message : `${message}\n\n${recovery}`
}

function responseError(error: unknown): AgentMuxControlError {
  const source = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null
  const message = error instanceof Error ? error.message : String(error)
  const code = controlErrorCode(source?.code) ? source.code : 'CONTROL_FAILED'
  if (code === 'MESSAGE_TARGET_NOT_UNIQUE') {
    const candidates = messageTargetCandidates(source?.candidates)
    if (!candidates) return { code: 'CONTROL_FAILED', message: 'Desktop Control owner returned invalid message target candidates.' }
    return {
      code,
      message: withRecovery(message, { code, candidates }),
      candidates
    }
  }
  if (source?.candidates !== undefined) {
    return { code: 'CONTROL_FAILED', message: 'Desktop Control owner returned unexpected message target candidates.' }
  }
  return {
    code,
    message: withRecovery(message, { code })
  }
}

export function createRendererControlApi(
  preload: AgentMuxPreloadApi['control']
): AgentMuxDesktopApi['control'] {
  return {
    onRequest(listener) {
      const controllers = new Map<string, AbortController>()
      const settle = (
        requestId: string,
        controller: AbortController,
        response: DesktopControlResponse
      ): void => {
        if (controllers.get(requestId) !== controller) return
        controllers.delete(requestId)
        preload.respond(response)
      }
      const disposeRequest = preload.onRequest((request) => {
        const conflict = controllers.get(request.requestId)
        if (conflict) {
          controllers.delete(request.requestId)
          conflict.abort(cancellationError(
            'CONTROL_REQUEST_CONFLICT',
            'Desktop Control request ID was reused.'
          ))
          preload.respond({
            requestId: request.requestId,
            ok: false,
            error: { code: 'CONTROL_REQUEST_CONFLICT', message: 'Desktop Control request ID was reused.' }
          })
          return
        }
        const controller = new AbortController()
        controllers.set(request.requestId, controller)
        void Promise.resolve().then(() => listener(request, controller.signal)).then(
          (result) => settle(request.requestId, controller, { requestId: request.requestId, ok: true, result }),
          (error) => settle(request.requestId, controller, { requestId: request.requestId, ok: false, error: responseError(error) })
        )
      })
      const disposeCancellation = preload.onCancellation((cancellation) => {
        const controller = controllers.get(cancellation.requestId)
        if (!controller) return
        controllers.delete(cancellation.requestId)
        controller.abort(cancellationError(cancellation.code, cancellation.message))
      })
      return () => {
        disposeRequest()
        disposeCancellation()
        for (const controller of controllers.values()) {
          controller.abort(cancellationError('CONTROL_UNAVAILABLE', 'Desktop Control owner was disposed.'))
        }
        controllers.clear()
      }
    }
  }
}
