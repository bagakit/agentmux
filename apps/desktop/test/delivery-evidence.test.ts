import { describe, expect, it } from 'vitest'
import { describeDeliveryEvidence } from '../src/renderer/src/lib/delivery-evidence.js'

// UI 只能声明证据支持的东西。启动投递最多证明"送到了"——把它写成"已回复"，
// 用户就会以为对方看过并回应了，而实际上可能连读都没读。

describe('每一档只说证据支持的那句话', () => {
  it('delivered 说送达，不说被接受', () => {
    const shown = describeDeliveryEvidence('delivered')
    expect(shown.label).toBe('Delivered')
    expect(shown.label.toLowerCase()).not.toContain('replied')
    expect(shown.label.toLowerCase()).not.toContain('accepted')
  })

  it('accepted 与 replied 是不同的两句话', () => {
    expect(describeDeliveryEvidence('accepted').label).not.toBe(
      describeDeliveryEvidence('replied').label
    )
  })

  it('timed-out 与 cancelled 分开说——没等到和不等了不是一回事', () => {
    expect(describeDeliveryEvidence('timed-out').label).not.toBe(
      describeDeliveryEvidence('cancelled').label
    )
  })

  it('七个状态都有文案，不会漏出一个裸状态码给用户', () => {
    for (const state of [
      'queued', 'delivered', 'accepted', 'replied', 'failed', 'timed-out', 'cancelled'
    ] as const) {
      const shown = describeDeliveryEvidence(state)
      expect(shown.label.length).toBeGreaterThan(0)
      // 文案不能就是状态码本身——那等于没翻译。
      expect(shown.label).not.toBe(state)
    }
  })
})

describe('哪些状态还在等结果', () => {
  it('queued 与 delivered 仍在等', () => {
    expect(describeDeliveryEvidence('queued').settled).toBe(false)
    expect(describeDeliveryEvidence('delivered').settled).toBe(false)
  })

  it('四个终态都已落定', () => {
    for (const state of ['replied', 'failed', 'timed-out', 'cancelled'] as const) {
      expect(describeDeliveryEvidence(state).settled).toBe(true)
    }
  })

  it('accepted 尚未落定——对方接了，但还没回', () => {
    expect(describeDeliveryEvidence('accepted').settled).toBe(false)
  })
})

describe('复用共享注意力语汇', () => {
  it('失败与超时归入 error，不发明第三套', () => {
    expect(describeDeliveryEvidence('failed').attention).toBe('error')
    expect(describeDeliveryEvidence('timed-out').attention).toBe('error')
  })

  it('回复完成归入 done', () => {
    expect(describeDeliveryEvidence('replied').attention).toBe('done')
  })

  it('还在路上的不占用注意力', () => {
    expect(describeDeliveryEvidence('queued').attention).toBeNull()
    expect(describeDeliveryEvidence('cancelled').attention).toBeNull()
  })
})
