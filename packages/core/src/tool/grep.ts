export * as GrepTool from "./grep"

import { Tool, ToolFailure, toolText } from "@opencode-ai/llm"
import { Cause, Effect, Layer, Schema } from "effect"
import { DockerRuntime } from "../docker-runtime"
import { FileSystem } from "../filesystem"
import { Location } from "../location"
import { LocationSearch } from "../location-search"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { DockerFiles } from "../docker-files"

export const name = "grep"

export const Parameters = Schema.Struct({
  pattern: LocationSearch.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: LocationSearch.GrepInput.fields.path.annotate({
    description: "Relative file or directory to search. Defaults to the active Location.",
  }),
  reference: LocationSearch.GrepInput.fields.reference.annotate({
    description: "Named project reference to search instead of the active Location",
  }),
  include: LocationSearch.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: LocationSearch.GrepInput.fields.limit.annotate({
    description: `Maximum matches to return (default: ${LocationSearch.DEFAULT_RESULT_LIMIT})`,
  }),
})

type Success = typeof LocationSearch.GrepResult.Encoded

/** Format raw Location search matches into the familiar concise model output. */
export const toModelOutput = (output: Success) => {
  const lines = output.items.length === 0 ? ["No files found"] : [`Found ${output.items.length} matches`]
  let current = ""
  for (const match of output.items) {
    if (current !== match.resource) {
      if (current) lines.push("")
      current = match.resource
      lines.push(`${match.resource}:`)
    }
    lines.push(`  Line ${match.line}: ${match.lines}${match.linePreviewTruncated ? "..." : ""}`)
  }
  if (output.truncated) {
    lines.push(
      "",
      `(Results are truncated: showing first ${output.items.length} matches. Consider using a more specific path or pattern.)`,
    )
  }
  if (output.partial) lines.push("", "(Some paths were inaccessible and skipped)")
  return lines.join("\n")
}

const definition = Tool.make({
  description:
    "Search file contents by regular expression within the active Location, a named project reference, or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
  parameters: Parameters,
  success: LocationSearch.GrepResult,
  toModelOutput: ({ output }) => [toolText({ type: "text", text: toModelOutput(output) })],
})

/**
 * Location-scoped grep leaf. FileSystem supplies canonical permission metadata;
 * LocationSearch resolves the current root and owns containment and ripgrep execution.
 *
 * TODO: Revisit root-specific search permission resources if named-reference policy needs independent allow/deny rules.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const filesystem = yield* FileSystem.Service
    const search = yield* LocationSearch.Service
    const location = yield* Effect.serviceOption(Location.Service)
    const docker = yield* Effect.serviceOption(DockerRuntime.Service)
    const currentLocation = location._tag === "Some" ? location.value : undefined

    yield* registry.contribute((editor) =>
      editor.set(name, {
        tool: definition,
        execute: ({ parameters, assertPermission }) =>
          Effect.gen(function* () {
            const root = yield* filesystem.resolveRoot(parameters)
            yield* assertPermission({
              action: name,
              resources: [parameters.pattern],
              save: ["*"],
              metadata: {
                root: root.resource,
                reference: parameters.reference,
                path: parameters.path,
                include: parameters.include,
                limit: parameters.limit,
              },
            })
            const runtime =
              docker._tag === "Some" && currentLocation
                ? yield* docker.value.resolve(currentLocation.workspaceID)
                : undefined
            if (runtime) {
              const directory = DockerFiles.resolvePath(runtime, currentLocation!.directory, parameters.path ?? ".")
              const limit = parameters.limit ?? LocationSearch.DEFAULT_RESULT_LIMIT
              const result = yield* DockerRuntime.run({
                runtime,
                command: [
                  "grep",
                  "-RInE",
                  "--exclude-dir=.git",
                  ...(parameters.include ? [`--include=${parameters.include}`] : []),
                  "--",
                  parameters.pattern,
                  ".",
                ],
                cwd: directory,
                maxOutputBytes: 1024 * 1024,
                maxErrorBytes: 8 * 1024,
              })
              if (result.exitCode !== 0 && result.exitCode !== 1) {
                return yield* Effect.die(new Error(result.stderr.toString("utf8") || "grep failed"))
              }
              const rows = result.stdout
                .toString("utf8")
                .split("\n")
                .filter(Boolean)
                .slice(0, limit + 1)
              return new LocationSearch.GrepResult({
                items: rows.slice(0, limit).flatMap((row) => {
                  const first = row.indexOf(":")
                  const second = first === -1 ? -1 : row.indexOf(":", first + 1)
                  if (first === -1 || second === -1) return []
                  const resource = row.slice(0, first).replace(/^\.\//, "")
                  const line = Number.parseInt(row.slice(first + 1, second), 10)
                  if (!Number.isSafeInteger(line) || line < 1) return []
                  const lines = row.slice(second + 1)
                  return [
                    new LocationSearch.Match({
                      path: RelativePath.make(resource),
                      canonical: `${directory}/${resource}`,
                      resource,
                      lines: lines.slice(0, LocationSearch.MAX_LINE_PREVIEW_LENGTH),
                      linePreviewTruncated: lines.length > LocationSearch.MAX_LINE_PREVIEW_LENGTH,
                      line,
                      offset: 0,
                      submatches: [],
                      mtime: 0,
                    }),
                  ]
                }),
                truncated: rows.length > limit,
                partial: result.stdoutTruncated,
              })
            }
            return yield* search.grep(parameters)
          }).pipe(
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause)
              const message =
                error instanceof Ripgrep.InvalidPatternError
                  ? `Invalid grep pattern ${JSON.stringify(parameters.pattern)}: ${error.message}`
                  : `Unable to grep for ${parameters.pattern}`
              return Effect.fail(new ToolFailure({ message, error }))
            }),
          ),
      }),
    )
  }),
)
