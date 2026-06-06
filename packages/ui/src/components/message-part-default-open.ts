import type { Part as PartType } from "@opencode-ai/sdk/v2"

function toolDefaultOpen(tool: string, shell = false, edit = false) {
  if (tool === "bash") return shell
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return edit
}

export function partDefaultOpen(part: PartType, shell = false, edit = false) {
  if (part.type !== "tool") return
  if (part.tool === "bash" && "metadata" in part.state && part.state.metadata?.userShell === true) return true
  return toolDefaultOpen(part.tool, shell, edit)
}
