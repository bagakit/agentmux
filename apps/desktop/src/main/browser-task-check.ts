import type { BrowserTaskStep } from '../shared/browser-task-assets.js'

/** A wait polls with doubling pauses, so a 25 s wait costs at most about a dozen polls. */
const WAIT_FIRST_POLL_MILLIS = 250
const WAIT_MAX_POLL_MILLIS = 2_000

/**
 * Fixed read-only Browser page calls for wait and assert steps (pageInfo, snapshot, wait).
 * Nothing here changes the page. A fact that does not hold, or an absence that cannot be
 * proven from one complete observation of the same document, throws an error naming the
 * step, so the call ends as script-failed and the runner applies the step's own handling.
 */
export function compileBrowserTaskCheck(step: BrowserTaskStep): string {
  if (!step.reviewed) throw new Error('Review the demonstrated step before executing it.')
  const fact = step.kind === 'wait' ? step.wait : step.kind === 'assert' ? step.assert : undefined
  if (!fact) throw new Error('Only wait and assert steps compile to page checks.')
  if (fact.kind !== 'url-is' && !step.url) throw new Error('The reviewed page identity is unavailable. Locate the intended page before executing this step.')
  const name = `Task step ${JSON.stringify(step.label || step.id)}`
  // Same completeness rule as a condition: absence needs every node of the page document.
  const common = `const expectedPage = ${JSON.stringify(step.url)};
    const identity = (value) => { try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return null; } };
    const complete = (result) => {
      const observed = result && result.observation;
      return !!observed && observed.scope.kind === 'page' && observed.scope.document === null && !observed.truncated &&
        Number.isSafeInteger(observed.fullObserved) && observed.fullObserved >= 1 &&
        Array.isArray(observed.omittedFrames) && !observed.omittedFrames.length &&
        Array.isArray(result.missingFrames) && !result.missingFrames.length && Array.isArray(result.nodes) && result.nodes.length > 0 &&
        observed.returned === result.nodes.length && observed.scoped === observed.fullObserved &&
        observed.matched === observed.scoped && observed.returned === observed.matched;
    };
    // A failed page read stays a failed call of this step, never a silent poll: the journal keeps
    // it as a failed step, so a script that swallowed it would report a mixed completed operation.
    const observe = async (page) => {
      let result;
      try { result = await snapshot({ maxNodes: 1000 }); }
      catch (error) { throw new Error(${JSON.stringify(`${name} could not observe the page: `)} + (error && error.message ? error.message : String(error))); }
      // Only an observation of the document whose URL was just read can prove anything.
      const same = !!result && !!page && typeof page.navigationId === 'string' && result.navigationId === page.navigationId;
      return { nodes: same && Array.isArray(result.nodes) ? result.nodes : [], complete: same && complete(result) };
    };
    const matches = (node, target) => node.role === target.role && node.name === target.name;`
  if (step.kind === 'wait') {
    if (!step.timeoutMs) throw new Error('A wait step declares its condition and timeout.')
    return `${common}
    const condition = ${JSON.stringify(fact)};
    const timeoutMs = ${step.timeoutMs};
    const deadline = Date.now() + timeoutMs;
    let pause = ${WAIT_FIRST_POLL_MILLIS};
    let last = 'nothing was observed';
    for (;;) {
      const page = await pageInfo();
      const actual = page ? identity(page.url) : null;
      if (condition.kind === 'url-is') {
        if (actual === condition.url) break;
        last = 'the page URL is not the expected URL';
      } else if (actual !== expectedPage) {
        last = 'the page is not the reviewed page';
      } else {
        const seen = await observe(page);
        if (seen.nodes.some(node => matches(node, condition.target))) break;
        last = seen.complete ? 'the element is absent' : 'the page observation is incomplete';
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(${JSON.stringify(`${name} wait did not hold within `)} + timeoutMs + ' ms: ' + last + '.');
      await wait(Math.min(pause, left));
      pause = Math.min(pause * 2, ${WAIT_MAX_POLL_MILLIS});
    }
    return { taskStepId: ${JSON.stringify(step.id)} }`
  }
  return `${common}
    const assertion = ${JSON.stringify(fact)};
    const failed = (reason) => new Error(${JSON.stringify(`${name} assert failed: `)} + reason + '.');
    const unknown = () => new Error(${JSON.stringify(`${name} assert could not be proven: the page observation is incomplete, so its fact is unknown.`)});
    const page = await pageInfo();
    const actual = page ? identity(page.url) : null;
    if (assertion.kind === 'url-is') {
      if (actual !== assertion.url) throw failed('the page URL is not ' + assertion.url);
    } else {
      if (actual !== expectedPage) throw failed('the page is not the reviewed page');
      const seen = await observe(page);
      const found = assertion.kind === 'text-present'
        ? seen.nodes.some(node => typeof node.name === 'string' && node.name.includes(assertion.text))
        : seen.nodes.some(node => matches(node, assertion.target));
      // A match in the same document proves presence; absence needs its complete observation.
      if (assertion.kind === 'element-absent') {
        if (found) throw failed('the element is present');
        if (!seen.complete) throw unknown();
      } else if (!found) {
        if (!seen.complete) throw unknown();
        throw failed(assertion.kind === 'text-present' ? 'the text is absent' : 'the element is absent');
      }
    }
    return { taskStepId: ${JSON.stringify(step.id)} }`
}
