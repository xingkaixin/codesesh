/**
 * Offsets for a vertically stacked list whose items are measured as they render.
 *
 * A plain prefix array has to be rebuilt from the first changed item, so one
 * resize costs O(N) and a frame of V resizes costs O(V·N). A Fenwick tree keeps
 * every update and lookup at O(log N), which is what makes a 10k transcript
 * usable while heights are still settling.
 */
export class HeightIndex {
  /** Item extent including the gap that follows it; the last item has no gap. */
  private readonly sizes: Float64Array;
  private readonly measured: Uint8Array;
  /** Fenwick tree over `sizes`, 1-indexed. */
  private readonly tree: Float64Array;

  constructor(
    readonly count: number,
    estimate: number,
    private readonly gap: number,
  ) {
    this.sizes = new Float64Array(count);
    this.measured = new Uint8Array(count);
    this.tree = new Float64Array(count + 1);
    for (let index = 0; index < count; index += 1) {
      this.sizes[index] = this.extentOf(estimate, index);
    }
    this.buildTree();
  }

  /** Measured height of an item, or the estimate while it is unmeasured. */
  heightAt(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    return this.sizes[index]! - this.gapAfter(index);
  }

  /** Records a height. Returns false when it does not move the layout. */
  setHeight(index: number, height: number): boolean {
    if (index < 0 || index >= this.count) return false;
    if (!Number.isFinite(height) || height <= 0) return false;

    const rounded = Math.ceil(height);
    if (this.measured[index] === 1 && Math.abs(this.heightAt(index) - rounded) <= 1) return false;

    const next = this.extentOf(rounded, index);
    const delta = next - this.sizes[index]!;
    this.sizes[index] = next;
    this.measured[index] = 1;
    if (delta !== 0) this.addToTree(index, delta);
    return true;
  }

  /** Offset of an item's top edge. */
  startAt(index: number): number {
    return this.prefixSum(Math.max(0, Math.min(index, this.count)));
  }

  /** Offset of an item's bottom edge, excluding the gap after it. */
  endAt(index: number): number {
    return this.startAt(index) + this.heightAt(index);
  }

  get totalSize(): number {
    return this.prefixSum(this.count);
  }

  /** First item whose bottom edge is at or past `offset`. */
  firstEndAfter(offset: number): number {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.endAt(mid) < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** First item whose top edge is past `offset`. */
  firstStartAfter(offset: number): number {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.startAt(mid) <= offset) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private gapAfter(index: number): number {
    return index === this.count - 1 ? 0 : this.gap;
  }

  private extentOf(height: number, index: number): number {
    return height + this.gapAfter(index);
  }

  private buildTree(): void {
    for (let index = 0; index < this.count; index += 1) {
      const node = index + 1;
      this.tree[node]! += this.sizes[index]!;
      const parent = node + (node & -node);
      if (parent <= this.count) this.tree[parent]! += this.tree[node]!;
    }
  }

  private addToTree(index: number, delta: number): void {
    for (let node = index + 1; node <= this.count; node += node & -node) {
      this.tree[node]! += delta;
    }
  }

  /** Sum of the first `count` extents. */
  private prefixSum(count: number): number {
    let total = 0;
    for (let node = count; node > 0; node -= node & -node) {
      total += this.tree[node]!;
    }
    return total;
  }
}
