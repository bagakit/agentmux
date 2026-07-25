import { AgentMuxError } from './errors.js'

/**
 * 一批投递怎么被消费。
 *
 * 规则全在 check 与 ack 之间：check 给出最旧的一批，**在显式 ack 之前**，同一个 consumer
 * 再 check 必须拿到同一批——否则一次崩溃重连就会把那批消息丢掉。ack 只推进这个 consumer
 * 自己的游标，不改变消息本身的状态：确认"我收到了"不等于"我接受了"。
 *
 * generation 是一道 fence：慢 consumer 带着过期的号回来时，它确认的是一批已经翻篇的东西，
 * 必须失败关闭而不是静默放行——否则它会把后来那一批也一起标记掉。
 */
export type ConsumerCursor = {
  /** 这个 consumer 已 ack 到第几条（不含）。 */
  readonly acked: number
  /** 当前未确认批次的号。每 ack 一次递增。 */
  readonly generation: number
  /** 当前批次的大小；0 表示没有未确认批次。 */
  readonly inFlight: number
}

export type DeliveryQueue = {
  readonly pending: readonly string[]
  readonly consumers: Readonly<Record<string, ConsumerCursor>>
}

export type DeliveryBatch = {
  readonly deliveryIds: readonly string[]
  readonly generation: number
  readonly queue: DeliveryQueue
}

/**
 * 取最旧的一批。已有未确认批次时**原样重放**它——批次大小变了也不换，
 * 因为重放的意义正是"你上次没确认的那一批是什么"，那答案不该随参数变。
 */
export function checkDeliveries(
  queue: DeliveryQueue,
  consumerId: string,
  limit: number
): DeliveryBatch {
  const cursor = queue.consumers[consumerId] ?? { acked: 0, generation: 1, inFlight: 0 }
  const size = cursor.inFlight > 0
    ? cursor.inFlight
    : Math.min(Math.max(0, Math.trunc(limit)), queue.pending.length - cursor.acked)
  return {
    deliveryIds: queue.pending.slice(cursor.acked, cursor.acked + size),
    generation: cursor.generation,
    queue: {
      pending: queue.pending,
      consumers: { ...queue.consumers, [consumerId]: { ...cursor, inFlight: size } }
    }
  }
}

/** 确认一批。只推进这个 consumer 的游标，别的 consumer 照旧。 */
export function ackDeliveryBatch(
  queue: DeliveryQueue,
  consumerId: string,
  generation: number
): DeliveryQueue {
  const cursor = queue.consumers[consumerId]
  // 没 check 过就 ack、或号对不上，都是在确认一批不属于此刻的东西。
  if (!cursor || cursor.inFlight === 0 || cursor.generation !== generation) {
    throw new AgentMuxError(
      'This delivery batch is no longer the one awaiting acknowledgement.',
      'AGENT_DELIVERY_GENERATION_STALE'
    )
  }
  return {
    pending: queue.pending,
    consumers: {
      ...queue.consumers,
      [consumerId]: {
        acked: cursor.acked + cursor.inFlight,
        generation: cursor.generation + 1,
        inFlight: 0
      }
    }
  }
}
