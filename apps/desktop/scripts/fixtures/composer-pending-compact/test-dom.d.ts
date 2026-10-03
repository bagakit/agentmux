export {}
declare global {
  interface Element { moveBefore(node: Node, child: Node | null): void }
}
