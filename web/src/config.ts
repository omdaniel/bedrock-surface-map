export interface ViewerConfiguration {
  map?: string;
  players?: unknown;
  terrain?: { url: string; world_id: string; generation: string };
  demo?: { scenario: string; poster: string };
}
export function appUrl(path: string) {
  return new URL(path, new URL(import.meta.env.BASE_URL, location.origin));
}
export async function loadConfiguration(): Promise<ViewerConfiguration> {
  const response = await fetch(appUrl("viewer-config.json"), {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    if (response.status === 404) return {};
    throw Error("Viewer configuration unavailable");
  }
  return response.json();
}
