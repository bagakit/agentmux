import { moteMainRoleRevision, type MoteMainSnapshot } from '@agentmux/core/mote-dialogue'
import { sameMoteDefaultConversation } from '@agentmux/core/mote-preferences'
import type { MoteWorkfaceScope } from './mote-workface'

/** Saved policy is explanatory here. Only Core decides whether a new question rolls over. */
export function moteMainServicePolicy(scope: MoteWorkfaceScope, main: MoteMainSnapshot): 'unconfirmed' | 'unconfigured' | 'keep-current' | 'automatic' {
  const saved = scope.topic.quickMode, current = main.current
  if (scope.issue || saved?.status !== 'saved' || !current || saved.version !== main.documentRevision ||
    !sameMoteDefaultConversation(saved.defaults.conversation, current) ||
    moteMainRoleRevision(saved.defaults, saved.version ?? null) !== main.roleRevision) return 'unconfirmed'
  const policy = saved.defaults.conversationRollover
  return !policy ? 'unconfigured' : policy.kind === 'keep-current' ? 'keep-current' : 'automatic'
}

export function moteMainServicePresentation(status: 'unavailable' | 'unconfirmed', policy: ReturnType<typeof moteMainServicePolicy>, pendingCreation: boolean) {
  if (pendingCreation) return { title: '开始请求尚待确认', mode: '原请求和问题都已保留，不会重复创建。', restore: '查看这次开始的进度。', action: 'start' as const, label: '查看开始进度', hint: '写下新的问题，原请求仍留在原处…' }
  if (status === 'unconfirmed') return null
  const mode = policy === 'automatic' ? '已开启自动接续。新问题由保存的策略决定是否切换。'
    : policy === 'keep-current' ? '已设为保留当前对话，可明确继续新对话。'
    : policy === 'unconfigured' ? '尚未配置自动接续，可明确继续新对话。' : '接续设置尚未确认，可从主对话菜单核对。'
  return { title: '主对话需要接续', mode, restore: '原对话和草稿保留，旧消息不会重发。',
    action: policy === 'automatic' ? null : policy === 'unconfirmed' ? 'settings' as const : 'start' as const,
    label: policy === 'unconfirmed' ? '核对接续设置' : '继续新对话', hint: '写下新的问题…' }
}
