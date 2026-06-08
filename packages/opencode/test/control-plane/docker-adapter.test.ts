import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setupScript } from "../../src/control-plane/adapters/docker"

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "opencode-docker-adapter-"))
}

async function withGlobalConfig<T>(dir: string, fn: () => Promise<T>) {
  const previous = Global.Path.config
  ;(Global.Path as { config: string }).config = dir
  try {
    return await fn()
  } finally {
    ;(Global.Path as { config: string }).config = previous
  }
}

describe("docker adapter setup script", () => {
  test("uses project-local setup before global setup", async () => {
    const project = await tmpdir()
    const global = await tmpdir()
    try {
      await fs.mkdir(path.join(project, ".opencode", "docker"), { recursive: true })
      await fs.mkdir(path.join(global, "docker"), { recursive: true })
      await fs.writeFile(path.join(project, ".opencode", "docker", "setup.sh"), "project setup")
      await fs.writeFile(path.join(global, "docker", "setup.sh"), "global setup")

      await withGlobalConfig(global, async () => {
        expect(await setupScript(project)).toBe("project setup")
      })
    } finally {
      await fs.rm(project, { recursive: true, force: true })
      await fs.rm(global, { recursive: true, force: true })
    }
  })

  test("falls back to global config setup", async () => {
    const project = await tmpdir()
    const global = await tmpdir()
    try {
      await fs.mkdir(path.join(global, "docker"), { recursive: true })
      await fs.writeFile(path.join(global, "docker", "setup.sh"), "global setup")

      await withGlobalConfig(global, async () => {
        expect(await setupScript(project)).toBe("global setup")
      })
    } finally {
      await fs.rm(project, { recursive: true, force: true })
      await fs.rm(global, { recursive: true, force: true })
    }
  })

  test("falls back to the default setup", async () => {
    const project = await tmpdir()
    const global = await tmpdir()
    try {
      await withGlobalConfig(global, async () => {
        expect(await setupScript(project)).toBe("#!/usr/bin/env bash\nset -euo pipefail\n")
      })
    } finally {
      await fs.rm(project, { recursive: true, force: true })
      await fs.rm(global, { recursive: true, force: true })
    }
  })
})
