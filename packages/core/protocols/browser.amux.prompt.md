---
tag: context
form: envelope
title: Browser context
description: A captured or declared Browser observation. Its original source and capture remain distinct from the
  message author.
examples:
- label: Declared page observation
  template: wire
  parameters:
    json: '{"kind":"browser","version":1,"capturedAt":0,"browser":{"hostId":"local","browserId":"BID","navigationId":null},"page":{"url":"https://example.org/","title":"Example
      page"}}'
  after: '


    Original request.'
---

# Browser context

## wire

~~~text
<amux>
<context kind="browser" version="1">
{{json}}
</context>
</amux>
~~~
