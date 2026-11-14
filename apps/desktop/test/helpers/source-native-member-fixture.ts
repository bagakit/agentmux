import { createSpaceMemberProgressFixture } from "../../../../packages/core/test/helpers/space-member-progress-fixture"
import { spaceMountTransport } from "./space-mount-fixture"
import { DEFAULT_CONFIG } from "../../src/main/config-store"
import type { SpaceMountSessionTarget } from "../../src/shared/space-mount"

export async function createSourceNativeMemberFixture(cleanup: Array<() => Promise<void>>) {
  const f = await createSpaceMemberProgressFixture(cleanup), selected = await f.admit(true)
  let afterReply: ((method: string) => void | Promise<void>) | undefined
  const calls: string[] = []
  const carrier = { forwardRpc: async (method: string, params: unknown, context?: unknown) => {
    const result = await f.rpc.call(method as never, params as never, context as never)
    if (method === 'space.member.call') { const original = (params as { call: { method: string } }).call.method; calls.push(original); await afterReply?.(original) }
    return result
  }, subscribeRpc: f.rpc.subscribe.bind(f.rpc) }
  const main = spaceMountTransport(cleanup, [{ id: 'original-progress-source', carrier: carrier as never }], structuredClone(DEFAULT_CONFIG))
  const target: SpaceMountSessionTarget = { hostId: 'original-progress-source', target: selected.target }
  const surface = await main.api.member(target, () => {})
  cleanup.push(async () => { await surface.dispose() })
  return { ...f, selected, main, surface, calls, afterReply(callback: typeof afterReply) { afterReply = callback } }
}
