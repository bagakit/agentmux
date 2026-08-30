// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import type { BrowserAnnotationMarker } from '../shared/contracts.js'

export const BROWSER_SELECTION_WORLD_ID = 1208

const SELECTION_STATE_KEY = '__agentMuxBrowserSelection'
const SELECTION_HOST_ATTRIBUTE = 'data-agentmux-browser-selection-overlay'
const ANNOTATION_STATE_KEY = '__agentMuxBrowserAnnotations'
const ANNOTATION_HOST_ATTRIBUTE = 'data-agentmux-browser-annotation-overlay'
const DRIVE_STATE_KEY = '__agentMuxBrowserDriveBadge'
export const BROWSER_DRIVE_BADGE_ATTRIBUTE = 'data-agentmux-browser-drive-badge'

/**
 * 元素结构化提取的**唯一一份**页面侧实现，注入给两条路共用。
 *
 * 两条路是：人点选（{@link buildBrowserElementSelectionScript}，只认 `event.isTrusted` 的真实事件）
 * 与 Agent 按 ref 取（{@link buildBrowserElementContextScript}，不经指针事件）。它们的**信任边界
 * 完全不同**，但「一个元素读出来长什么样」必须是同一个答案——否则 Agent 读到的字段与人选出来的
 * 字段会各自漂移，而脱敏层 `sanitizeBrowserElementSelection` 按一组固定键校验，漂移的那一侧会
 * 在运行时才炸，且炸的地方离改动很远。
 *
 * 写成一个字符串常量而不是两份拷贝：拷贝今天相等，下一次给 `extract` 加字段时只会加到一处。
 */
const ELEMENT_EXTRACT_SOURCE = `
  const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const stableSelector = (element) => {
    const parts = [];
    let current = element;
    while (current && current instanceof Element && current !== document.documentElement && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += '#' + CSS.escape(current.id);
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return bounded(parts.join(' > '), 1200);
  };
  const fixed = (element) => {
    let current = element;
    while (current && current instanceof Element) {
      const position = getComputedStyle(current).position;
      if (position === 'fixed' || position === 'sticky') return true;
      current = current.parentElement;
    }
    return false;
  };
  const extract = (element) => {
    const rect = element.getBoundingClientRect();
    const attributes = {};
    for (const attribute of Array.from(element.attributes).slice(0, 64)) {
      attributes[bounded(attribute.name, 100)] = bounded(attribute.value, 2000);
    }
    const nearbyText = [];
    const siblings = [element.previousElementSibling, element.nextElementSibling];
    for (const sibling of siblings) {
      if (!sibling || nearbyText.length >= 6) continue;
      const value = bounded(sibling.innerText || sibling.textContent || '', 500);
      if (value.trim()) nearbyText.push(value);
    }
    const text = bounded(element.innerText || element.textContent || '', 4000);
    return {
      pageTitle: bounded(document.title, 1000),
      pageUrl: bounded(location.href, 4000),
      tagName: bounded(element.tagName.toLowerCase(), 100),
      role: bounded(element.getAttribute('role') || element.tagName.toLowerCase(), 200),
      accessibleName: bounded(
        element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || text,
        1000
      ),
      selector: stableSelector(element),
      text,
      nearbyText,
      attributes,
      html: bounded(element.outerHTML, 16384),
      rectViewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      rectPage: {
        x: rect.x + (Number.isFinite(window.scrollX) ? window.scrollX : 0),
        y: rect.y + (Number.isFinite(window.scrollY) ? window.scrollY : 0),
        width: rect.width,
        height: rect.height
      },
      isFixed: fixed(element)
    };
  };
`

export function buildBrowserElementSelectionScript(revision: number): string {
  return `(() => {
  'use strict';
  const stateKey = ${JSON.stringify(SELECTION_STATE_KEY)};
  const hostAttribute = ${JSON.stringify(SELECTION_HOST_ATTRIBUTE)};
  const revision = ${revision};
  const previous = globalThis[stateKey];
  if (previous && Number.isInteger(previous.revision) && previous.revision >= revision) return null;
  if (previous && typeof previous.cancel === 'function') previous.cancel();

  return new Promise((resolve, reject) => {
    const root = document.body || document.documentElement;
    if (!root) { resolve(null); return; }
    const host = document.createElement('div');
    host.setAttribute(hostAttribute, '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style paint;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = '.box{position:fixed;display:none;box-sizing:border-box;border:2px solid #65d88c;background:rgba(101,216,140,.12);box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none}.hint{position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:7px 10px;border:1px solid rgba(255,255,255,.2);border-radius:8px;color:#f5f7f5;background:rgba(13,17,23,.94);font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:none}';
    const box = document.createElement('div');
    box.className = 'box';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Select an element · Esc to cancel';
    shadow.append(style, box, hint);
    root.appendChild(host);

    let target = null;
    let settled = false;
    ${ELEMENT_EXTRACT_SOURCE}
    const elementFromEvent = (event) => {
      for (const item of event.composedPath()) {
        if (item instanceof Element && item !== host && !host.contains(item)) return item;
      }
      return event.target instanceof Element && event.target !== host ? event.target : null;
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      host.remove();
      if (globalThis[stateKey] === state) delete globalThis[stateKey];
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onPointerMove = (event) => {
      if (!event.isTrusted) return;
      target = elementFromEvent(event);
      if (!target) { box.style.display = 'none'; return; }
      const rect = target.getBoundingClientRect();
      box.style.display = 'block';
      box.style.transform = 'translate3d(' + rect.x + 'px,' + rect.y + 'px,0)';
      box.style.width = Math.max(0, rect.width) + 'px';
      box.style.height = Math.max(0, rect.height) + 'px';
    };
    const onClick = (event) => {
      if (!event.isTrusted) return;
      const selected = target || elementFromEvent(event);
      if (!selected) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      try {
        settle(extract(selected));
      } catch (error) {
        fail(error);
      }
    };
    const onKeyDown = (event) => {
      if (!event.isTrusted) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      settle(null);
    };
    const state = { revision, cancel: () => settle(null) };
    globalThis[stateKey] = state;
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  });
})()`
}

