---
tag: amux
form: frame
title: Shared content
description: File or Browser text shared in a plain-text frame. A Browser share carries the pasted text.
  A captured page observation is attached separately as Browser context.
examples:
- label: File context
  template: wire
  parameters:
    kind: File
    body: 'docs/example.md

      Original file context.'
- label: Browser context
  template: wire
  parameters:
    kind: Browser
    body: 'https://example.org/

      Original page context.'
---

# Shared content

## wire

~~~text
--- amux : {{kind}} ---
{{body}}
-----
~~~
