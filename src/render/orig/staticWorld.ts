/**
 * src/render/orig/staticWorld.ts — world matrices of a component's never-moving meshes (track patches, object
 * batches). three recomputes every descendant's matrixWorld each frame (the scene root forces it); for nodes whose
 * local matrix is fixed that is a wasted multiply per node. Once the root's world matrix has settled the nodes'
 * `matrixWorldAutoUpdate` is switched off, so their matrixWorld stays as the last forced pass left it (the same
 * value the per-frame multiply would produce). A change of the root's world matrix thaws them again.
 */
import * as THREE from 'three';

/** update() calls before the freeze: the scene has rendered (and so updated the root's world matrix) in between. */
const SETTLE = 2;

export class StaticWorld {
  private readonly seen = new THREE.Matrix4();
  private frozen = false;
  private calls = 0;

  private readonly root: THREE.Object3D;

  constructor(root: THREE.Object3D) {
    this.root = root;
  }

  /** Once per frame from the component's update(); `nodes` are the root's fixed-matrix descendants. */
  update(nodes: readonly THREE.Object3D[]): void {
    if (this.frozen) {
      if (this.seen.equals(this.root.matrixWorld)) return;
      // the root moved (nothing does today): back to the per-frame multiply, current at once
      for (const n of nodes) n.matrixWorldAutoUpdate = true;
      this.root.updateMatrixWorld(true);
      this.frozen = false;
      this.calls = 0;
      return;
    }
    if (++this.calls < SETTLE) return;
    // a forced pass brings every node up to the current root; they keep that value from here on
    this.root.updateMatrixWorld(true);
    this.seen.copy(this.root.matrixWorld);
    for (const n of nodes) n.matrixWorldAutoUpdate = false;
    this.frozen = true;
  }
}
