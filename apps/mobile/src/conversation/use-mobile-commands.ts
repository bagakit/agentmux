import { useEffect, useMemo, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { composerCommandCandidates, type ComposerPrompt } from '@agentmux/client-ui/composer-command-candidates'

/** Read the original Settings resource only while its menu or editor has a real consumer. */
export function useMobileCommands({ client, agentSessionId, providerId, commands, visible, connected, demand }: {
  client: AgentMuxHostedClient | null; agentSessionId: string | null; providerId: string | undefined
  commands: readonly { text: string; description: string }[] | undefined
  visible: boolean; connected: boolean; demand: boolean
}) {
  const scope = JSON.stringify([agentSessionId, providerId])
  const [revision, retry] = useState(0)
  const [state, setState] = useState<{ client: typeof client; scope: string; prompts: ComposerPrompt[]; loading: boolean; issue: string } | null>(null)
  useEffect(() => {
    if (!visible || !demand) return
    const controller = new AbortController()
    const retained = (previous: typeof state) => previous?.client === client && previous.scope === scope ? previous.prompts : []
    setState(previous => ({ client, scope, prompts: retained(previous), loading: true, issue: '' }))
    void (async () => {
      try {
        if (!client?.forwardRpc || !connected) throw new Error('原 Host 的自定义 Commands 暂不可读；原命令与草稿保留。')
        const result = await client.forwardRpc('settings.prompts.ls', {}, { signal: controller.signal })
        const prompts = result.items.map(({ id, value }): ComposerPrompt => {
          if (typeof id !== 'string' || typeof value.keyword !== 'string' || typeof value.label !== 'string' ||
              typeof value.body !== 'string' || value.providerId !== undefined && typeof value.providerId !== 'string') {
            throw new Error('原 Prompt 的展示字段不完整；已读候选与原命令保留。')
          }
          return { id, keyword: value.keyword, label: value.label, body: value.body,
            ...(value.providerId === undefined ? {} : { providerId: value.providerId }) }
        })
        if (!controller.signal.aborted) setState({ client, scope, prompts, loading: false,
          issue: result.issues?.map(issue => issue.message).join('；') ?? '' })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ client, scope, prompts: retained(previous), loading: false,
          issue: error instanceof Error ? error.message : String(error) }))
      }
    })()
    return () => controller.abort()
  }, [client, scope, visible, connected, demand, revision])
  const own = state?.client === client && state.scope === scope ? state : null
  const candidates = useMemo(() => composerCommandCandidates(own?.prompts ?? [], providerId, commands ?? []), [own?.prompts, providerId, commands])
  return { ...candidates, loading: own?.loading ?? false, issue: own?.issue ?? '', retry: () => retry(value => value + 1) }
}
