import { Schema } from "effect"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import dockerfile from "./docker/Dockerfile" with { type: "text" }
import { DockerRuntime } from "@opencode-ai/core/docker-runtime"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { type WorkspaceAdapter, type WorkspaceAdapterContext, type WorkspaceInfo } from "../types"
import {
  DOCKER_CONFIG_PATH,
  DOCKER_WORKSPACE_PATH,
  type DockerWorkspaceExtra,
  decodeDockerWorkspaceExtra,
} from "../docker-workspace"

const run = promisify(execFile)
const DEFAULT_SETUP = "#!/usr/bin/env bash\nset -euo pipefail\n"
const EXCLUDED = new Set([".git", "node_modules", ".turbo", ".next", "dist", "build"])
const imageBuilds = new Map<string, Promise<void>>()

const DockerConfig = Schema.Struct({
  image: Schema.optional(Schema.String),
})
const decodeDockerConfig = Schema.decodeUnknownOption(DockerConfig)

export class DockerUnavailableError extends Schema.TaggedErrorClass<DockerUnavailableError>()(
  "DockerUnavailableError",
  {
    message: Schema.String,
  },
) {}

function requireInstance(context: WorkspaceAdapterContext | undefined) {
  if (!context?.instance) throw new Error("Docker adapter requires an instance context")
  return context.instance
}

function dockerName(id: string) {
  return `opencode-${id.replace(/[^a-zA-Z0-9_.-]/g, "-")}`
}

function workspaceRoot(id: string) {
  return path.join(Global.Path.data, "docker-workspace", id)
}

async function configuredImage(info: WorkspaceInfo, instanceDirectory: string) {
  const configured = decodeDockerConfig(info.extra).valueOrUndefined?.image
  if (configured) return configured
  const setup = await Bun.file(path.join(instanceDirectory, ".opencode", "docker", "setup.sh"))
    .text()
    .catch(() => DEFAULT_SETUP)
  return `opencode-session:${Hash.fast(`${dockerfile}\n${setup}`).slice(0, 12)}`
}

async function copyIfExists(from: string, to: string) {
  if (!(await exists(from))) return
  await fs.cp(from, to, { recursive: true })
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function copyProject(source: string, target: string) {
  await fs.cp(source, target, {
    recursive: true,
    filter: (file) => !EXCLUDED.has(path.basename(file)),
  })
}

async function snapshotConfig(instanceDirectory: string, target: string) {
  await fs.mkdir(target, { recursive: true })
  await copyIfExists(Global.Path.config, target)
  await copyIfExists(path.join(instanceDirectory, ".opencode"), path.join(target, ".opencode"))
  await copyIfExists(path.join(Global.Path.data, "mcp-auth.json"), path.join(target, "mcp-auth.json"))
  await fs.mkdir(path.join(target, ".agents"), { recursive: true })
  await fs.mkdir(path.join(target, ".claude"), { recursive: true })
  await copyIfExists(path.join(Global.Path.home, ".agents", "skills"), path.join(target, ".agents", "skills"))
  await copyIfExists(path.join(Global.Path.home, ".claude", "skills"), path.join(target, ".claude", "skills"))
}

async function docker(args: string[]) {
  return run("docker", args)
}

export async function assertDockerAvailable() {
  const result = await docker(["info", "--format", "{{.ServerVersion}}"])
    .then((result) => ({ ok: true as const, stdout: result.stdout }))
    .catch((error: unknown) => ({ ok: false as const, error }))
  if (!result.ok) {
    throw new DockerUnavailableError({
      message: [
        "Docker is required for opencode Docker sessions, but Docker is not installed or usable.",
        "Install Docker, start the Docker daemon, and make sure `docker info` works for this user.",
        "",
        `Docker error: ${dockerError(result.error)}`,
      ].join("\n"),
    })
  }
  if (result.stdout.trim()) return
  throw new DockerUnavailableError({
    message: [
      "Docker is required for opencode Docker sessions, but Docker did not return server information.",
      "Install Docker, start the Docker daemon, and make sure `docker info` works for this user.",
    ].join("\n"),
  })
}

function dockerError(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    const stderr = typeof record.stderr === "string" ? record.stderr.trim() : ""
    const stdout = typeof record.stdout === "string" ? record.stdout.trim() : ""
    const message = error instanceof Error ? error.message : ""
    return stderr || stdout || message || String(error)
  }
  return String(error)
}

