import type { ConnectionSetupVersionStatus } from '@agentmux/core/connections'

export const feishuVersionStatus = (v: unknown): ConnectionSetupVersionStatus => v === 0 || v === 4 ? 'draft' : v === 1 ? 'reviewing' : v === 2 ? 'approved' : v === 3 ? 'rejected' : v === 5 ? 'awaiting-release' : 'unknown'
