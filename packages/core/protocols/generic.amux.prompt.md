---
tag: amux:NAME
form: extension
title: Other amux declarations
description: A complete unregistered type uses a generic reading card. Its body remains opaque; no business support
  or authority is implied.
examples:
- label: Illustrative unregistered declaration
  template: wire
  parameters:
    name: example
    attributes: ' topic="Example"'
    body: Original opaque content.
---

# Other amux declarations

## wire

~~~text
<amux:{{name}}{{attributes}}>{{body}}</amux:{{name}}>
~~~
