import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkspaceV2 } from "../src/workspace"

describe("WorkspaceV2.ID", () => {
  test("accepts generated and legacy safe IDs", () => {
    expect(String(Schema.decodeUnknownSync(WorkspaceV2.ID)("wrk_test"))).toBe("wrk_test")
    expect(String(Schema.decodeUnknownSync(WorkspaceV2.ID)("wrk-primary"))).toBe("wrk-primary")
    expect(WorkspaceV2.ID.ascending()).toStartWith("wrk_")
  })

  test("rejects path separators and Docker-name normalization characters", () => {
    for (const id of ["wrk_../../escape", "wrk_..\\escape", "wrk_bad:name", "wrk_bad name", "wrk_.."]) {
      expect(() => Schema.decodeUnknownSync(WorkspaceV2.ID)(id)).toThrow()
      expect(() => WorkspaceV2.ID.ascending(id)).toThrow()
    }
  })
})
