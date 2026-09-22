import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs';
await verifyRendererSourceMutations({ name: 'browser-overlay-scroll-mutations-'+Date.now(), tests: [
  "apps/desktop/test/native-overlay-regions.test.ts",
  "apps/desktop/test/native-overlay-chrome.test.tsx",
  "apps/desktop/test/native-overlay-pointer.test.tsx"
], sources: ["apps/desktop/src/renderer/src/lib/native-overlay-regions.ts"], mutations: [
  {
    "label": "unrelated-scroll-reverts-to-global-schedule",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "win.addEventListener('scroll', onScroll, true)",
    "after": "win.addEventListener('scroll', schedule, true)"
  },
  {
    "label": "unrelated-float-scroll-bypasses-relevance",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "if (watched.some(node => node.contains(target) || target.contains(node) || target.contains(topLayerSources.get(node) ?? null))) schedule()",
    "after": "schedule()"
  },
  {
    "label": "float-content-scroll-no-longer-refreshes",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "if (watched.some(node => node.contains(target) || target.contains(node) || target.contains(topLayerSources.get(node) ?? null))) schedule()",
    "after": "if (watched.some(node => target.contains(node) || target.contains(topLayerSources.get(node) ?? null))) schedule()"
  },
  {
    "label": "float-ancestor-scroll-no-longer-refreshes",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "if (watched.some(node => node.contains(target) || target.contains(node) || target.contains(topLayerSources.get(node) ?? null))) schedule()",
    "after": "if (watched.some(node => node.contains(target) || target.contains(topLayerSources.get(node) ?? null))) schedule()"
  },
  {
    "label": "document-scroll-no-longer-refreshes",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "if (target === event.currentTarget || target === body.ownerDocument) { schedule(); return }",
    "after": ""
  },
  {
    "label": "native-anchor-scroll-loses-actual-invoker",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "if (source instanceof Element) topLayerSources.set(target, source)",
    "after": "if (source instanceof Element) topLayerSources.delete(target)"
  },
  {
    "label": "closed-floating-content-observed-as-active",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "if (watched.length !== activeFloats.length || watched.some((node, index) => node !== activeFloats[index])) {\n      resize.disconnect()\n      for (const node of activeFloats) resize.observe(node)\n      watched = activeFloats\n    }",
    "after": "if (watched.length !== floats.length || watched.some((node, index) => node !== floats[index])) {\n      resize.disconnect()\n      for (const node of floats) resize.observe(node)\n      watched = floats\n    }"
  },
  {
    "label": "portal-position-style-no-longer-observed",
    "file": "apps/desktop/src/renderer/src/lib/native-overlay-regions.ts",
    "before": "for (const portal of portals()) observer.observe(portal, {\n      subtree: true, childList: true, characterData: true, attributes: true,\n      attributeFilter: ['data-state', 'style', 'class', 'aria-expanded', 'aria-disabled']\n    })",
    "after": "for (const portal of portals()) observer.observe(portal, {\n      subtree: true, childList: true, characterData: true, attributes: true,\n      attributeFilter: ['data-state', 'class', 'aria-expanded', 'aria-disabled']\n    })"
  }
] });
