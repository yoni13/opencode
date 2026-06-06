export * as DockerRuntime from "./docker-runtime"

import { Database } from "./database/database"
import { WorkspaceTable } from "./control-plane/workspace.sql"
import { WorkspaceV2 } from "./workspace"
import { FSUtil } from "./fs-util"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { spawn } from "node:child_process"
import path from "node:path"

export const DOCKER_WORKSPACE_PATH = "/workspace"
export const DOCKER_CONFIG_PATH = "/root/.config/opencode"

export const WorkspaceExtra = Schema.Struct({
  kind: Schema.Literal("docker"),
  image: Schema.String,
  container: Schema.String,
  hostDirectory: Schema.String,
  workspacePath: Schema.String,
  configDirectory: Schema.String,
  createdAt: Schema.Number,
})
export type WorkspaceExtra = Schema.Schema.Type<typeof WorkspaceExtra>

export const decodeWorkspaceExtra = Schema.decodeUnknownOption(WorkspaceExtra)

export type RunResult = {
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly exitCode: number
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export type RunInput = {
  readonly runtime: WorkspaceExtra
  readonly command: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string | Uint8Array
  readonly timeout?: number
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
}

export interface Interface {
  readonly resolve: (workspaceID: WorkspaceV2.ID | undefined) => Effect.Effect<WorkspaceExtra | undefined>
  readonly run: (input: RunInput) => Effect.Effect<RunResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DockerRuntime") {}

export function containerPath(runtime: WorkspaceExtra, filepath: string) {
  if (!path.isAbsolute(filepath)) return filepath.split(path.sep).join(path.posix.sep)
  if (!FSUtil.contains(runtime.hostDirectory, filepath)) return filepath.split(path.sep).join(path.posix.sep)
  const relative = path.relative(runtime.hostDirectory, filepath)
  if (!relative || relative === ".") return runtime.workspacePath
  return path.posix.join(runtime.workspacePath, relative.split(path.sep).join(path.posix.sep))
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function commandString(command: readonly string[]) {
  return command.map(shellQuote).join(" ")
}

export const run = Effect.fn("DockerRuntime.run")((input: RunInput) =>
  Effect.tryPromise({
    try: () =>
      new Promise<RunResult>((resolve, reject) => {
        const args = [
          "exec",
          "-i",
          "-w",
          containerPath(input.runtime, input.cwd ?? input.runtime.hostDirectory),
          ...Object.entries(input.env ?? {}).flatMap(([key, value]) =>
            value === undefined ? [] : ["-e", `${key}=${value}`],
          ),
          input.runtime.container,
          ...input.command,
        ]
        const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let stdoutTruncated = false
        let stderrTruncated = false
        const maxOutputBytes = input.maxOutputBytes
        const maxErrorBytes = input.maxErrorBytes
        const timer =
          input.timeout === undefined
            ? undefined
            : setTimeout(() => {
                child.kill("SIGKILL")
              }, input.timeout)

        child.stdout.on("data", (chunk: Buffer) => {
          const remaining = maxOutputBytes === undefined ? chunk.length : maxOutputBytes - stdoutBytes
          if (remaining > 0) stdout.push(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining))
          stdoutBytes += chunk.length
          stdoutTruncated = stdoutTruncated || (maxOutputBytes !== undefined && stdoutBytes > maxOutputBytes)
        })
        child.stderr.on("data", (chunk: Buffer) => {
          const remaining = maxErrorBytes === undefined ? chunk.length : maxErrorBytes - stderrBytes
          if (remaining > 0) stderr.push(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining))
          stderrBytes += chunk.length
          stderrTruncated = stderrTruncated || (maxErrorBytes !== undefined && stderrBytes > maxErrorBytes)
        })
        child.on("error", reject)
        child.on("close", (code) => {
          if (timer) clearTimeout(timer)
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            exitCode: code ?? 1,
            stdoutTruncated,
            stderrTruncated,
          })
        })
        if (input.stdin !== undefined) child.stdin.end(input.stdin)
        else child.stdin.end()
      }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.orDie),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const resolve = Effect.fn("DockerRuntime.resolve")(function* (workspaceID: WorkspaceV2.ID | undefined) {
      if (!workspaceID) return undefined
      const row = yield* db
        .select({ extra: WorkspaceTable.extra })
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.id, workspaceID))
        .get()
        .pipe(Effect.orDie)
      return decodeWorkspaceExtra(row?.extra).valueOrUndefined
    })

    return Service.of({ resolve, run })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