export function buildCancelBrowserElementSelectionScript(revision: number): string {
  return `(() => {
  const stateKey = ${JSON.stringify(SELECTION_STATE_KEY)};
  const revision = ${revision};
  const previous = globalThis[stateKey];
  if (previous && Number.isInteger(previous.revision) && previous.revision > revision) return true;
  if (previous && typeof previous.cancel === 'function') previous.cancel();
  const barrier = {
    revision,
    cancel: () => { if (globalThis[stateKey] === barrier) delete globalThis[stateKey]; }
  };
  globalThis[stateKey] = barrier;
  return true;
})()`
}

export function buildBrowserAnnotationMarkerScript(
  markers: readonly BrowserAnnotationMarker[],
  revision: number
): string {
  return `(() => {
  'use strict';
  const stateKey = ${JSON.stringify(ANNOTATION_STATE_KEY)};
  const hostAttribute = ${JSON.stringify(ANNOTATION_HOST_ATTRIBUTE)};
  const revision = ${revision};
  const markers = ${JSON.stringify(markers)};
  const previous = globalThis[stateKey];
  if (previous && Number.isInteger(previous.revision) && previous.revision >= revision) return false;
  if (previous && typeof previous.cleanup === 'function') previous.cleanup();
  if (markers.length === 0) {
    const emptyState = {
      revision,
      cleanup: () => { if (globalThis[stateKey] === emptyState) delete globalThis[stateKey]; }
    };
    globalThis[stateKey] = emptyState;
    return true;
  }
  const root = document.body || document.documentElement;
  if (!root) return false;
  const host = document.createElement('div');
  host.setAttribute(hostAttribute, '');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style paint;overflow:hidden;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = '.marker{position:absolute;left:0;top:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:1px solid rgba(255,255,255,.95);border-radius:999px;color:#0c130e;background:#78dda0;box-shadow:0 8px 22px rgba(0,0,0,.35);font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;user-select:none;will-change:transform}';
  shadow.appendChild(style);
  const elements = markers.map((marker) => {
    const element = document.createElement('span');
    element.className = 'marker';
    element.textContent = String(marker.index + 1);
    shadow.appendChild(element);
    return element;
  });
  root.appendChild(host);
  let frame = 0;
  const update = () => {
    frame = 0;
    const scrollX = Number.isFinite(window.scrollX) ? window.scrollX : 0;
    const scrollY = Number.isFinite(window.scrollY) ? window.scrollY : 0;
    markers.forEach((marker, index) => {
      const source = marker.isFixed ? marker.rectViewport : marker.rectPage;
      const x = marker.isFixed ? source.x : source.x - scrollX;
      const y = marker.isFixed ? source.y : source.y - scrollY;
      const visible = x + source.width >= 0 && y + source.height >= 0 && x <= innerWidth && y <= innerHeight;
      const element = elements[index];
      if (!element) return;
      element.style.display = visible ? 'flex' : 'none';
      if (visible) element.style.transform = 'translate3d(' + (x + source.width / 2 - 12) + 'px,' + (y + source.height - 12) + 'px,0)';
    });
  };
  const requestUpdate = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const cleanup = () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('scroll', requestUpdate, true);
    document.removeEventListener('scroll', requestUpdate, true);
    window.removeEventListener('resize', requestUpdate, true);
    host.remove();
  };
  globalThis[stateKey] = { revision, cleanup };
  window.addEventListener('scroll', requestUpdate, true);
  document.addEventListener('scroll', requestUpdate, true);
  window.addEventListener('resize', requestUpdate, true);
  requestUpdate();
  return true;
})()`
}

