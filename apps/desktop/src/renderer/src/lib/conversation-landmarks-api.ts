import { parseConversationLandmarkPage, parseConversationLandmarkQuery, parseConversationLandmarkWrite, parseConversationLandmarkWritePage, type ConversationLandmarkApi } from '@agentmux/core/conversation'
/** The original metadata owner signs data; Electron transports no inferred record availability. */
export function createConversationLandmarksApi(bridge: ConversationLandmarkApi): ConversationLandmarkApi {
  return {
    list: async value => { const input = parseConversationLandmarkQuery(value); return parseConversationLandmarkPage(await bridge.list(input), input) },
    apply: async value => { const input = parseConversationLandmarkWrite(value); return parseConversationLandmarkWritePage(await bridge.apply(input), input) }
  }
}
