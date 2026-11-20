---
tag: amux
form: envelope
title: Declared context
description: Platform guidance kept separate from the original request. Text alone does not prove its source.
examples:
- label: Platform guidance
  template: wire
  parameters:
    content: Platform guidance.
  after: '


    Original request.'
---

# Declared context

## wire

~~~text
<amux>
{{content}}
</amux>
~~~
