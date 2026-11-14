const assert = require('node:assert/strict')

module.exports = async ({ evaluate, wait, paint, viewport, click, escape, frame, scrollTooltip, receipt }) => {
  for (const [name, width, height, theme, long] of [
    ['relation-wide-dark', 1180, 850, 'dark', false],
    ['relation-wide-light-long', 1180, 850, 'light', true],
    ['relation-narrow-dark', 460, 760, 'dark', true],
    ['relation-narrow-light', 460, 760, 'light', true],
    ['relation-short-dark', 840, 430, 'dark', true],
  ]) {
    await escape(); await viewport(width, height)
    await evaluate(`launchpad.scene({theme:${JSON.stringify(theme)}});spaceLauncher.theme(${JSON.stringify(theme)});spaceLauncher.sourceArrangement(${long})`)
    await wait('document.querySelector(\'[data-executor-id="configured-agent"][aria-pressed="true"]\') !== null')
    await evaluate('document.querySelector(".launch-surface").scrollTop = 0'); await paint()
    assert.equal(await evaluate('Boolean(document.querySelector(\'#fixture-workbench [data-workbench-region-id="launchpad-input"] [data-executor-id="codex"]\'))'), false, 'Unchecked Provider types do not impersonate configured target Agents')
    await evaluate('(()=>{const trigger=document.querySelector(\'#fixture-workbench [data-workbench-region-id="launchpad-input"] [aria-label="Agent location"]\');trigger.blur();trigger.focus()})()')
    await wait('Boolean(document.querySelector(\'[role="tooltip"] .agent-work-detail\'))'); await paint()
    const geometry = await evaluate(`(() => {
      const t = document.querySelector('[role="tooltip"]'), r = t.getBoundingClientRect(), s = document.querySelector('.launch-surface');
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight,
        scrollWidth:t.scrollWidth, clientWidth:t.clientWidth, scrollHeight:t.scrollHeight, clientHeight:t.clientHeight, surfaceWidth:s.clientWidth, surfaceScrollWidth:s.scrollWidth,
        text:t.textContent, agent:t.querySelectorAll('.agent-work-detail__end strong')[1].textContent,
        draft:launchpad.facts().agentDrafts['launchpad-input'], calls:launchpad.facts().calls };
    })()`)
    assert.ok(geometry.left >= 7 && geometry.right <= width - 7 && geometry.top >= 7 && geometry.bottom <= height - 7, 'Reading surface stays inside the actual window')
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'Complete long identities wrap without horizontal scrolling')
    assert.equal(geometry.surfaceWidth, geometry.surfaceScrollWidth)
    assert.match(geometry.text, /Next launch arrangement/); assert.match(geometry.text, /Execution path unconfirmed/)
    assert.doesNotMatch(geometry.agent, /project device/)
    assert.match(geometry.text, /Runtime identities/)
    assert.match(geometry.draft, /keep this unsent task/)
    receipt.checks.push({ name, geometry })
    await frame(name)
    if (name === 'relation-short-dark' && geometry.scrollHeight > geometry.clientHeight) {
      for (let page = 0; page <= Math.ceil(geometry.scrollHeight / geometry.clientHeight); page++) await scrollTooltip(geometry.clientHeight)
      const bottom = await evaluate(`(()=>{const t=document.querySelector('[role="tooltip"] .agent-work-detail').closest('[role="tooltip"]'),r=t.getBoundingClientRect(),ids=t.querySelector('.agent-work-detail__identity').getBoundingClientRect();return{scrollTop:t.scrollTop,clientHeight:t.clientHeight,scrollHeight:t.scrollHeight,top:r.top,bottom:r.bottom,identityTop:ids.top,identityBottom:ids.bottom}})()`)
      assert.ok(bottom.scrollTop > 0 && Math.abs(bottom.scrollTop + bottom.clientHeight - bottom.scrollHeight) <= 2, 'Native wheel reaches the complete detail footer')
      assert.ok(bottom.identityTop >= bottom.top && bottom.identityBottom <= bottom.bottom, 'Complete Runtime identities are visible at scroll end')
      receipt.checks.push({ name: 'short-window-native-scroll', bottom })
      await frame('relation-short-dark-details')
    }
    await escape(); await wait('document.querySelector(\'[role="tooltip"] .agent-work-detail\') === null')
    if (name === 'relation-wide-dark') {
      await click('.agent-work-startup > summary')
      const size = await evaluate('parseFloat(getComputedStyle(document.querySelector(".agent-work-startup > p")).fontSize)')
      assert.ok(size <= 12, 'Expanded compatibility remains subordinate to the main input')
      await frame('relation-compatibility-expanded')
    }
  }
}
