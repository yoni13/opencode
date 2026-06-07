import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { isManagedDockerWorkspaceDirectory } from "./index"

describe("permission docker workspace detection", () => {
  test("matches managed docker workspace directories", () => {
    expect(
      isManagedDockerWorkspaceDirectory(path.join(Global.Path.data, "docker-workspace", "wrk_123", "workspace")),
    ).toBe(true)
    expect(
      isManagedDockerWorkspaceDirectory(path.join(Global.Path.data, "docker-workspace", "wrk_123", "workspace", "src")),
    ).toBe(true)
  })

  test("does not match docker config or ordinary directories", () => {
    expect(isManagedDockerWorkspaceDirectory(path.join(Global.Path.data, "docker-workspace", "wrk_123", "config"))).toBe(
      false,
    )
    expect(isManagedDockerWorkspaceDirectory(path.join(Global.Path.data, "projects", "repo"))).toBe(false)
  })
})
