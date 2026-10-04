export type MobileHome = 'mote' | 'focus' | 'space'
export type MobilePrimaryWorkface = MobileHome | 'goals' | 'topics'
const KEY = 'agentmux-mobile-home'
export function readMobileHome(): { home: MobilePrimaryWorkface; issue: string | null } {
  try {
    const value = localStorage.getItem(KEY)
    if (value === null) return { home: 'focus', issue: null }
    if (value === 'mote' || value === 'focus' || value === 'space' || value === 'goals' || value === 'topics') return { home: value, issue: null }
    return { home: 'focus', issue: '默认主页记录无法读取，原记录保留。可在设置中明确选择新的主页。' }
  } catch { return { home: 'focus', issue: '默认主页暂时无法读取，本次先显示 Focus；会话与草稿保留。' } }
}
export function saveMobileHome(home: MobilePrimaryWorkface): void { localStorage.setItem(KEY, home) }
