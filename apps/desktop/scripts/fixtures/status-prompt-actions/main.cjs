const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const [html, privateRoot, evidence, proofMode] = process.argv.slice(2);
app.setPath('userData', path.join(privateRoot, 'user-data'));
app.setPath('sessionData', path.join(privateRoot, 'session-data'));
let win;
const result = { schema: 'agentmux.status-prompt-render.v2', passed: false, frames: [], scenes: [], userRunTouched: false };
const evaluate = expression => win.webContents.executeJavaScript(expression), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`;
const trigger = `${surface}.querySelector('.composer-agent-identity button')`;
const face = `document.getElementById(${trigger}.getAttribute('aria-controls'))`;
const buttons = `${face}.querySelectorAll('.agent-status-prompts__button')`;
async function waitFor(expression) {
    for (let i = 0; i < 160; i++) {
        if (await evaluate(expression))
            return;
        await delay(25);
    }
    assert.fail('Expected actual renderer fact: ' + expression);
}
async function painted() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(40); }
async function click(expression) {
    const point = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Target absent: '+${JSON.stringify(expression)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),body=getComputedStyle(e).position==='absolute'?null:e.closest('.agent-identity-popover')?.dataset.compact==='true'?e.closest('.agent-state-face')?.getBoundingClientRect():e.closest('.agent-state-face__body')?.getBoundingClientRect();const top=Math.max(r.top,body?.top??r.top),bottom=Math.min(r.bottom,body?.bottom??r.bottom);if(bottom<=top)throw new Error('No visible target area');const point={x:r.x+r.width/2,y:(top+bottom)/2};if(!e.contains(document.elementFromPoint(point.x,point.y)))throw new Error('Target is occluded');return point})()`);
    for (const type of ['mousePressed', 'mouseReleased'])
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    await painted();
}
async function key(key, code, virtual, text) {
    for (const type of ['keyDown', 'keyUp'])
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
}
async function geometry() {
    return evaluate(`(()=>{const s=${surface},rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{
body:rect(s.querySelector('.agent-body')),terminal:rect(s.querySelector('.terminal-view__xterm')),composer:rect(s.querySelector('.composer')),editor:rect(s.querySelector('.composer [role="textbox"]')),
faceBody:rect(${face}?.querySelector('.agent-state-face__body')),faceSummary:rect(${face}?.querySelector('.agent-state-face__summary')),faceHeader:rect(${face}?.querySelector('header')),identity:rect(s.querySelector('.composer-agent-identity')),trigger:rect(${trigger}),face:rect(${face}),region:rect(s.closest('[data-workbench-region-id]')),
editorText:s.querySelector('.composer [role="textbox"]')?.textContent,xterm:resultReady.terminal(),facts:statusPromptActions.facts(),mode:s.querySelector('.composer-tools')?.dataset.mode}})()`);
}
async function settledGeometry() {
    let before = await geometry();
    for (let i = 0; i < 12; i++) {
        await delay(160);
        const after = await geometry();
        if (JSON.stringify([before.body, before.terminal, before.composer, before.editor, before.xterm.rows, before.facts.resizes.length]) === JSON.stringify([after.body, after.terminal, after.composer, after.editor, after.xterm.rows, after.facts.resizes.length]))
            return after;
        before = after;
    }
    assert.fail('Original work surface must settle');
}
function stable(before, after) {
    for (const name of ['body', 'terminal', 'composer', 'editor', 'identity', 'editorText'])
        assert.deepEqual(after[name], before[name], 'Status face preserves original work surface geometry · ' + name);
    for (const name of ['id', 'cols', 'rows', 'baseY', 'viewportY', 'cursorX', 'cursorY', 'cursorLine', 'visibleLines'])
        assert.deepEqual(after.xterm[name], before.xterm[name], 'Status face preserves original xterm · ' + name);
    for (const name of ['drafts', 'tab', 'layout', 'resizes', 'sessions'])
        assert.deepEqual(after.facts[name], before.facts[name], 'Status face retains original ' + name);
}
async function protectedFace() {
    const g = await geometry();
    assert.ok(g.face, 'Actual face is nonempty');
    assert.ok(g.face.y >= 8 && g.face.x >= g.region.x + 7);
    assert.ok(g.face.x + g.face.width <= g.region.x + g.region.width - 7);
    const bottom = g.face.y + g.face.height;
    assert.ok(bottom <= g.composer.y - 5 || g.face.y >= g.composer.y + g.composer.height + 5 || g.face.x + g.face.width <= g.composer.x - 5 || g.face.x >= g.composer.x + g.composer.width + 5, 'Panel does not overlap the complete Composer');
    assert.ok(bottom <= g.terminal.y + g.terminal.height - 32 - 5 || g.face.y >= g.terminal.y + g.terminal.height + 5, 'Panel does not overlap the native last 32px band');
    assert.ok(g.face.height <= 360 && g.face.width <= 296);
    assert.ok(await evaluate(`(()=>{const r=${face}.querySelector('header').getBoundingClientRect(),f=${face}.getBoundingClientRect();return r.y>=f.y&&r.bottom<=f.bottom})()`), 'Header and close stay reachable');
    return g;
}
async function initialPromptAction() {
    const observation = await evaluate(`(()=>{const b=${buttons}[0];if(!b)throw new Error('First current Prompt action is absent');const s=(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body')),clip=s.getBoundingClientRect();return{scrollTop:s.scrollTop,clip:{top:clip.top,bottom:clip.bottom,left:clip.left,right:clip.right},texts:['.agent-status-prompts__label','.agent-status-prompts__intent'].map(selector=>{const e=b.querySelector(selector),range=document.createRange();range.selectNodeContents(e);return{text:e.textContent,rects:Array.from(range.getClientRects()).map(r=>({top:r.top,bottom:r.bottom,left:r.left,right:r.right,hit:b.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2))}))}})}})()`);
    assert.equal(observation.scrollTop, 0, 'The initial Prompt action is visible before focus or scrolling');
    assert.equal(observation.texts.length, 2);
    for (const text of observation.texts) {
        assert.ok(text.text.length > 0 && text.rects.length > 0, 'The Prompt label and Send/Queue intent have actual text ranges');
        for (const rect of text.rects) {
            assert.ok(rect.top >= observation.clip.top - 1 && rect.bottom <= observation.clip.bottom + 1 && rect.left >= observation.clip.left - 1 && rect.right <= observation.clip.right + 1, 'The complete first Prompt label and intent are inside the initial scroll clip');
            assert.equal(rect.hit, true, 'The initial Prompt text belongs to the actual clickable action');
        }
    }
    (result.initialPromptActions ??= []).push({ stage: result.stage, ...observation });
}
async function frame(width, name) { await painted(); const file = `${width}-${name}.png`, bytes = (await win.webContents.capturePage()).toPNG(); assert.ok(bytes.length > 0); await fs.writeFile(path.join(evidence, file), bytes); result.frames.push({ width, name, file }); }
async function open() {
    if (!await evaluate(`Boolean(${face})`))
        await click(trigger);
    await waitFor(`Boolean(${face})`);
    await painted();
}
async function escape() { await key('Escape', 'Escape', 27); await painted(); assert.equal(await evaluate(`Boolean(${face})`), false, 'Escape closes without reopening focus preview'); assert.equal(await evaluate(`document.activeElement===${trigger}`), true); }
async function scene(width, height, appearance, draft, mode = 'collapsed', lower = false) {
    result.stage = { width, height, appearance, draft };
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: lower ? width + 1 : width * 2 + 1, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`statusPromptActions.seed(false);statusPromptActions.appearance(${JSON.stringify(appearance)});statusPromptActions.draft(${JSON.stringify(draft)})`);
    if (lower)
        await evaluate('statusPromptActions.lowerRegion()');
    for (let step = 0; step < ['collapsed', 'current', 'expanded'].indexOf(mode); step++)
        await click(`${surface}.querySelector('.composer-tool--mode')`);
    await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea'))&&!${surface}.querySelector('.terminal-view__xterm--hydrating')`);
    const unconfigured = await settledGeometry();
    assert.equal(await evaluate(`${surface}.querySelector('.agent-status-prompts')`), null, 'No Prompt layout row');
    assert.equal(await evaluate(`${surface}.querySelector('.session-result-review-slot')`), null, 'No empty Review layout slot');
    assert.equal(unconfigured.trigger.width, 24);
    assert.equal(unconfigured.identity.width, 26);
    await evaluate('statusPromptActions.seed(true)');
    await evaluate(`statusPromptActions.appearance(${JSON.stringify(appearance)});statusPromptActions.draft(${JSON.stringify(draft)})`);
    if (lower)
        await evaluate('statusPromptActions.lowerRegion()');
    for (let step = 0; step < ['collapsed', 'current', 'expanded'].indexOf(mode); step++)
        await click(`${surface}.querySelector('.composer-tool--mode')`);
    await waitFor(`!${surface}.querySelector('.terminal-view__xterm--hydrating')`);
    const before = await settledGeometry();
    for (const name of ['composer', 'editor', 'identity'])
        assert.deepEqual(before[name], unconfigured[name], 'Configuration occupies zero additional Composer space');
    await frame(width, `${height}-${appearance}-${before.mode}-closed`);
    await click(`${surface}.querySelector('.terminal-view__xterm')`);
    const writes = await evaluate('statusPromptActions.facts().writes.length');
    await key('a', 'KeyA', 65, 'a');
    await waitFor(`statusPromptActions.facts().writes.length>${writes}`);
    assert.equal(await evaluate('statusPromptActions.facts().writes.at(-1).data'), 'a');
    assert.equal(await evaluate('statusPromptActions.facts().writes.at(-1).source'), 'user');
    const baseline = await settledGeometry();
    const states = await evaluate('statusPromptActions.states');
    assert.equal(states.length, 9);
    for (const state of states.filter(s => s !== 'disconnected')) {
        result.stage = { width, height, appearance, state };
        await evaluate(`statusPromptActions.state(${JSON.stringify(state)})`);
        await painted();
        stable(baseline, await geometry());
        await open();
        stable(baseline, await protectedFace());
        const actual = await evaluate(`Array.from(${buttons}).map(b=>b.getAttribute('aria-label'))`), expected = await evaluate(`statusPromptActions.prompts.filter(p=>p.states.includes(${JSON.stringify(state)})).map(p=>'Send '+p.label)`);
        assert.ok(actual.length > 0);
        assert.deepEqual(actual, expected);
        await initialPromptAction();
        await escape();
        stable(baseline, await geometry());
    }
    await evaluate('statusPromptActions.state("done")');
    await open();
    const gitBefore = await evaluate('statusPromptActions.facts().gitCalls.length');
    assert.equal(gitBefore, baseline.facts.gitCalls.length, 'Closed and initial face do not consume Git');
    const length = await evaluate(`${buttons}.length`);
    assert.equal(length, 8);
    await evaluate(`${buttons}[0].focus()`);
    const labels = [];
    for (let i = 0; i < length; i++) {
        labels.push(await evaluate(`document.activeElement.getAttribute('aria-label')`));
        assert.equal(await evaluate(`${face}.contains(document.activeElement)`), true);
        if (i + 1 < length) {
            await key('Tab', 'Tab', 9);
            await painted();
        }
    }
    assert.deepEqual(labels, await evaluate(`Array.from(${buttons}).map(b=>b.getAttribute('aria-label'))`));
    assert.ok(await evaluate(`Math.max(${face}.querySelector('.agent-state-face__body').scrollTop,${face}.querySelector('.agent-state-face').scrollTop)>0`), 'All full labels and bodies reachable through body scroll');
    await protectedFace();
    await frame(width, `${height}-${appearance}-long-prompts`);
    const longBody = await evaluate('statusPromptActions.prompts.find(prompt=>prompt.id==="extra-6").body');
    assert.ok(longBody.split('\n').length >= 9, 'The actual Prompt body is multiline long text');
    for (let i = 0; i < 12; i++) {
        const shown = await evaluate(`(()=>{const b=${face}.querySelector('.agent-status-prompts__button:last-child small').getBoundingClientRect(),s=(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body')).getBoundingClientRect();return b.bottom<=s.bottom+1&&b.bottom>s.top})()`);
        if (shown)
            break;
        const point = await evaluate(`(()=>{const r=(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body')).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 240 });
        await painted();
    }
    assert.ok(await evaluate(`(()=>{const b=${face}.querySelector('.agent-status-prompts__button:last-child small').getBoundingClientRect(),s=(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body')).getBoundingClientRect();return b.bottom<=s.bottom+1&&b.bottom>s.top})()`), 'The complete final body line is actually visible after native scrolling');
    assert.ok(await evaluate(`${face}.querySelector('.agent-status-prompts__button:last-child small').textContent.endsWith('最后一行：确认这些边界以后，继续推进下一步。')`));
    await frame(width, `${height}-${appearance}-long-body-end`);
    const preSend = await evaluate('statusPromptActions.facts()');
    await key('Enter', 'Enter', 13, '\r');
    await evaluate('statusPromptActions.drain()');
    await painted();
    const sent = await evaluate('statusPromptActions.facts()');
    assert.equal(sent.submissions.length, preSend.submissions.length + 1);
    assert.equal(sent.submissions.at(-1).text, longBody);
    assert.deepEqual(sent.drafts, preSend.drafts);
    assert.equal(await evaluate(`Boolean(${face})`), false, 'Accepted prompt returns to prior input face');
    await open();
    await evaluate(`${face}.querySelector('.agent-state-face__review').focus()`);
    await key('Enter', 'Enter', 13, '\r');
    await delay(220);
    assert.equal(await evaluate(`document.activeElement===${face}.querySelector('.agent-state-face__summary button')`), true, 'Keyboard Review transfers focus to Back');
    await waitFor('statusPromptActions.facts().gitCalls.length>' + gitBefore);
    await protectedFace();
    stable(baseline, await geometry());
    await frame(width, `${height}-${appearance}-review`);
    assert.equal(await evaluate('document.querySelectorAll(".session-result-review__popover").length'), 0, 'One shared face without nested Review popover');
    await click(`${face}.querySelector('.agent-state-face__summary button')`);
    await protectedFace();
    await escape();
    for (const kind of ['permission', 'question']) {
        result.stage = { width, height, appearance, state: 'running', pending: kind };
        await evaluate(`statusPromptActions.state('running');statusPromptActions.pending(${JSON.stringify(kind)})`);
        await painted();
        await settledGeometry();
        await open();
        const preQueue = await evaluate('statusPromptActions.facts()');
        const cardState = `(()=>{const card=${surface}.querySelector('.agent-interaction');if(!card)throw new Error('Actual pending interaction card is absent');return{id:card.dataset.requestId,text:card.textContent,buttons:Array.from(card.querySelectorAll('button')).map(button=>({text:button.textContent,disabled:button.disabled}))}})()`;
        const originalCard = await evaluate(cardState);
        assert.ok(originalCard.buttons.length > 0, 'The original typed request has actual answer controls');
        await protectedFace();
        assert.ok(await evaluate(`(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'): ${face}.querySelector('.agent-state-face__body')).clientHeight>16`), 'Short face has usable scroll body');
        assert.equal(await evaluate(`${buttons}[0].getAttribute('aria-label')`), 'Queue Explain running');
        await initialPromptAction();
        if (kind === 'question' && height === 430) {
            await frame(width, '430-dark-question-queue-short-face');
            await evaluate(`(()=>{const b=${buttons}[0],s=(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body'));b.focus();s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top})()`);
            await painted();
            assert.ok(await evaluate(`(()=>{const b=${buttons}[0],r=b.querySelector('.agent-status-prompts__label').getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`),'The actual Queue label is visible and clickable');
            await frame(width,'430-dark-question-queue-readable');
            await evaluate(`(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body')).scrollTop=0`);
            await painted();
            const shortBaseline = await protectedFace(), scrollSteps = [], visibleBodyLines = [];
            const bodyLines = 'Configured running prompt\n  exact spacing'.split('\n');
            const lineGeometry = line => evaluate(`(()=>{const b=${buttons}[0],small=b.querySelector('small'),text=small.firstChild,s=(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body')),line=${line},lines=small.textContent.split(${JSON.stringify('\n')}),start=lines.slice(0,line).reduce((n,value)=>n+value.length+1,0),range=document.createRange();range.setStart(text,start);range.setEnd(text,start+lines[line].length);const r=range.getBoundingClientRect(),clip=s.getBoundingClientRect();return{line:lines[line],scrollTop:s.scrollTop,top:r.top,bottom:r.bottom,clipTop:clip.top,clipBottom:clip.bottom,visible:r.top>=clip.top-1&&r.bottom<=clip.bottom+1&&b.contains(document.elementFromPoint(r.x+r.width/2,(r.top+r.bottom)/2))}})()`);
            for (let line = 0; line < bodyLines.length; line++) {
                let observation = await lineGeometry(line);
                for (let attempt = 0; (scrollSteps.length === 0 || !observation.visible) && attempt < 24; attempt++) {
                    const scroll = await evaluate(`(()=>{const s=(${face}.dataset.compact==='true'?${face}.querySelector('.agent-state-face'):${face}.querySelector('.agent-state-face__body')),r=s.getBoundingClientRect();return{scrollTop:s.scrollTop,x:r.x+r.width/2,y:r.y+r.height/2}})()`);
                    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scroll.x, y: scroll.y, deltaX: 0, deltaY: 8 });
                    await painted();
                    observation = await lineGeometry(line);
                    assert.ok(observation.scrollTop > scroll.scrollTop, 'Trusted native mouseWheel moves the compact body');
                    scrollSteps.push({ line, before: scroll.scrollTop, after: observation.scrollTop });
                }
                assert.equal(observation.line, bodyLines[line]);
                assert.equal(observation.visible, true, 'Each exact Queue body line is actually visible after native scrolling');
                const afterScroll = await protectedFace();
                stable(shortBaseline, afterScroll);
                assert.deepEqual(afterScroll.faceHeader, shortBaseline.faceHeader, 'Identity and close remain fixed during native body scrolling');
                assert.deepEqual(afterScroll.facts.pending, preQueue.pending, 'Native scrolling does not answer the typed Question');
                assert.equal(afterScroll.facts.responses.length, preQueue.responses.length);
                visibleBodyLines.push(observation);
                await frame(width, `430-dark-question-queue-body-line-${line + 1}`);
            }
            assert.ok(scrollSteps.length > 0, 'Compact Queue body uses actual native mouseWheel scrolling');
            (result.shortQueueScrolling ??= []).push({ width, height, scrollSteps, visibleBodyLines, header: shortBaseline.faceHeader, protectedGeometry: shortBaseline });
        }
        await click(`${buttons}[0]`);
        await evaluate('statusPromptActions.drain()');
        const queued = await evaluate('statusPromptActions.facts()');
        assert.equal(queued.submissions.length, preQueue.submissions.length);
        assert.equal(queued.responses.length, preQueue.responses.length);
        assert.deepEqual(queued.pending, preQueue.pending);
        assert.deepEqual(queued.drafts, preQueue.drafts);
        const queue = queued.queues[await evaluate('statusPromptActions.sessionId')];
        assert.equal(queue.length, 1);
        assert.equal(queue[0].text, 'Configured running prompt\n  exact spacing');
        assert.equal(queue[0].origin, 'manual');
        assert.equal(await evaluate(`Boolean(${face})`), false, 'Accepted Queue closes the temporary face');
        assert.deepEqual(await evaluate(cardState), originalCard, 'The original pending card and answer controls are intact after closing the face');
        if (kind === 'question' && height === 430)
            await frame(width, '430-dark-question-queue-closed-original-card');
        await evaluate(`statusPromptActions.answer(${JSON.stringify(kind)});`);
        await evaluate('statusPromptActions.drain()');
        assert.equal(await evaluate('statusPromptActions.facts().submissions.at(-1).text'), 'Configured running prompt\n  exact spacing');
    }
    await evaluate('statusPromptActions.state("running")');
    await painted();
    await open();
    await click(`${face}.querySelector('.agent-state-face__facts summary')`);
    await protectedFace();
    if (width === 640)
        await frame(width, 'running-state-details');
    await escape();
    await evaluate('statusPromptActions.state("working")');
    await painted();
    await settledGeometry();
    await open();
    await click(`${surface}.querySelector('.composer [role="textbox"]')`);
    assert.equal(await evaluate(`Boolean(${face})`), false);
    assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.composer [role="textbox"]')`), true, 'Outside click keeps new input focus');
    await evaluate(`${trigger}.focus()`);
    await painted();
    assert.equal(await evaluate(`Boolean(${face})`), true);
    await key(' ', 'Space', 32, ' ');
    await painted();
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width + 20, y: 10 });
    await delay(220);
    assert.equal(await evaluate(`Boolean(${face})`), true, 'Native Space pins preview against pointer leave');
    await escape();
    result.scenes.push({ width, height, appearance, draft, mode: before.mode, unconfigured, configured: before, keyboardLabels: labels, final: await geometry() });
}
async function settingsScene() {
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1300, deviceScaleFactor: 1, mobile: false });
    await evaluate('statusPromptActions.seed(false);statusPromptActions.appearance("light");statusPromptActions.settings()');
    await waitFor('Boolean(document.querySelector(".settings-pane-toolbar button"))');
    await click('document.querySelector(".settings-pane-toolbar button")');
    const card = 'document.querySelector(".prompt-settings-card")';
    await waitFor(`Boolean(${card})`);
    for (const [field, value] of [['Keyword', 'plainwords'], ['Name', '大白话说说做了什么'], ['Prompt', '大白话说明实际改动与验证，然后继续。']]) {
        const target = `Array.from(${card}.querySelectorAll('label')).find(label=>label.querySelector('span')?.textContent===${JSON.stringify(field)}).querySelector('input,textarea,[role="textbox"]')`;
        await click(target);
        await win.webContents.debugger.sendCommand('Input.insertText', { text: value });
    }
    for (const state of await evaluate('statusPromptActions.states'))
        await click(`${card}.querySelector('input[value=${JSON.stringify(state)}]')`);
    await frame(1000, 'settings-nine-states-and-usage');
    assert.equal(await evaluate(`${card}.querySelectorAll('input[type="checkbox"]:checked').length`), 9);
    assert.ok(await evaluate(`${card}.textContent.includes('pending permission or question requests queue it')`));
    await click('document.querySelector(".settings-pane-actions button")');
    await waitFor('statusPromptActions.facts().saved.length>0');
    const saved = await evaluate('statusPromptActions.facts().config.composerShortcuts');
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].states, await evaluate('statusPromptActions.states'));
    result.settings = { saved };
    await evaluate('statusPromptActions.closeSettings()');
}
app.whenReady().then(async () => {
    try {
        await fs.mkdir(evidence, { recursive: true });
        win = new BrowserWindow({ show: false, width: 1281, height: 850, webPreferences: { backgroundThrottling: false, sandbox: false } });
        await win.loadFile(html);
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
        await waitFor('Boolean(window.statusPromptActions)');
        const specs = proofMode==='queue-only' ? [[320,430,'dark','Multiline unsent draft\n'.repeat(7),'expanded']] : [[640, 740, 'dark', 'Near wrap threshold draft '.repeat(5)], [320, 740, 'light', 'Short unsent draft', 'current'], [320, 430, 'dark', 'Multiline unsent draft\n'.repeat(7), 'expanded'], [320, 640, 'light', 'Lower Region long draft\n'.repeat(4), 'expanded', true]];
        for(const spec of specs)
            await scene(...spec);
        assert.equal(result.scenes.length, proofMode==='queue-only'?1:4);
        if(proofMode!=='queue-only')await settingsScene();
        result.passed = true;
    }
    catch (error) {
        result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage };
        try {
            result.failureFacts = await geometry();
        }
        catch (e) {
            result.diagnosticError = e.message;
        }
    }
    finally {
        await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2));
        win?.destroy();
        app.exit(result.passed ? 0 : 1);
    }
});
