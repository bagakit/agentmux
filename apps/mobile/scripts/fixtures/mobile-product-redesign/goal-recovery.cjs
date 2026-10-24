const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
module.exports = async ({ read, until, resize, tap, button, capture, result, evidence, phase }) => {
  await until('typeof mobileProductScene !== "undefined"')
  if (phase !== 'restore') {
    result.originalGoalRequest = await read('mobileProductScene.seedGoalRecovery()')
  } else {
    const original = JSON.parse(await fs.readFile(path.join(evidence, 'renderer-result.json'), 'utf8')).originalGoalRequest
    const retained = await read('mobileProductScene.facts().record.goalOperationRecords')
    assert.deepEqual(retained, [original], 'Exact original Goal operation survives a new OS process')
    result.originalGoalRequest = original
  }
  await button('手机设置与连接')
  await button('提醒与诊断', '[role=dialog]')
  await until('document.querySelector("[aria-label=未确认的目标操作]")?.textContent.includes("原目标-已删除")')
  if (phase !== 'restore') {
    for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
      await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
      await capture(`goal-recovery-${width}-${appearance}`)
    }
    await tap('[aria-label=未确认的目标操作] summary', '展开原 Goal 请求')
    assert.ok(await read('document.querySelector("[aria-label=未确认的目标操作] button").getBoundingClientRect().height >= 44'), 'Copy original request retains a touch target')
    for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
      await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
      await capture(`goal-recovery-details-${width}-${appearance}`)
    }
  } else {
    assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method.startsWith("goal.") && call.method!=="goal.ls").length'), 0, 'Restart does not replay an original Goal request')
    await capture('goal-recovery-restarted')
  }
  result.goalRecoveryBoundary = 'Actual MobileApp and device workface across private Electron OS process restart with controlled Host facts; no live Host or physical phone claim.'
}
