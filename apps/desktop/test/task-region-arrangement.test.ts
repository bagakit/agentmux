import { describe, expect, it } from 'vitest'
import { DEMAND_ARRANGEMENT_IDS } from '../src/renderer/src/lib/global-demand-board.js'
import { sessionRegionHostClassName } from '../src/renderer/src/components/SessionRegionHost.js'

describe('task Region arrangement', () => {
  it('maps each persisted arrangement to one stable host class', () => {
    // 输入取 SSOT，于是加第四种 arrangement 时这条当场红——上一版把三个名字手抄在这里，抄本和
    // SSOT 会各自漂移，而漂开的那一刻它自己不会响。期望值仍写成字面量：若也照
    // `session-region-host--${id}` 拼出来，断言就在拿被测函数验证它自己。
    expect(DEMAND_ARRANGEMENT_IDS.map((arrangement) => sessionRegionHostClassName(arrangement))).toEqual([
      'session-region-host session-region-host--columns',
      'session-region-host session-region-host--grid',
      'session-region-host session-region-host--balanced'
    ])
  })
})
