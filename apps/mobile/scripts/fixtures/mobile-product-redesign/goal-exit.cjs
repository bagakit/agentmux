const assert = require('node:assert/strict')
module.exports = async ({ read, until, resize, tap, button, capture, result }) => {
  await until('typeof mobileProductScene !== "undefined"')
  await read('mobileProductScene.prepareAgentMenu()')
  await button('Goals', '.mobile-navigation')
  await until('document.querySelector(".mobile-goals-list")')
  await button('把两个想法变成一个小实验', '.mobile-goals-list')
  for (const title of ['协作、关联与高级动作', '关联项目或会话']) {
    await read(`(()=>{const element=[...document.querySelectorAll('summary')].find(n=>n.textContent.trim()===${JSON.stringify(title)}); if(!element)throw Error('Missing original Goal summary'); element.dataset.fixtureGoalSummary='current'})()`)
    await tap('[data-fixture-goal-summary=current]', title)
    await read('delete document.querySelector("[data-fixture-goal-summary=current]").dataset.fixtureGoalSummary')
  }
  await tap('[aria-label="关联 Session ID"]', '输入原 Session')
  await read(`(()=>{const input=document.querySelector('[aria-label="关联 Session ID"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'session-original');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await read('mobileProductScene.holdGoalRecoveryWrite()')
  await button('关联会话')
  await until('document.body.textContent.includes("关联回执未确认")')
  await button('手机设置与连接')
  await button('提醒与诊断', '[role=dialog]')
  await until('document.querySelector("[aria-label=未确认的目标操作]")')
  await tap('[aria-label=未确认的目标操作] summary', '展开原请求')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await capture(`goal-exit-request-${width}-${appearance}`)
  }
  await button('复制原请求')
  await button('已另行保全，移除本页副本…')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    assert.ok(await read('[...document.querySelectorAll("button")].find(n=>n.textContent.trim()==="确认已保全并移除本页副本").getBoundingClientRect().height >= 44'))
    await capture(`goal-exit-confirm-${width}-${appearance}`)
  }
  await button('确认已保全并移除本页副本')
  await until('!document.querySelector("[aria-label=未确认的目标操作]")')
  assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="goal.link-session").length'), 1)
  result.goalExitBoundary = 'Actual MobileApp, controlled Goal RPC and held device write; no live Host or physical phone claim.'
}
