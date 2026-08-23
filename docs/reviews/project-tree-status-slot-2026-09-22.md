# Project tree 状态槽统一评审

日期：2026-09-22

## 用户问题

Project tree 的 idle、running/working、error 目前使用不同的文字、点和徽章，扫描成本高，行尾列也不齐。它们都表达同一类事实：这个 Project 下对应状态的 Session 数量。

## Approved closure

- 每个 Project 行的状态事实统一占一个紧凑的尾部状态槽，结构都是小图标 + 数字。
- idle、running/working、error 只改变 glyph、语义色和 tooltip/读屏名称；不改变槽位、字号、基线和数字列宽。
- 数量为零时不渲染该槽，避免整棵树出现无意义的占位。
- 计数仍复用现有 Session/`sessionBoardColumn` 投影，不复制 Runtime 状态；树结构、选中与导航行为保持不变。

状态：approved。
