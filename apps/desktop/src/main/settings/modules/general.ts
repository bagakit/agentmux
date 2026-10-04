import { PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT, MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_VIEW_DEFAULT } from '../../../shared/contracts.js'
import { booleanSetting, enumSetting } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'

export const generalSettings = [
  enumSetting('moteDirectoryView', MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_VIEW_DEFAULT,
    config => config.moteDirectoryView ?? MOTE_DIRECTORY_VIEW_DEFAULT,
    (config, moteDirectoryView) => ({ ...config, moteDirectoryView })),
  booleanSetting('copyPathsAsAbsolute', false, (config) => config.copyPathsAsAbsolute === true,
    (config, copyPathsAsAbsolute) => ({ ...config, copyPathsAsAbsolute })),
  enumSetting('projectRailDensity', PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT,
    (config) => config.projectRailDensity ?? PROJECT_RAIL_DENSITY_DEFAULT,
    (config, projectRailDensity) => ({ ...config, projectRailDensity })),
] satisfies readonly ScalarSetting[]