export function buildCancelBrowserAnnotationMarkerScript(revision: number): string {
  return `(() => {
  const stateKey = ${JSON.stringify(ANNOTATION_STATE_KEY)};
  const state = globalThis[stateKey];
  if (state && state.revision === ${revision} && typeof state.cleanup === 'function') state.cleanup();
  return true;
})()`
}

/**
 * 「这个 Browser 正在被 Agent 驱动」的角标。
 *
 * 注在**页面里**而不是渲染进程的应用 chrome 上，原因是覆盖面：应用侧只能给当下可见的那一格加
 * 提示，而页面内角标在后台的、非焦点的、甚至没显示的 Browser 上照样在——「人切回去一看，它正
 * 在被驱动」恰恰是这个提示要覆盖的场景。代价是导航会把它冲掉，所以 `did-finish-load` 要重注。
 *
 * **宿主必须 `pointer-events:none`**，这一条是承重的，不是审美：角标盖在页面上方，能吃点击的话
 * 它会吃掉人伸手的第一次点击——而那一次点击**正是**接管信号。那样这个提示就在阻止它自己所提示
 * 的那件事被察觉到。用 closed shadow 而不是裸 DOM，是为了不让页面的 CSS 把它改样子或藏起来
 * （与上面两个 overlay 同一套做法）。
 */
export function buildBrowserDriveBadgeScript(): string {
  return `(() => {
  'use strict';
  const stateKey = ${JSON.stringify(DRIVE_STATE_KEY)};
  const hostAttribute = ${JSON.stringify(BROWSER_DRIVE_BADGE_ATTRIBUTE)};
  if (globalThis[stateKey]) return true;
  const root = document.body || document.documentElement;
  if (!root) return false;
  const host = document.createElement('div');
  host.setAttribute(hostAttribute, '');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:auto 12px 12px auto;z-index:2147483645;pointer-events:none;contain:layout style paint;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = '.badge{display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid rgba(255,255,255,.2);border-radius:999px;color:#f5f7f5;background:rgba(13,17,23,.92);font:600 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 22px rgba(0,0,0,.35);pointer-events:none;user-select:none}.dot{width:7px;height:7px;border-radius:999px;background:#78dda0}';
  const badge = document.createElement('div');
  badge.className = 'badge';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.textContent = 'Agent is operating · interact here to take back control';
  badge.append(dot, label);
  shadow.append(style, badge);
  root.appendChild(host);
  globalThis[stateKey] = { cleanup: () => { host.remove(); delete globalThis[stateKey]; } };
  return true;
})()`
}

export function buildCancelBrowserDriveBadgeScript(): string {
  return `(() => {
  const state = globalThis[${JSON.stringify(DRIVE_STATE_KEY)}];
  if (state && typeof state.cleanup === 'function') state.cleanup();
  return true;
})()`
}

/**
 * Agent 发起的元素上下文：**不经指针事件**，直接对一个已经解出来的元素跑 `extract`。
 *
 * ## 为什么这是一条独立的入口，而不是"让 Agent 调人工选择"
 *
 * 人工选择那条路上的三个 `event.isTrusted` 门禁是**真实的信任边界**：没有它，页面里的脚本
 * 自己 `dispatchEvent(new MouseEvent('click'))` 就能让我们把一个它挑好的元素当成"人选的"
 * 交出去。所以这条新入口的第一条规矩是**不碰那些门禁**——它们继续只认真实事件，Agent 走
 * 另一条完全不同的路：由主进程用一个 CDP 句柄（`Runtime.callFunctionOn` 的 `objectId`）
 * 指定元素，页面脚本从来没有机会选目标。
 *
 * 换句话说两条路的授权判据不同：人那条是"这个事件是不是真的人干的"，Agent 这条是
 * "这次调用是不是从一个正在跑的 Browser 操作里来的"。后者由派发层保证——这段代码只可能
 * 被 `createBrowserPageDispatch` 的 `elementContext` 分支调用，而那个分支只在
 * `runBrowserScript` 的子进程往回喊 `page-call` 时才到得了。
 *
 * ## 为什么它是 `observe`
 *
 * 它只读元素，不点、不填、不滚（连 `scrollIntoView` 都不做——那会改变页面的滚动位置，
 * 而人此刻可能正在看别处）。所以人工接管之后它照常放行：程序被打断时最该做的就是先看一眼
 * 现在是什么样。
 *
 * ## 返回值与人工选择**逐字段相同**
 *
 * 共用 {@link ELEMENT_EXTRACT_SOURCE}，所以脱敏层 `sanitizeBrowserElementSelection`
 * （它按一组固定键 `assertExactKeys`）对两条路都成立。这不是巧合而是要求：两份拷贝今天相等，
 * 下一次加字段时只会加到一处，而漂移的那一侧会在运行时才炸。
 */
export function buildBrowserElementContextDeclaration(): string {
  return `function () {
  'use strict';
  ${ELEMENT_EXTRACT_SOURCE}
  if (!(this instanceof Element)) return null;
  return extract(this);
}`
}
