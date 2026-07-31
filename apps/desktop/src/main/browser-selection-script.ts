// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import type { BrowserAnnotationMarker } from '../shared/contracts.js'

export const BROWSER_SELECTION_WORLD_ID = 1208

const SELECTION_STATE_KEY = '__agentMuxBrowserSelection'
const SELECTION_HOST_ATTRIBUTE = 'data-agentmux-browser-selection-overlay'
const ANNOTATION_STATE_KEY = '__agentMuxBrowserAnnotations'
const ANNOTATION_HOST_ATTRIBUTE = 'data-agentmux-browser-annotation-overlay'

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
    const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
    const elementFromEvent = (event) => {
      for (const item of event.composedPath()) {
        if (item instanceof Element && item !== host && !host.contains(item)) return item;
      }
      return event.target instanceof Element && event.target !== host ? event.target : null;
    };
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
