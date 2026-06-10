export * as DockerRuntime from "./docker-runtime"

import { Database } from "./database/database"
import { WorkspaceTable } from "./control-plane/workspace.sql"
import { WorkspaceV2 } from "./workspace"
import { FSUtil } from "./fs-util"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { promisify } from "node:util"

export const DOCKER_WORKSPACE_PATH = "/workspace"
export const DOCKER_CONFIG_PATH = "/root/.config/opencode"
export const MANAGED_LABEL = "ai.opencode.managed"
export const WORKSPACE_LABEL = "ai.opencode.workspace.id"

export const WorkspaceExtra = Schema.Struct({
  kind: Schema.Literal("docker"),
  workspaceID: Schema.optional(WorkspaceV2.ID),
  image: Schema.String,
  container: Schema.String,
  hostDirectory: Schema.String,
  workspacePath: Schema.String,
  configDirectory: Schema.String,
  createdAt: Schema.Number,
  idleStopDisabled: Schema.optional(Schema.Boolean),
})
export type WorkspaceExtra = Schema.Schema.Type<typeof WorkspaceExtra>

export const decodeWorkspaceExtra = Schema.decodeUnknownOption(WorkspaceExtra)
export const IDLE_STOP_MS = 5 * 60 * 1000

const execDocker = promisify(execFile)
const idleStops = new Map<string, ReturnType<typeof setTimeout>>()
const activeRuns = new Map<string, number>()

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

export type ExecInput = {
  readonly runtime: WorkspaceExtra
  readonly command: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
}

export type ExecCommand = {
  readonly command: "docker"
  readonly args: readonly string[]
  readonly cwd: string
  readonly pidFile: string
  readonly runtime: WorkspaceExtra
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

export function hostPath(runtime: WorkspaceExtra, filepath: string) {
  const normalized = filepath.split(path.sep).join(path.posix.sep)
  if (normalized === runtime.workspacePath) return runtime.hostDirectory
  if (!normalized.startsWith(`${runtime.workspacePath}/`)) return filepath
  return path.join(runtime.hostDirectory, ...normalized.slice(runtime.workspacePath.length + 1).split(path.posix.sep))
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function commandString(command: readonly string[]) {
  return command.map(shellQuote).join(" ")
}

export function clearIdleStop(runtime: WorkspaceExtra) {
  const timer = idleStops.get(runtime.container)
  if (!timer) return
  clearTimeout(timer)
  idleStops.delete(runtime.container)
}

export function scheduleIdleStop(runtime: WorkspaceExtra) {
  if (runtime.idleStopDisabled) {
    clearIdleStop(runtime)
    return
  }
  if ((activeRuns.get(runtime.container) ?? 0) > 0) return
  const existing = idleStops.get(runtime.container)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    idleStops.delete(runtime.container)
    void stopIdleContainer(runtime)
  }, IDLE_STOP_MS)
  idleStops.set(runtime.container, timer)
  ;(timer as { unref?: () => void }).unref?.()
}

export async function ensureRunning(runtime: WorkspaceExtra) {
  const containers = await execDocker("docker", ["container", "inspect", runtime.container])
    .then((result) => JSON.parse(result.stdout) as ContainerInspect[])
    .catch(() => undefined)
  const container = containers?.[0]
  if (!container) throw new Error(`Docker container not found: ${runtime.container}`)
  assertContainerOwnership(runtime, container)
  if (container.State?.Running === true) return
  await execDocker("docker", ["start", runtime.container])
}

type ContainerInspect = {
  Id?: string
  Config?: { Labels?: Record<string, string> }
  Mounts?: { Source?: string; Destination?: string; RW?: boolean }[]
  State?: { Running?: boolean }
}

async function stopIdleContainer(runtime: WorkspaceExtra) {
  const containers = await execDocker("docker", ["container", "inspect", runtime.container])
    .then((result) => JSON.parse(result.stdout) as ContainerInspect[])
    .catch(() => undefined)
  const container = containers?.[0]
  if (!container?.Id || container.State?.Running !== true) return
  try {
    assertContainerOwnership(runtime, container)
  } catch {
    return
  }
  await execDocker("docker", ["stop", container.Id]).catch(() => undefined)
}

