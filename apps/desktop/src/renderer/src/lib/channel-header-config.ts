import type { ChannelHeaderConfigure } from '@agentmux/core'
import { api } from './api'
import { useAppStore } from '../store'

export async function saveChannelHeader(input: ChannelHeaderConfigure) {
  const before = useAppStore.getState().config
  if (!before) throw new Error('App settings are still loading. Your display draft is retained.')
  const committed = await api.config.configureChannelHeader(input)
  if (useAppStore.getState().config === before) useAppStore.getState().setConfig(committed)
  return committed
}
