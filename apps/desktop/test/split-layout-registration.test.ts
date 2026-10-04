import { expect, it, vi } from 'vitest'
import { SplitRatioCommitter, synchronizeSplitLayout } from '../src/renderer/src/lib/split-ratio-commit'

it('keeps accepted ratio during zero/one Panel registration, then applies that exact intent with two Panels', () => {
  const setLayout = vi.fn()
  let current: number[] = []
  const group = { getLayout: () => current, setLayout }
  synchronizeSplitLayout(group, 0.7)
  current = [100]; synchronizeSplitLayout(group, 0.7)
  expect(setLayout).not.toHaveBeenCalled()
  // Registration uses the same original Panel defaultSize props. Once confirmed,
  // a later ratio/visibility effect can synchronize the original library handle.
  current = [50, 50]; synchronizeSplitLayout(group, 0.7)
  expect(setLayout).toHaveBeenCalledTimes(1)
  expect(setLayout.mock.calls[0]![0]).toEqual([70, expect.closeTo(30, 8)])
  current = [70, 30]; synchronizeSplitLayout(group, 0.7)
  expect(setLayout).toHaveBeenCalledTimes(1)
  synchronizeSplitLayout(group, 0.6)
  expect(setLayout).toHaveBeenLastCalledWith([60, 40])
})
it('leaves original drag commits with the accepted ratio owner', () => {
  const commit = vi.fn(), owner = new SplitRatioCommitter(0.5, commit)
  owner.setDragging(true); owner.observeLayout([65, 35]); owner.observeLayout([70, 30])
  expect(commit).not.toHaveBeenCalled()
  owner.setDragging(false)
  expect(commit).toHaveBeenCalledExactlyOnceWith(0.7)
})
