import { heightWindowBytes } from "./cache-budget.ts";
import type { DecodeRequest, Manifest } from "./types";
import type { View } from "./terrain";

export function expandView(view: View, padding: number): View {
  return {
    left: view.left - padding,
    right: view.right + padding,
    top: view.top - padding,
    bottom: view.bottom + padding,
  };
}
export function intersects(rx: number, rz: number, view: View) {
  return (
    rx * 256 < view.right &&
    (rx + 1) * 256 > view.left &&
    rz * 256 < view.bottom &&
    (rz + 1) * 256 > view.top
  );
}
export function heightBounds(
  manifest: Pick<Manifest, "bounds" | "height_range">,
  view: View,
  elevation: number,
) {
  const margin =
    Math.ceil(
      (manifest.height_range[1] - manifest.height_range[0]) /
        16 /
        Math.tan((elevation * Math.PI) / 180),
    ) + 2;
  const v = expandView(view, margin),
    b = manifest.bounds;
  const result = [
    Math.max(b[0], Math.floor(v.left / 256) * 256),
    Math.max(b[1], Math.floor(v.top / 256) * 256),
    Math.min(b[2], Math.ceil(v.right / 256) * 256),
    Math.min(b[3], Math.ceil(v.bottom / 256) * 256),
  ];
  if (result[2] <= result[0] || result[3] <= result[1]) {
    const x = Math.floor((view.left + view.right) / 512) * 256;
    const z = Math.floor((view.top + view.bottom) / 512) * 256;
    return [x, z, x + 256, z + 256];
  }
  return result;
}
export function containsBounds(outer: number[], inner: number[]) {
  return (
    outer.length === 4 &&
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3]
  );
}

/** Offline snapshots derive only the resident height window from local regions. */
export class SnapshotHeights {
  window: number[] = [];
  stride = 1;
  pages = new Map<string, Int16Array>();
  readonly manifest: Manifest;
  readonly asset: (path: string) => string;
  readonly decode: (
    r: Omit<DecodeRequest, "id">,
  ) => Promise<Uint32Array | Float32Array>;
  constructor(
    manifest: Manifest,
    asset: (path: string) => string,
    decode: (
      r: Omit<DecodeRequest, "id">,
    ) => Promise<Uint32Array | Float32Array>,
  ) {
    this.manifest = manifest;
    this.asset = asset;
    this.decode = decode;
  }
  get memoryBytes() {
    return [...this.pages.values()].reduce((n, p) => n + p.byteLength, 0);
  }
  needed(view: View, elevation: number) {
    return heightBounds(this.manifest, view, elevation);
  }
  covers(view: View, elevation: number) {
    return containsBounds(this.window, this.needed(view, elevation));
  }
  async prepare(view: View, elevation: number, stride: number, budget: number) {
    const window = this.needed(view, elevation);
    if (heightWindowBytes(window, stride) > budget)
      throw Error("Height window exceeds reserved memory");
    const side = 256 / stride,
      width = (window[2] - window[0]) / stride;
    const pages = new Map<string, Int16Array>();
    const heights = new Float32Array(
      (width * (window[3] - window[1])) / stride,
    ).fill(-1e6);
    for (const r of this.manifest.regions) {
      if (
        r.rx * 256 < window[0] ||
        r.rz * 256 < window[1] ||
        r.rx * 256 >= window[2] ||
        r.rz * 256 >= window[3]
      )
        continue;
      const id = `${r.rx},${r.rz}`;
      let page = this.stride === stride ? this.pages.get(id) : undefined;
      if (!page) {
        const values = (await this.decode({
          kind: "region-heights",
          url: this.asset(r.url),
          sha256: r.sha256,
          rx: r.rx,
          rz: r.rz,
          materials: this.manifest.materials.length,
          stride,
        })) as Float32Array;
        if (values.length !== side * side)
          throw Error("Invalid local height page");
        page = Int16Array.from(values, (v) =>
          v < -900000 ? -32768 : Math.round(v * 16),
        );
      }
      pages.set(id, page);
      const ox = (r.rx * 256 - window[0]) / stride,
        oz = (r.rz * 256 - window[1]) / stride;
      for (let z = 0; z < side; z++)
        for (let x = 0; x < side; x++) {
          const h = page[z * side + x];
          heights[(oz + z) * width + ox + x] = h === -32768 ? -1e6 : h / 16;
        }
    }
    return { window, stride, pages, heights };
  }
  commit(update: Awaited<ReturnType<SnapshotHeights["prepare"]>>) {
    this.window = update.window;
    this.stride = update.stride;
    this.pages = update.pages;
  }
}
