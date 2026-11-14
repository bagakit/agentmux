/** One controlled output interval. Finite samples stop at their exact emitted workload. */
export function createOperationOutputStream(write) {
  let timer
  const stop = () => { if (timer !== undefined) clearInterval(timer); timer = undefined }
  return {
    get running() { return timer !== undefined },
    stop,
    start(count = Infinity) {
      if (count !== Infinity && (!Number.isInteger(count) || count < 1)) throw Error('A controlled output batch needs a positive integer count')
      stop()
      let remaining = count
      timer = setInterval(() => { write(count !== Infinity); if (--remaining === 0) stop() }, 160)
    }
  }
}
