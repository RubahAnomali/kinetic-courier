export interface HNode<C> {
  enter?(ctx: C, from: string | null): void;
  update?(ctx: C, dt: number): void;
  exit?(ctx: C, to: string): void;
}

export interface HLeaf<C, P extends string> extends HNode<C> {
  parent: P;
}

/**
 * Two-level hierarchical finite state machine.
 *
 * Parents (e.g. Grounded, Airborne) hold behaviour shared by their children (Idle, Run, ...).
 * Each tick runs `parent.update` then `leaf.update`. A transition between leaves of the same
 * parent only exits/enters the leaves; crossing parents also exits the old parent and enters
 * the new one. Transitions are validated against an adjacency table of leaf ids.
 */
export class HFSM<C, L extends string, P extends string> {
  leaf: L;
  parent: P;
  /** Seconds in the current leaf / parent. */
  leafTime = 0;
  parentTime = 0;
  rejected = 0;
  readonly history: string[] = [];

  constructor(
    private readonly ctx: C,
    private readonly parents: Record<P, HNode<C>>,
    private readonly leaves: Record<L, HLeaf<C, P>>,
    private readonly allowed: Record<L, readonly L[]>,
    private readonly initial: L,
  ) {
    this.leaf = initial;
    this.parent = leaves[initial].parent;
  }

  reset(): void {
    this.leaf = this.initial;
    this.parent = this.leaves[this.initial].parent;
    this.leafTime = this.parentTime = 0;
    this.rejected = 0;
    this.history.length = 0;
    this.parents[this.parent].enter?.(this.ctx, null);
    this.leaves[this.leaf].enter?.(this.ctx, null);
  }

  is(...ids: L[]): boolean {
    return ids.includes(this.leaf);
  }

  transition(to: L): boolean {
    if (to === this.leaf) return false;
    if (!this.allowed[this.leaf].includes(to)) {
      this.rejected++;
      return false;
    }
    const from = this.leaf;
    const fromParent = this.parent;
    const toParent = this.leaves[to].parent;
    this.leaves[from].exit?.(this.ctx, to);
    if (fromParent !== toParent) this.parents[fromParent].exit?.(this.ctx, toParent);
    this.leaf = to;
    this.parent = toParent;
    this.leafTime = 0;
    if (fromParent !== toParent) {
      this.parentTime = 0;
      this.parents[toParent].enter?.(this.ctx, from);
    }
    this.history.push(to);
    if (this.history.length > 8) this.history.shift();
    this.leaves[to].enter?.(this.ctx, from);
    return true;
  }

  update(dt: number): void {
    this.leafTime += dt;
    this.parentTime += dt;
    this.parents[this.parent].update?.(this.ctx, dt);
    this.leaves[this.leaf].update?.(this.ctx, dt);
  }
}
