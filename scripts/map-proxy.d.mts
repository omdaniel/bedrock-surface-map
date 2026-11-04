import type { IncomingMessage, ServerResponse } from "node:http";
export function mapProxy(options: {
  origin?: string;
  world?: string;
  fingerprint?: string;
  terrainOrigin?: string;
  terrainLod?: boolean;
  generation?: string;
  map?: string;
}):
  | null
  | ((
      req: IncomingMessage,
      res: ServerResponse,
      next: () => void,
    ) => Promise<void>);