export function assertContainerOwnership(runtime: WorkspaceExtra, container: ContainerInspect) {
  const mounts = new Map(
    (container.Mounts ?? []).map((mount) => [
      mount.Destination,
      { source: path.resolve(mount.Source ?? ""), writable: mount.RW === true },
    ]),
  )
  const expected = [
    [runtime.workspacePath, runtime.hostDirectory, true],
    ["/tmp", runtime.hostDirectory, true],
    [DOCKER_CONFIG_PATH, runtime.configDirectory, false],
    ["/root/.agents", path.join(runtime.configDirectory, ".agents"), false],
    ["/root/.claude", path.join(runtime.configDirectory, ".claude"), false],
  ] as const
  const validMounts = expected.every(([destination, source, writable]) => {
    const mount = mounts.get(destination)
    return mount?.source === path.resolve(source) && mount.writable === writable
  })
  const labels = container.Config?.Labels ?? {}
  const workspaceID = runtime.workspaceID ?? runtime.container.slice("opencode-".length)
  if (
    !validMounts ||
    (labels[MANAGED_LABEL] !== undefined && labels[MANAGED_LABEL] !== "true") ||
    (labels[WORKSPACE_LABEL] !== undefined && labels[WORKSPACE_LABEL] !== workspaceID)
  ) {
    throw new Error(`Container ${runtime.container} is not owned by workspace ${workspaceID}`)
  }
}

function beginRun(runtime: WorkspaceExtra) {
  clearIdleStop(runtime)
  activeRuns.set(runtime.container, (activeRuns.get(runtime.container) ?? 0) + 1)
}

function endRun(runtime: WorkspaceExtra) {
  const remaining = (activeRuns.get(runtime.container) ?? 1) - 1
  if (remaining > 0) {
    activeRuns.set(runtime.container, remaining)
    return
  }
  activeRuns.delete(runtime.container)
  scheduleIdleStop(runtime)
}

export const activity = Effect.fn("DockerRuntime.activity")((runtime: WorkspaceExtra) =>
  Effect.tryPromise({
    try: async () => {
      beginRun(runtime)
      try {
        await ensureRunning(runtime)
      } catch (error) {
        endRun(runtime)
        throw error
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        endRun(runtime)
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.orDie),
)

export function execCommand(input: ExecInput): ExecCommand {
  const pidFile = `/tmp/opencode-${randomUUID()}.pid`
  return {
    command: "docker",
    args: [
      "exec",
      "-i",
      "-w",
      containerPath(input.runtime, input.cwd ?? input.runtime.hostDirectory),
      ...Object.entries(input.env ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : ["-e", `${key}=${value}`],
      ),
      input.runtime.container,
      "setsid",
      "--wait",
      "/bin/sh",
      "-c",
      `printf '%s' "$$" > ${shellQuote(pidFile)}; trap 'rm -f ${shellQuote(pidFile)}' EXIT; "$@"`,
      "opencode",
      ...input.command,
    ],
    cwd: input.runtime.hostDirectory,
    pidFile,
    runtime: input.runtime,
  }
}

export const terminate = Effect.fn("DockerRuntime.terminate")((command: ExecCommand) =>
  Effect.promise(() => terminateCommand(command.runtime.container, command.pidFile)),
)

export const run = Effect.fn("DockerRuntime.run")((input: RunInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* activity(input.runtime)
      yield* Effect.addFinalizer(() => Effect.sync(release))
      return yield* Effect.tryPromise({
        try: () => runCommand(input),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
    }),
  ).pipe(Effect.orDie),
)

async function runCommand(input: RunInput) {
  return await new Promise<RunResult>((resolve, reject) => {
    const command = execCommand(input)
    const child = spawn(command.command, command.args, { stdio: ["pipe", "pipe", "pipe"] })
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
            void terminateCommand(input.runtime.container, command.pidFile).finally(() => child.kill("SIGKILL"))
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
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
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
  })
}

async function terminateCommand(container: string, pidFile: string) {
  await execDocker("docker", [
    "exec",
    container,
    "/bin/sh",
    "-c",
    `pid=$(cat ${shellQuote(pidFile)} 2>/dev/null) || exit 0; kill -TERM -- "-$pid" 2>/dev/null || true; sleep 0.2; kill -KILL -- "-$pid" 2>/dev/null || true; rm -f ${shellQuote(pidFile)}`,
  ]).catch(() => undefined)
}

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
      const extra = decodeWorkspaceExtra(row?.extra).valueOrUndefined
      if (!extra) return undefined
      return { ...extra, workspaceID }
    })

    return Service.of({ resolve, run })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
