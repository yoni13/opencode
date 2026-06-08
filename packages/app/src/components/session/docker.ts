function dockerMetadata(extra: unknown) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return
  const metadata = extra as Record<string, unknown>
  if (metadata.kind !== "docker") return
  return metadata
}

export function dockerContainerName(extra: unknown) {
  const metadata = dockerMetadata(extra)
  if (!metadata) return
  if (typeof metadata.container !== "string") return
  return metadata.container
}

export function dockerIdleStopDisabled(extra: unknown) {
  return dockerMetadata(extra)?.idleStopDisabled === true
}
