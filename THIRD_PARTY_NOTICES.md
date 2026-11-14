# Third-party notices

## Orca Browser screenshot markup and element selection

Parts of the Browser screenshot drawing model, Canvas renderer, editor interaction, PNG composition, element-selection overlay, and annotation marker overlay are adapted from Orca commit `4fd93ead1999dc34e13ac5915693ad8467a39a6e`.

## Orca native macOS layer

The macOS source in `packages/native-desktop/macos` is adapted from Orca commit `a886dcd1fe946758158a954abb819a99fcc1c23e`, `native/computer-use-macos`. AgentMux changes include precise OS targets, screen selection, clipboard, authenticated transport and operation receipts. The original MIT license below also applies; the source and bundled Native App retain `LICENSE.orca`, `UPSTREAM.md` and package notices.

## Orca browser page snapshot engine

The accessibility-tree walk and cursor-interactive element promotion in `apps/desktop/src/main/browser-page-snapshot.ts` are adapted from the same project. The error model is not: where the original skips an unreachable cross-origin iframe silently, this implementation surfaces it as a named failure.

The following MIT license applies to all three Orca-derived parts above.

MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Shotback screenshot crop and pixelation reference

The crop composition and pixelation algorithms in `apps/desktop/src/renderer/src/components/image-annotation/compose.ts` and `apps/desktop/src/renderer/src/components/image-annotation/drawing-renderer.ts` are independently implemented with reference to Shotback commit `df21fa87ced894847c0d5e0d8abc70c391a6ae40`, particularly `src/lib/crop.ts` and `src/lib/annotate.ts`. AgentMux keeps its existing screenshot document, rendering pipeline, and clipboard lifecycle; no Shotback package or complete editor is included.

Reference: https://github.com/DCCA/shotback/tree/df21fa87ced894847c0d5e0d8abc70c391a6ae40

MIT License

Copyright (c) 2026 Shotback contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## fs-native-extensions

fs-native-extensions 1.5.1, Copyright 2023 Holepunch Inc., is a runtime dependency licensed under Apache-2.0. The license text is reproduced in [Core notices](packages/core/THIRD_PARTY_NOTICES.md) and included in the dependency package. Its require-addon loader and transitive loader dependencies retain their own licenses in the distributed packages.

## Paseo Relay

The source in `packages/relay` includes code from Paseo, copyright (c) 2025-present Mohamed Boudra, licensed under Apache License 2.0. The pinned upstream revision and adaptations are recorded in `packages/relay/NOTICE`; the full license is retained in `packages/relay/LICENSE`.

## resvg-js

`@resvg/resvg-js` 2.6.2 and its platform native package render the existing Agent and Mote artwork in the independent Host. They are distributed unmodified under MPL-2.0. The full license is retained in the distributed `@resvg/resvg-js/LICENSE`; source is available from the [upstream resvg-js repository](https://github.com/yisibl/resvg-js).

## draw.io viewer

The desktop app bundles the official draw.io 32.4.1 viewer distribution, unmodified, to preview `.drawio` files. The viewer is licensed under Apache License 2.0; its full text is retained in [`packages/editor-extensions/vendor/drawio/v32.4.1/LICENSE`](packages/editor-extensions/vendor/drawio/v32.4.1/LICENSE). Its icon sets and stencil libraries carry additional upstream use restrictions, retained in the `img`, `shapes` and `stencils` LICENSE files of the same directory.


## Editor reading engines

PDF.js 6.3.289 and djvu-rs 0.43.0 retain their full licenses beside their local renderer assets under `licenses/editor-extensions/`. The DjVu distribution also contains its complete Rust dependency `THIRD_PARTY_NOTICES`. The extension build plugin copies these original files, together with the following parser licenses. Drawio viewer assets retain the license in their vendored asset directory.

### Foliate parsers

Selected MIT parsers from commit 78914aef4466eb960965702401634c2cb348e9b1, adapted in packages/editor-extensions/src/books/vendor/foliate.

MIT License

Copyright (c) 2022 John Factotum

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


### zip.js 2.24.0

Random-access EPUB and CBZ archive entries. Source: https://github.com/gildas-lormeau/zip.js

BSD 3-Clause License

Copyright (c) 2023, Gildas Lormeau

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


### fflate 0.8.3

KF8 resource decompression. Source: https://github.com/101arrowz/fflate

MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### tar-stream 3.2.2

Parses machine PAX output from the local archive adapter. Source: https://github.com/mafintosh/tar-stream

The MIT License (MIT)

Copyright (c) 2014 Mathias Buus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## gifenc

GIF encoding uses [gifenc](https://github.com/mattdesl/gifenc) under the following license.

The MIT License (MIT)
Copyright (c) 2017 Matt DesLauriers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.

