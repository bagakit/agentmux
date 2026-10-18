import type { ToolkitToolConfiguration } from '@agentmux/core/control'
import type { SemanticIconId } from '@agentmux/client-ui/icons'

export const PERFORMANCE_STATUS_BAR_IDS = ['icon', 'label'] as const
/** Saved values and semantic roles are shared by the picker, renderer and both config paths. */
export const TOOLKIT_ICON_OPTIONS = [
  { value: 'terminal', semanticId: 'toolkit.terminal', group: 'Common', keywords: 'shell command console 终端 命令' },
  { value: 'zap', semanticId: 'toolkit.lightning', group: 'Common', keywords: 'lightning quick automation 闪电 快捷 自动化' },
  { value: 'refresh-cw', semanticId: 'toolkit.refresh', group: 'Common', keywords: 'refresh sync reload 刷新 同步' },
  { value: 'gauge', semanticId: 'toolkit.gauge', group: 'Common', keywords: 'performance monitor metrics 性能 监控 指标' },
  { value: 'key-round', semanticId: 'toolkit.key', group: 'Common', keywords: 'auth login credentials key 密钥 认证 登录' },
  { value: 'credit-card', semanticId: 'toolkit.card', group: 'Common', keywords: 'account billing quota card 账户 额度 账单 卡' },
  { value: 'bot', semanticId: 'toolkit.agent', group: 'Common', keywords: 'agent assistant bot 智能体 助手 机器人' },
  { value: 'sparkles', semanticId: 'toolkit.sparkle', group: 'Common', keywords: 'ai magic sparkles 智能 灵感' },
  { value: 'smartphone', semanticId: 'toolkit.phone', group: 'Common', keywords: 'phone mobile 手机 移动' },
  { value: 'folder', semanticId: 'object.folder', group: 'Files & data', keywords: 'folder directory files 文件夹 目录' },
  { value: 'file-text', semanticId: 'file.text', group: 'Files & data', keywords: 'file text document log 文件 文本 文档 日志' },
  { value: 'hard-drive', semanticId: 'object.disk', group: 'Files & data', keywords: 'disk drive storage volume 磁盘 存储 硬盘' },
  { value: 'database', semanticId: 'file.database', group: 'Files & data', keywords: 'database sql query 数据库 查询' },
  { value: 'note-page', semanticId: 'object.note', group: 'Files & data', keywords: 'note memo writing 笔记 备忘 写作' },
  { value: 'git-branch', semanticId: 'object.branch', group: 'System & development', keywords: 'git branch repository 分支 仓库 版本' },
  { value: 'cpu', semanticId: 'object.processor', group: 'System & development', keywords: 'cpu processor process resource 处理器 进程 资源' },
  { value: 'devices-network', semanticId: 'object.network', group: 'System & development', keywords: 'network devices connection 网络 设备 连接' },
  { value: 'server', semanticId: 'object.host', group: 'System & development', keywords: 'server host remote ssh 服务器 主机 远程' }
] as const satisfies readonly { value: string; semanticId: SemanticIconId; group: string; keywords: string }[]
export type ToolkitIconId = typeof TOOLKIT_ICON_OPTIONS[number]['value']
export const TOOLKIT_ICON_IDS = TOOLKIT_ICON_OPTIONS.map(option => option.value)
export function findToolkitIcon(icon: string) { return TOOLKIT_ICON_OPTIONS.find(option => option.value === icon) }
export type PerformanceStatusBar = typeof PERFORMANCE_STATUS_BAR_IDS[number]
export type PerformancePreferences = { enabled: boolean; statusBar: PerformanceStatusBar }
export const MOBILE_CONNECTION_TOOL_ID = 'builtin:mobile-connection'
export const MOBILE_CONNECTION_STATUS_BAR_IDS = PERFORMANCE_STATUS_BAR_IDS
export type MobileConnectionPreferences = { enabled: boolean; statusBar: PerformanceStatusBar }
export type ToolkitPreferences = { performance?: Partial<PerformancePreferences>; mobileConnection?: Partial<MobileConnectionPreferences>; tools?: ToolkitToolConfiguration[] }

export const DEFAULT_PERFORMANCE_PREFERENCES: PerformancePreferences = Object.freeze({ enabled: true, statusBar: 'icon' })

/** An absent preference is a default, not a reason to write the config. */
export function resolvePerformancePreferences(config: { toolkit?: ToolkitPreferences }): PerformancePreferences {
  return {
    enabled: config.toolkit?.performance?.enabled ?? DEFAULT_PERFORMANCE_PREFERENCES.enabled,
    statusBar: config.toolkit?.performance?.statusBar ?? DEFAULT_PERFORMANCE_PREFERENCES.statusBar
  }
}

export const DEFAULT_MOBILE_CONNECTION_PREFERENCES: MobileConnectionPreferences = Object.freeze({ enabled: true, statusBar: 'icon' })

/** Showing the entry is independent of device authorization or private-access availability. */
export function resolveMobileConnectionPreferences(config: { toolkit?: ToolkitPreferences }): MobileConnectionPreferences {
  return {
    enabled: config.toolkit?.mobileConnection?.enabled ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES.enabled,
    statusBar: config.toolkit?.mobileConnection?.statusBar ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES.statusBar
  }
}
