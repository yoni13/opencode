import { describe, expect, test } from "bun:test"
import { dockerContainerName } from "./docker"

describe("dockerContainerName", () => {
  test("returns the Docker container name", () => {
    expect(dockerContainerName({ kind: "docker", container: "opencode-wrk-example" })).toBe("opencode-wrk-example")
  })

  test("ignores non-Docker and malformed metadata", () => {
    expect(dockerContainerName({ kind: "local", container: "host" })).toBeUndefined()
    expect(dockerContainerName({ kind: "docker", container: 123 })).toBeUndefined()
    expect(dockerContainerName(null)).toBeUndefined()
  })
})
