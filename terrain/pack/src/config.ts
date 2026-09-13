export function validTerrainUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match =
    /^http:\/\/[A-Za-z0-9.-]+:([0-9]{1,5})\/ingest\/v1\/terrain$/.exec(value);
  return !!match && Number(match[1]) >= 1 && Number(match[1]) <= 65535;
}
