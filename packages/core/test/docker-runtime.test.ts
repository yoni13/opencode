import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DockerRuntime } from "../src/docker-runtime"
import { WorkspaceV2 } from "../src/workspace"

const runtime: DockerRuntime.WorkspaceExtra = {
  kind: "docker",
  workspaceID: WorkspaceV2.ID.make("wrk_test"),
  image: "ubuntu",
  container: "opencode-wrk_test",
  hostDirectory: "/data/docker-workspace/wrk_test/workspace",
  workspacePath: "/workspace",
  configDirectory: "/data/docker-workspace/wrk_test/config",
  createdAt: 1,
}

function inspect(input?: { workspaceID?: string; workspaceSource?: string }) {
  return {
    Config: {
      Labels: {
        [DockerRuntime.MANAGED_LABEL]: "true",
        [DockerRuntime.WORKSPACE_LABEL]: input?.workspaceID ?? "wrk_test",
      },
    },
    Mounts: [
      {
        Source: input?.workspaceSource ?? runtime.hostDirectory,
        Destination: runtime.workspacePath,
        RW: true,
      },
      { Source: runtime.configDirectory, Destination: DockerRuntime.DOCKER_CONFIG_PATH, RW: false },
      { Source: `${runtime.configDirectory}/.agents`, Destination: "/root/.agents", RW: false },
      { Source: `${runtime.configDirectory}/.claude`, Destination: "/root/.claude", RW: false },
    ],
  }
}

describe("DockerRuntime.assertContainerOwnership", () => {
  test("accepts the expected workspace labels and mounts", () => {
    expect(() => DockerRuntime.assertContainerOwnership(runtime, inspect())).not.toThrow()
  })

  test("rejects container-name collisions and unexpected mounts", () => {
    expect(() => DockerRuntime.assertContainerOwnership(runtime, inspect({ workspaceID: "wrk_other" }))).toThrow()
    expect(() =>
      DockerRuntime.assertContainerOwnership(runtime, inspect({ workspaceSource: "/tmp/foreign" })),
    ).toThrow()
  })
})

describe("DockerRuntime.execCommand", () => {
  test("wraps commands in a tracked container process group", () => {
    const command = DockerRuntime.execCommand({
      runtime,
      cwd: path.join(runtime.hostDirectory, "src"),
      env: { TERM: "dumb" },
      command: ["/bin/bash", "-lc", "sleep 60"],
    })

    expect(command.command).toBe("docker")
    expect(command.cwd).toBe(runtime.hostDirectory)
    expect(command.args).toContain("setsid")
    expect(command.args).toContain("--wait")
    expect(command.args).toContain("/workspace/src")
    expect(command.args).toContain("TERM=dumb")
    expect(command.args.at(-3)).toBe("/bin/bash")
    expect(command.args.at(-2)).toBe("-lc")
    expect(command.args.at(-1)).toBe("sleep 60")
    expect(command.args.find((arg) => arg.includes(command.pidFile))).toContain("trap")
  })
})
