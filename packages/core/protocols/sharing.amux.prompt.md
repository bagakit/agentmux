---
tag: amux
form: frame
title: Shared content
description: The original File or Browser content in a plain-text frame, without interpreting its contents as a new
  protocol.
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
