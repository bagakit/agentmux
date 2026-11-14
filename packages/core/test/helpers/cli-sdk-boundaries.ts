import type { AgentMuxRpcMethod } from '../../src/public-rpc.js'

/** Exact deliberate omissions, not a blanket namespace exclusion or an E2E claim. */
export const CLI_SDK_BOUNDARIES = {
  'goal.activity.read': 'Original full-read primitive; user CLI offers exact paged activity history.',
  'goal.activity.collection': 'Original selected-Goal confirmation cut composed by goal activity.',
  'route.receive': 'Signed receiver transport; explicit route call is the original caller intent.',
  'route.receive-watch': 'Signed receiver stream; route watch retains the original reader and scope.',
  'agent.learning.confirm': 'Actual App person confirmation, not an Agent assertion.',
  'agent.learning.confirmation': 'Live App confirmation binding observation, not a fabricated approval.',
  'capsule.input': 'Trusted original App human-input protocol; business interaction CLI remains available.',
  'runtime.owner.shutdown': 'Exact SDK owner administration; Host maintenance has the reviewed business flow.',
  'runtime.profile.capture': 'Composed by system metrics host-profile capture with original owner fence.',
  'runtime.bootstrap': 'Hosted consumer initialization, not a second creation intent.',
  'runtime.invoke': 'Finite hosted SDK transport behind typed business operations.',
  'runtime.release-consumer': 'SDK consumer release, not process stop.',
  'runtime.events': 'Hosted SDK events; business observations have their own CLI readers.',
  'runtime.conversation-watch': 'Hosted SDK conversation transport; agent conversation watch is public CLI.',
  'runtime.history-watch': 'Hosted SDK history transport, not a separate user intent.',
  'runtime.attachment-watch': 'Original attachment transport; terminal/agent output own their readers.',
  'runtime.replay-watch': 'SDK ordered-byte replay transport behind exact original readers.',
  'app.mobile.assets.loaded': 'Actual device page producer observation; CLI cannot prove page loading.',
  'app.mobile.report': 'Actual mobile producer report; CLI diagnostics read the original report.',
  'message.delivery.report': 'Original delivery producer evidence; CLI cannot manufacture delivery.',
  'system.subscription.cancel': 'SDK reader cleanup on its own subscription, never Native lifecycle.'
} as const satisfies Partial<Record<AgentMuxRpcMethod, string>>
