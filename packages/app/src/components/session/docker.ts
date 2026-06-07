export function dockerContainerName(extra: unknown) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return
  const metadata = extra as Record<string, unknown>
  if (metadata.kind !== "docker") return
  if (typeof metadata.container !== "string") return
  return metadata.container
}
