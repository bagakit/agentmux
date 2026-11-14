import { savedMoteAvatarSnapshot } from '@agentmux/host/mote-avatar-state'
import { DEFAULT_THEME_ID, resolveTheme } from '@agentmux/client-ui/theme'
import { moteAvatarSvg } from '@agentmux/client-ui/mote-avatar-svg'
import { isSpaceIconId } from '@agentmux/client-ui/space-icon-ids'
import { isMoteFace } from '../shared/mote-avatars.js'
import type { MoteAvatarTarget } from '@agentmux/core/mote-avatar-write'
import type { AppConfig } from '../shared/contracts.js'
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0,2048)
function rawChoice(config: AppConfig, target: MoteAvatarTarget): unknown {
  const icons = config.appearance.spaceObjectIcons
  return icons && Object.hasOwn(icons,target.objectKey) ? icons[target.objectKey] : undefined
}
export function moteAvatarSnapshot(config: AppConfig, target: MoteAvatarTarget, prefersDark: boolean) {
  const value = rawChoice(config,target)
  let svg: string | null = null, issue: string | undefined
  try {
    if (value == null || isSpaceIconId(value)) {
      const appearance = config.appearance, id = appearance.themeId ?? DEFAULT_THEME_ID
      const theme = resolveTheme({ themeId: id, appAppearance: appearance.appAppearance ?? 'dark',
        customThemes: appearance.customThemes && Object.hasOwn(appearance.customThemes, id) ? { [id]: appearance.customThemes[id] } : {} }, prefersDark)
      if (theme.issues.length) throw new Error(theme.issues.map(item => item.message).join(' '))
      svg = moteAvatarSvg(value ?? null, theme)
    } else if (isMoteFace(value)) svg = moteAvatarSvg(value)
  } catch (error) { issue = message(error) }
  return { ...savedMoteAvatarSnapshot(config.appearance, target.objectKey, svg ?? undefined), svg, issue }
}
export function moteAvatarRevision(config: AppConfig, target: MoteAvatarTarget, prefersDark = true): string {
  return moteAvatarSnapshot(config, target, prefersDark).revision
}

