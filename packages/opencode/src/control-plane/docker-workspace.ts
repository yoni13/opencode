import { Schema } from "effect"

export const DOCKER_WORKSPACE_PATH = "/workspace"
export const DOCKER_CONFIG_PATH = "/root/.config/opencode"

export const DockerWorkspaceExtra = Schema.Struct({
  kind: Schema.Literal("docker"),
  image: Schema.String,
  container: Schema.String,
  hostDirectory: Schema.String,
  workspacePath: Schema.String,
  configDirectory: Schema.String,
  createdAt: Schema.Number,
})
export type DockerWorkspaceExtra = Schema.Schema.Type<typeof DockerWorkspaceExtra>

export const decodeDockerWorkspaceExtra = Schema.decodeUnknownOption(DockerWorkspaceExtra)

export * as DockerWorkspace from "./docker-workspace"
