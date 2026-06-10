import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./lsp.txt"
import { InstanceState } from "@/effect/instance-state"
import { fileURLToPath, pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { DockerRuntime } from "@opencode-ai/core/docker-runtime"
import type { InstanceContext } from "@/project/instance-context"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The character offset (1-based, as shown in editors)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const docker = yield* Effect.serviceOption(DockerRuntime.Service)
          const runtime =
            docker._tag === "Some" ? yield* docker.value.resolve(yield* InstanceState.workspaceID) : undefined
          const file = resolveFilePath(instance, runtime, args.filePath)
          yield* assertExternalDirectoryEffect(ctx, file)
          const displayFile = runtime ? DockerRuntime.containerPath(runtime, file) : file
          const meta =
            args.operation === "workspaceSymbol"
              ? { operation: args.operation }
              : args.operation === "documentSymbol"
                ? { operation: args.operation, filePath: displayFile }
                : { operation: args.operation, filePath: displayFile, line: args.line, character: args.character }
          yield* ctx.ask({
            permission: "lsp",
            patterns: ["*"],
            always: ["*"],
            metadata: meta,
          })

          const uri = pathToFileURL(file).href
          const position = { file, line: args.line - 1, character: args.character - 1 }
          const relPath = runtime
            ? path.posix.relative(runtime.workspacePath, displayFile)
            : path.relative(instance.worktree, file)
          const detail =
            args.operation === "workspaceSymbol"
              ? ""
              : args.operation === "documentSymbol"
                ? relPath
                : `${relPath}:${args.line}:${args.character}`
          const title = detail ? `${args.operation} ${detail}` : args.operation

          const exists = yield* fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${file}`)

          const available = yield* lsp.hasClients(file)
          if (!available) throw new Error("No LSP server available for this file type.")

          yield* lsp.touchFile(file, "document")

          const result: unknown[] = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return lsp.hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "workspaceSymbol":
                return lsp.workspaceSymbol(args.query ?? "")
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
            }
          })()
          const outputResult = runtime ? displayResult(runtime, result) : result

          return {
            title,
            metadata: { result: outputResult },
            output:
              result.length === 0 ? `No results found for ${args.operation}` : JSON.stringify(outputResult, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function resolveFilePath(instance: InstanceContext, runtime: DockerRuntime.WorkspaceExtra | undefined, input: string) {
  if (!runtime) return path.isAbsolute(input) ? input : path.join(instance.directory, input)
  if (!path.isAbsolute(input)) return path.join(instance.directory, input)
  return DockerRuntime.hostPath(runtime, input)
}

function displayResult(runtime: DockerRuntime.WorkspaceExtra, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => displayResult(runtime, item))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, displayResult(runtime, item)]))
  }
  if (typeof value !== "string") return value
  if (value.startsWith("file://") && URL.canParse(value)) {
    const url = new URL(value)
    if (url.protocol === "file:") return pathToFileURL(DockerRuntime.containerPath(runtime, fileURLToPath(url))).href
  }
  if (!path.isAbsolute(value)) return value
  return DockerRuntime.containerPath(runtime, value)
}
