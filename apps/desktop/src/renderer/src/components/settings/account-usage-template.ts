import type { ToolkitToolFields } from '@agentmux/core/control'
import script from '../../../../../resources/toolkit/account-usage.mjs?raw'

export const accountUsageScript = script

/** A one-time draft, without a template runtime identity or startup seeding. */
export function createAccountUsageTool(): ToolkitToolFields {
  return { name: 'Account usage', icon: 'gauge', enabled: false, statusBar: 'icon',
    workspacePath: '', script, args: ['', ''], actions: [] }
}
