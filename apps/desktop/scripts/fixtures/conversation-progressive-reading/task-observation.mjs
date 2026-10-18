/** Preserve original completed task entries without claiming coverage of the current snapshot task. */
export function observeReadingTasks() {
  const longTasks = [], longTaskEntries = []
  const record = entries => {
    longTasks.push(...entries.map(entry => entry.duration))
    longTaskEntries.push(...entries.map(entry => JSON.parse(JSON.stringify(entry))))
  }
  const observer = new PerformanceObserver(list => record(list.getEntries()))
  observer.observe({ type: 'longtask', buffered: true })
  return () => {
    record(observer.takeRecords())
    return { longTasks: [...longTasks], longTaskEntries: structuredClone(longTaskEntries),
      observation: { observedThrough: performance.now(), buffered: true,
        boundary: 'Completed original entries available at this snapshot. The current snapshot task and work before the later native counter endpoint may not be present; this is not exhaustive task coverage.' } }
  }
}
