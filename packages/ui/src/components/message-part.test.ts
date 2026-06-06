import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { partDefaultOpen } from "./message-part-default-open"
import { readPartText } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("partDefaultOpen", () => {
  const bashPart = (metadata: Record<string, unknown> = {}) =>
    ({
      id: "part_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/repo",
        title: "",
        metadata,
        time: { start: 1, end: 2 },
      },
    }) satisfies ToolPart

  test("opens user shell bash parts by default", () => {
    expect(partDefaultOpen(bashPart({ userShell: true }))).toBe(true)
  })

  test("keeps ordinary bash parts controlled by shell setting", () => {
    expect(partDefaultOpen(bashPart(), false)).toBe(false)
    expect(partDefaultOpen(bashPart(), true)).toBe(true)
  })
})
