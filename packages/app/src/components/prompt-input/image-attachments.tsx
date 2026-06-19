import { Component, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { ImageAttachmentPart } from "@/context/prompt"
import type { UploadProgress } from "./submit"

type PromptImageAttachmentsProps = {
  attachments: ImageAttachmentPart[]
  progress?: Record<string, UploadProgress | undefined>
  onOpen: (attachment: ImageAttachmentPart) => void
  onRemove: (id: string) => void
  removeLabel: string
}

const fallbackClass = "size-16 rounded-md bg-surface-base flex items-center justify-center border border-border-base"
const imageClass =
  "size-16 rounded-md object-cover border border-border-base hover:border-border-strong-base transition-colors"
const removeClass =
  "absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
const nameClass = "absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md"
const progressClass = "absolute inset-x-1 bottom-5 h-1 overflow-hidden rounded-full bg-black/40"
const progressBarClass = "h-full rounded-full bg-white transition-[width] duration-150"

function progressPercent(progress: UploadProgress | undefined) {
  if (!progress?.total) return undefined
  return Math.max(0, Math.min(100, Math.round((progress.loaded / progress.total) * 100)))
}

export const PromptImageAttachments: Component<PromptImageAttachmentsProps> = (props) => {
  return (
    <Show when={props.attachments.length > 0}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={props.attachments}>
          {(attachment) => {
            const progress = () => props.progress?.[attachment.id]
            const percent = () => progressPercent(progress())

            return (
              <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
                <div class="relative group">
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={
                      <div class={fallbackClass}>
                        <Icon name="folder" class="size-6 text-text-weak" />
                      </div>
                    }
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.filename}
                      class={imageClass}
                      onClick={() => props.onOpen(attachment)}
                    />
                  </Show>
                  <button
                    type="button"
                    onClick={() => props.onRemove(attachment.id)}
                    class={removeClass}
                    aria-label={props.removeLabel}
                  >
                    <Icon name="close" class="size-3 text-text-weak" />
                  </button>
                  <Show when={progress()}>
                    <>
                      <div class={progressClass}>
                        <div
                          class={progressBarClass}
                          classList={{ "animate-pulse": percent() === undefined }}
                          style={{ width: `${percent() ?? 40}%` }}
                        />
                      </div>
                      <Show when={percent() !== undefined}>
                        <div class="absolute left-1 top-1 rounded bg-black/50 px-1 py-0.5">
                          <span class="text-10-regular text-white">{percent()}%</span>
                        </div>
                      </Show>
                    </>
                  </Show>
                  <div class={nameClass}>
                    <span class="text-10-regular text-white truncate block">{attachment.filename}</span>
                  </div>
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
