import { resolveUserProfile, USER_PROFILE_NAME_LIMIT, USER_PROFILE_ABOUT_LIMIT, validProfileAvatar, type UserProfile } from '../../../shared/user-profile.js'
import { booleanSetting, textSetting, type ScalarSetting } from '../scalar-setting.js'

const write = <K extends keyof UserProfile>(config: Parameters<ScalarSetting['entry']>[0], key: K, value: UserProfile[K]) =>
  ({ ...config, profile: { ...resolveUserProfile(config.profile), [key]: value } })

export const profileSettings = [
  textSetting('profile.displayName', config => resolveUserProfile(config.profile).displayName,
    (config, value) => write(config, 'displayName', value), value => value.length <= USER_PROFILE_NAME_LIMIT && !/[\r\n\x00-\x1f]/.test(value)),
  textSetting('profile.about', config => resolveUserProfile(config.profile).about,
    (config, value) => write(config, 'about', value), value => value.length <= USER_PROFILE_ABOUT_LIMIT),
  textSetting('profile.avatar', config => resolveUserProfile(config.profile).avatar,
    (config, value) => write(config, 'avatar', value), validProfileAvatar),
  booleanSetting('profile.shareWithAgents', false, config => resolveUserProfile(config.profile).shareWithAgents,
    (config, value) => write(config, 'shareWithAgents', value))
] satisfies readonly ScalarSetting[]
