/** Observe the production reading section during one already-defined original append.
 * Instrumentation is identical in both variants and removed before the next action. */
export async function beginAnchorSample(read, debuggerClient, feedSelector) {
  const names = ['Timestamp', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']
  const counters = async () => {
    const { metrics } = await debuggerClient.sendCommand('Performance.getMetrics')
    return Object.fromEntries(metrics.filter(item => names.includes(item.name)).map(item => [item.name, item.value]))
  }
  await debuggerClient.sendCommand('Performance.enable', { timeDomain: 'timeTicks' })
  const before = await counters()
  await read(`(() => {
    const selector = ${JSON.stringify(feedSelector)}, feed = document.querySelector(selector)
    const root = feed?.querySelector('.conversation-native-thread')
    if (!root) throw Error('The original shared reading section is absent')
    if (feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 64) throw Error('The original viewport is still at its live tail')
    if (getSelection()?.isCollapsed === false) throw Error('Measure ordinary reading after the selected-original check')
    const tailDistance = feed.scrollHeight - feed.clientHeight - feed.scrollTop
    const original = root.querySelectorAll, rootNodeCount = original.call(root, '*').length
    let layoutKeyQueries = 0, request = 0, last = null
    const frames = []
    root.querySelectorAll = function (query) {
      if (query === '[data-conversation-layout-key]') layoutKeyQueries++
      return original.call(this, query)
    }
    const next = at => { if (last !== null) frames.push(at - last); last = at; request = requestAnimationFrame(next) }
    request = requestAnimationFrame(next)
    window.readingAnchorSample = () => {
      delete root.querySelectorAll
      cancelAnimationFrame(request)
      delete window.readingAnchorSample
      return { layoutKeyQueries, frames, rootNodeCount, tailDistance, stillMounted: root.isConnected }
    }
  })()`)
  return async () => {
    const observation = await read('readingAnchorSample()')
    const after = await counters()
    return { ...observation, before, after }
  }
}
