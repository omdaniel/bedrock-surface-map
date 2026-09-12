export interface Material {
  key: string;
  name: string;
  texture: string;
  tint: number;
  approximate: boolean;
  uv: number[];
  average: number[];
}
export interface RegionRef {
  rx: number;
  rz: number;
  url: string;
  sha256: string;
  bytes: number;
  columns: number;
  index?: ObjectRef;
  heights?: ObjectRef;
}
export interface ObjectRef {
  url: string;
  sha256: string;
  bytes: number;
}
export interface Manifest {
  format_version: number;
  name: string;
  bounds: number[];
  spawn: number[];
  source_sha256: string;
  catalog_version: string;
  materials: Material[];
  atlas: string;
  regions: RegionRef[];
  heights: string;
  heights_sha256: string;
  height_range: number[];
  approximations: string[];
}
export interface DecodeRequest {
  id: number;
  url: string;
  sha256: string;
  kind: "region" | "heights" | "chunk";
  rx?: number;
  rz?: number;
  materials?: number;
  columns?: number;
}
export interface DecodeReply {
  id: number;
  data?: Uint32Array | Float32Array;
  error?: string;
  decodeMs?: number;
}
