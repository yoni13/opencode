import { Schema } from "effect"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"

export const DOCKER_WORKSPACE_PATH = "/workspace"
export const DOCKER_CONFIG_PATH = "/root/.config/opencode"

export const DockerWorkspaceExtra = Schema.Struct({
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
export type DockerWorkspaceExtra = Schema.Schema.Type<typeof DockerWorkspaceExtra>

export const decodeDockerWorkspaceExtra = Schema.decodeUnknownOption(DockerWorkspaceExtra)

export * as DockerWorkspace from "./docker-workspace"
