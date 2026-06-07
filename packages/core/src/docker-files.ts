export * as DockerFiles from "./docker-files"

import { Effect } from "effect"
import { DockerRuntime, type WorkspaceExtra } from "./docker-runtime"
import { FileSystem, isBinary } from "./filesystem"
import { FSUtil } from "./fs-util"
import { RelativePath } from "./schema"
import path from "node:path"

export type Runtime = WorkspaceExtra

const MAX_COMMAND_BYTES = 1024 * 1024

export function resolvePath(runtime: Runtime, locationDirectory: string, filepath: string) {
  if (path.isAbsolute(filepath)) return DockerRuntime.containerPath(runtime, filepath)
  return DockerRuntime.containerPath(runtime, path.resolve(locationDirectory, filepath))
}

export function readBytes(runtime: Runtime, filepath: string) {
  return DockerRuntime.run({
    runtime,
    command: ["/bin/sh", "-lc", `base64 ${DockerRuntime.shellQuote(filepath)} | tr -d '\\n'`],
    maxOutputBytes: MAX_COMMAND_BYTES * 20,
    maxErrorBytes: 8 * 1024,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0) return Effect.die(new Error(result.stderr.toString("utf8") || "Unable to read file"))
      if (result.stdoutTruncated) return Effect.die(new Error(`File is too large to read safely: ${filepath}`))
      return Effect.succeed(Buffer.from(result.stdout.toString("utf8"), "base64"))
    }),
  )
}

export function writeBytes(runtime: Runtime, filepath: string, content: string | Uint8Array) {
  return DockerRuntime.run({
    runtime,
    command: [
      "/bin/sh",
      "-lc",
      `mkdir -p ${DockerRuntime.shellQuote(path.posix.dirname(filepath))} && cat > ${DockerRuntime.shellQuote(filepath)}`,
    ],
    stdin: content,
    maxErrorBytes: 8 * 1024,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0) return Effect.die(new Error(result.stderr.toString("utf8") || "Unable to write file"))
      return Effect.void
    }),
  )
}

export function remove(runtime: Runtime, filepath: string) {
  return DockerRuntime.run({
    runtime,
    command: ["/bin/sh", "-lc", `rm -f -- ${DockerRuntime.shellQuote(filepath)}`],
    maxErrorBytes: 8 * 1024,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0) return Effect.die(new Error(result.stderr.toString("utf8") || "Unable to remove file"))
      return Effect.void
    }),
  )
}

export function stat(runtime: Runtime, filepath: string) {
  return DockerRuntime.run({
    runtime,
    command: [
      "/bin/sh",
      "-lc",
      [
        `if [ -d ${DockerRuntime.shellQuote(filepath)} ]; then printf directory;`,
        `elif [ -f ${DockerRuntime.shellQuote(filepath)} ]; then printf file;`,
        "else printf missing; fi",
      ].join(" "),
    ],
    maxOutputBytes: 128,
    maxErrorBytes: 8 * 1024,
  }).pipe(
    Effect.map((result) => {
      const value = result.stdout.toString("utf8")
      return value === "directory" || value === "file" ? value : "missing"
    }),
  )
}

export function list(runtime: Runtime, filepath: string) {
  return DockerRuntime.run({
    runtime,
    command: [
      "/bin/sh",
      "-lc",
      `find ${DockerRuntime.shellQuote(filepath)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n' | sort`,
    ],
    maxOutputBytes: MAX_COMMAND_BYTES,
    maxErrorBytes: 8 * 1024,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0)
        return Effect.die(new Error(result.stderr.toString("utf8") || "Unable to list directory"))
      return Effect.succeed(
        result.stdout
          .toString("utf8")
          .split("\n")
          .filter(Boolean)
          .map((line): { name: string; type: "directory" | "file" } => {
            const [name, type] = line.split("\t")
            return { name: name ?? "", type: type === "d" ? "directory" : "file" }
          }),
      )
    }),
  )
}

export function readTool(runtime: Runtime, filepath: string, resource: string) {
  return Effect.gen(function* () {
    const kind = yield* stat(runtime, filepath)
    if (kind === "directory") {
      return new FileSystem.ListPage({
        entries: (yield* list(runtime, filepath)).map(
          (entry) =>
            new FileSystem.Entry({
              path: RelativePath.make(`${resource === "." ? "" : `${resource}/`}${entry.name}`),
              uri: `file://${path.posix.join(filepath, entry.name)}`,
              type: entry.type,
              mime: entry.type === "directory" ? "application/x-directory" : FSUtil.mimeType(entry.name),
            }),
        ),
        truncated: false,
      })
    }
    if (kind !== "file") return yield* Effect.die(new Error(`Path not found: ${resource}`))
    const bytes = yield* readBytes(runtime, filepath)
    if (isBinary(resource, bytes)) return yield* Effect.die(new FileSystem.BinaryFileError(resource))
    return new FileSystem.TextContent({
      type: "text",
      content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      mime: FSUtil.mimeType(resource),
    })
  })
}

export function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*")
  return new RegExp(`^${escaped}$`)
}

export function files(runtime: Runtime, filepath: string) {
  return DockerRuntime.run({
    runtime,
    command: [
      "/bin/sh",
      "-lc",
      `cd ${DockerRuntime.shellQuote(filepath)} && find . -type f ! -path './.git/*' -printf '%P\\n'`,
    ],
    maxOutputBytes: MAX_COMMAND_BYTES,
    maxErrorBytes: 8 * 1024,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode !== 0) return Effect.die(new Error(result.stderr.toString("utf8") || "Unable to find files"))
      return Effect.succeed(result.stdout.toString("utf8").split("\n").filter(Boolean))
    }),
  )
}
