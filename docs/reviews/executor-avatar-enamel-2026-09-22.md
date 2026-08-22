# Executor enamel correction — 2026-09-22

User-confirmed scope: “图标外描边，没有按照我要求的珐琅效果，看起来还是荧光”. This corrects the existing outline closure; no new product scope.

The installed 3380266d package matches the checkout. Source inspection found CSS drop-shadow layers outside the tint filter, including an extra 2px working/attention glow. Existing status tests required these shadows. The earlier filter also omitted an opaque backing and separation between the mark and rim.

Approved requirement: preserve the Provider and fixed badge as one mark; give their combined silhouette an opaque neutral backing, 1px clearance, and one opaque 1px outer rim. No blur or status-colored halo in any state or connecting surface. Use the existing status pip for status. The acceptance is the user's existing request and explicit correction, not a new approval assumption.

Verification: rendered production components and imported CSS, browser screenshots at normal and enlarged size with hollow icons and badge, mutation of backing/rim/shadow policy, and production callers outside the filter definition.
