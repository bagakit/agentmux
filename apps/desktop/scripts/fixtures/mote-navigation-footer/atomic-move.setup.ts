// happy-dom has no atomic DOM move API. Native Chromium preservation is tested
// by the separate actual Renderer proof; this shim only lets mounted tests run.
if (typeof Element !== 'undefined' && !Element.prototype.moveBefore) {
  Element.prototype.moveBefore = function (node: Node, child: Node | null): void {
    this.insertBefore(node, child)
  }
}