async function ensureImage(image: string, setup: string | undefined) {
  if (setup === undefined) return
  if (
    await docker(["image", "inspect", image])
      .then(() => true)
      .catch(() => false)
  )
    return
  const existing = imageBuilds.get(image)
  if (existing) return existing
  const build = (async () => {
    const context = path.join(Global.Path.cache, "docker-session-image", image.slice(image.indexOf(":") + 1))
    await fs.mkdir(context, { recursive: true })
    await fs.writeFile(path.join(context, "Dockerfile"), dockerfile)
    await fs.writeFile(path.join(context, "setup.sh"), setup)
    await docker(["build", "--quiet", "--tag", image, context])
  })().finally(() => {
    imageBuilds.delete(image)
  })
  imageBuilds.set(image, build)
  await build
}

async function removeContainer(container: string) {
  await docker(["rm", "-f", container]).catch(() => undefined)
}

async function startContainer(extra: DockerWorkspaceExtra, setup: string | undefined) {
  await ensureImage(extra.image, setup)
  await removeContainer(extra.container)
  await docker([
    "run",
    "-d",
    "--name",
    extra.container,
    "-w",
    extra.workspacePath,
    "-v",
    `${extra.hostDirectory}:${extra.workspacePath}`,
    "-v",
    `${extra.configDirectory}:${DOCKER_CONFIG_PATH}:ro`,
    "-v",
    `${path.join(extra.configDirectory, ".agents")}:/root/.agents:ro`,
    "-v",
    `${path.join(extra.configDirectory, ".claude")}:/root/.claude:ro`,
    "-e",
    `OPENCODE_CONFIG_DIR=${DOCKER_CONFIG_PATH}`,
    extra.image,
  ])
}

async function ensureContainer(extra: DockerWorkspaceExtra) {
  DockerRuntime.clearIdleStop(extra)
  const running = await docker(["inspect", "--format", "{{.State.Running}}", extra.container])
    .then((result) => result.stdout.trim() === "true")
    .catch(() => false)
  if (running) {
    DockerRuntime.scheduleIdleStop(extra)
    return
  }

  const exists = await docker(["container", "inspect", extra.container])
    .then(() => true)
    .catch(() => false)
  if (exists) {
    await docker(["start", extra.container])
    DockerRuntime.scheduleIdleStop(extra)
    return
  }

  await startContainer(extra, undefined)
  DockerRuntime.scheduleIdleStop(extra)
}

export const DockerAdapter: WorkspaceAdapter = {
  name: "Docker Ubuntu",
  description: "Create a persistent Ubuntu container for the session",
  async configure(info, context) {
    const instance = requireInstance(context)
    const root = workspaceRoot(info.id)
    const next = {
      kind: "docker" as const,
      image: await configuredImage(info, instance.directory),
      container: dockerName(info.id),
      hostDirectory: path.join(root, "workspace"),
      workspacePath: DOCKER_WORKSPACE_PATH,
      configDirectory: path.join(root, "config"),
      createdAt: Date.now(),
    } satisfies DockerWorkspaceExtra
    return {
      ...info,
      name: info.name || `docker-${Hash.fast(info.id).slice(0, 8)}`,
      directory: next.hostDirectory,
      extra: next,
    }
  },
  async create(info, _env, _from, context) {
    const instance = requireInstance(context)
    const extra = decodeDockerWorkspaceExtra(info.extra).valueOrUndefined
    if (!extra) throw new Error("Docker workspace metadata is missing")

    await fs.mkdir(extra.hostDirectory, { recursive: true })
    await copyProject(instance.directory, extra.hostDirectory)
    await snapshotConfig(instance.directory, extra.configDirectory)
    await startContainer(
      extra,
      extra.image.startsWith("opencode-session:")
        ? await Bun.file(path.join(instance.directory, ".opencode", "docker", "setup.sh"))
            .text()
            .catch(() => DEFAULT_SETUP)
        : undefined,
    )
    await ensureContainer(extra)
  },
  async remove(info) {
    const extra = decodeDockerWorkspaceExtra(info.extra).valueOrUndefined
    if (!extra) throw new Error("Docker workspace metadata is missing")

    DockerRuntime.clearIdleStop(extra)
    await removeContainer(extra.container)
    await fs.rm(path.dirname(extra.hostDirectory), { recursive: true, force: true })
  },
  async target(info) {
    const extra = decodeDockerWorkspaceExtra(info.extra).valueOrUndefined
    if (!extra) throw new Error("Docker workspace metadata is missing")
    await ensureContainer(extra)
    return {
      type: "local",
      directory: extra.hostDirectory,
    }
  },
}
