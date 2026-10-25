import { feishuConfig } from './feishu.js'
import type { FeishuHttpCall, FeishuHttpResponse } from './feishu-publication.js'

type Reaction = { path: string; reaction_id: string; operator: { operator_type: string; operator_id: string }; reaction_type: { emoji_type: string } }

/** Controlled native platform state; production owns all stage selection and exact mapping. */
export function feishuReactions(override?: (call: FeishuHttpCall, normal: FeishuHttpResponse) => FeishuHttpResponse | undefined) {
  const active: Reaction[] = [], created: Reaction[] = [], calls: FeishuHttpCall[] = []
  let serial = 0
  const seed = (path: string, emoji: string, operator = { operator_type: 'app', operator_id: feishuConfig.application.appId }) => {
    const reaction = { path, reaction_id: 'reaction-' + ++serial, operator, reaction_type: { emoji_type: emoji } }
    active.push(reaction); return reaction
  }
  return { active, created, calls, seed,
    handle(call: FeishuHttpCall): FeishuHttpResponse | undefined {
      const match = call.path.match(/^(.*\/reactions)(?:\/([^/]+))?$/u)
      if (!match) return
      calls.push(call)
      let normal: FeishuHttpResponse, added: Reaction | undefined, removed: Reaction | undefined
      if (call.method === 'POST' && !match[2]) {
        const reaction = seed(call.path, JSON.parse(call.body).reaction_type.emoji_type)
        created.push(reaction); added = reaction; normal = { status: 200, body: { code: 0, data: reaction } }
      } else if (call.method === 'GET' && !match[2]) {
        normal = { status: 200, body: { code: 0, data: { items: active.filter(value => value.path === call.path && value.reaction_type.emoji_type === call.query.reaction_type), has_more: false } } }
      } else if (call.method === 'DELETE' && match[2]) {
        const index = active.findIndex(value => value.path === match[1] && value.reaction_id === decodeURIComponent(match[2]!))
        const reaction = active[index]
        if (!reaction) normal = { status: 200, body: { code: 231011 } }
        else if (reaction.operator.operator_type !== 'app' || reaction.operator.operator_id !== feishuConfig.application.appId) normal = { status: 200, body: { code: 231007 } }
        else { active.splice(index, 1); removed = reaction; normal = { status: 200, body: { code: 0, data: reaction } } }
      } else throw Error('Unexpected native reaction request')
      const selected = override?.(call, normal) ?? normal
      // A definitive native refusal did not apply its write; a lost ACK may have.
      if (selected.status >= 400 || (selected.body as { code?: number }).code !== 0) {
        if (added) { active.splice(active.indexOf(added), 1); created.splice(created.indexOf(added), 1) }
        if (removed) active.push(removed)
      }
      return selected
    }
  }
}
