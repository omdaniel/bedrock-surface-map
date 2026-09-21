export function assertBrowserEvidence(report, archiveSha256, commit) {
  if (
    report?.ok !== true ||
    report.browser_rendered !== true ||
    report.terrain_pixels !== true ||
    report.picking !== true ||
    report.archive_sha256 !== archiveSha256 ||
    report.commit !== commit ||
    !/^[a-z0-9]+-(?:arm64|x64)$/.test(report.browser_host ?? "") ||
    JSON.stringify(report.mount_paths) !== JSON.stringify(["/", "/map/"])
  )
    throw Error(
      "browser evidence is incomplete or not bound to the tested archive",
    );
  return report;
}
