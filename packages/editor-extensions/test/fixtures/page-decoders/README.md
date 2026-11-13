# Page decoder fixtures

`original-pages.cbr` is an original RAR4-store archive of three original 16×16 color PNGs. `generate.mjs` reproducibly writes every byte. Its entry names intentionally contain spaces, a newline, brackets, stars, question marks and a backslash; machine PAX metadata must preserve them exactly. These generated fixtures use this repository's license.

`chinese-cookbook.djvu` is the five-page sample from `matyushkin/djvu-rs`, `tests/corpus/chinese_cookbook_sample.djvu` (upstream commit recorded in decoder qualification). It contains pages 1–3, 27 and 233 of *The Chinese Cook Book* (1917), Shiu Wong Chan, from [the Internet Archive scan](https://archive.org/details/chinesecookbook00chan). The pre-1931 US publication is public domain in the United States. Upstream corpus provenance is in `tests/corpus/README.md`; this is test data, never a runtime asset.
