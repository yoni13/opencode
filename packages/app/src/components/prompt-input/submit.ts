import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import { reconcile } from "solid-js/store"
import type { FileSelection } from "@/context/file"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { retry } from "@opencode-ai/core/util/retry"
import { getPendingAttachmentFile, removePendingAttachmentFile } from "./attachments"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()
const DOCKER_WORKSPACE = "docker"
const REFRESH_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  serverUrl: string
  serverSync: ReturnType<typeof useServerSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  signal?: AbortSignal
  onUploaded?: () => void
  onUploadProgress?: (id: string, progress: UploadProgress | undefined) => void
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const byID = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type UploadedFile = {
  path: string
  url: string
  mime?: string
  size: number
}

export type UploadProgress = {
  loaded: number
  total?: number
}

type UploadAttachmentInput = {
  serverUrl: string
  sessionID: string
  attachment: ImageAttachmentPart
  signal?: AbortSignal
  onProgress?: (id: string, progress: UploadProgress | undefined) => void
}

async function uploadAttachment(input: UploadAttachmentInput) {
  if (!input.attachment.pending) return input.attachment
  const file = getPendingAttachmentFile(input.attachment.id)
  if (!file) throw new Error(`Attachment "${input.attachment.filename}" is no longer available. Reattach the file.`)

  const url = new URL(`/session/${encodeURIComponent(input.sessionID)}/upload`, input.serverUrl)
  url.searchParams.set("path", input.attachment.filename || "upload")
  input.onProgress?.(input.attachment.id, { loaded: 0, total: file.size || undefined })
  const uploaded = await uploadFile({
    url,
    file,
    mime: input.attachment.mime || file.type || "application/octet-stream",
    signal: input.signal,
    onProgress: (progress) => input.onProgress?.(input.attachment.id, progress),
  })
  return {
    ...input.attachment,
    pending: false,
    dataUrl: uploaded.url,
    filename: uploaded.path.split("/").pop() || input.attachment.filename,
    mime: uploaded.mime || input.attachment.mime,
  }
}

function uploadFile(input: {
  url: URL
  file: File
  mime: string
  signal?: AbortSignal
  onProgress: (progress: UploadProgress | undefined) => void
}) {
  return new Promise<UploadedFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const cleanup = () => input.signal?.removeEventListener("abort", abort)
    const abort = () => xhr.abort()

    xhr.open("POST", input.url.toString())
    xhr.withCredentials = true
    xhr.setRequestHeader("content-type", input.mime)
    xhr.upload.onprogress = (event) => {
      input.onProgress({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : undefined,
      })
    }
    xhr.onload = () => {
      cleanup()
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(uploadErrorMessage(xhr.responseText, xhr.status)))
        return
      }
      try {
        input.onProgress({ loaded: input.file.size, total: input.file.size || undefined })
        resolve(JSON.parse(xhr.responseText) as UploadedFile)
      } catch {
        reject(new Error("Upload failed: invalid server response"))
      }
    }
    xhr.onerror = () => {
      cleanup()
      reject(new Error("Upload failed"))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new Error("Upload aborted"))
    }
    if (input.signal?.aborted) {
      reject(new Error("Upload aborted"))
      return
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    xhr.send(input.file)
  }).finally(() => input.onProgress(undefined))
}

function uploadErrorMessage(responseText: string, status: number) {
  if (!responseText) return `Upload failed with HTTP ${status}`
  try {
    const body = JSON.parse(responseText)
    if (typeof body?.error === "string") return body.error
  } catch {}
  return `Upload failed with HTTP ${status}`
}

async function uploadPromptAttachments(input: {
  serverUrl: string
  sessionID: string
  prompt: Prompt
  signal?: AbortSignal
  onProgress?: (id: string, progress: UploadProgress | undefined) => void
}) {
  return Promise.all(
    input.prompt.map(async (part) => {
      if (part.type !== "image") return part
      return uploadAttachment({
        serverUrl: input.serverUrl,
        sessionID: input.sessionID,
        attachment: part,
        signal: input.signal,
        onProgress: input.onProgress,
      })
    }),
  )
}

function cleanupPendingPromptFiles(prompt: Prompt) {
  for (const part of prompt) {
    if (part.type !== "image" || !part.pending) continue
    removePendingAttachmentFile(part.id)
    if (part.dataUrl.startsWith("blob:")) URL.revokeObjectURL(part.dataUrl)
  }
}

function hasPendingPromptFiles(prompt: Prompt) {
  return prompt.some((part) => part.type === "image" && part.pending)
}

export async function refreshPromptMessages(input: {
  client: FollowupSendInput["client"]
  serverSync: FollowupSendInput["serverSync"]
  directory: string
  sessionID: string
  messageID: string
}) {
  const messages = await refreshSessionMessages(input)

  return messages.some(
    (message) => message.role === "assistant" && message.parentID === input.messageID && !!message.time.completed,
  )
}

export async function refreshSessionMessages(input: {
  client: FollowupSendInput["client"]
  serverSync: FollowupSendInput["serverSync"]
  directory: string
  sessionID: string
}) {
  const page = await input.client.session.messages({
    directory: input.directory,
    sessionID: input.sessionID,
    limit: 80,
  })
  const items = (page.data ?? []).filter((item) => !!item?.info?.id)
  const messages = items.map((item) => item.info).sort(byID)
  const parts = items
    .map((item) => ({
      id: item.info.id,
      parts: item.parts.filter((part): part is Part => !!part?.id && !REFRESH_SKIP_PARTS.has(part.type)).sort(byID),
    }))
    .filter((item) => item.parts.length > 0)
  const [, setStore] = input.serverSync.child(input.directory)

  batch(() => {
    setStore("message", input.sessionID, reconcile(messages, { key: "id" }))
    for (const item of parts) {
      setStore("part", item.id, reconcile(item.parts, { key: "id" }))
    }
  })

  return messages
}

async function refreshSessionStatus(input: {
  client: FollowupSendInput["client"]
  serverSync: FollowupSendInput["serverSync"]
  directory: string
}) {
  const status = await input.client.session.status()
  const [, setStore] = input.serverSync.child(input.directory)
  setStore("session_status", reconcile(status.data ?? {}, { merge: false }))
}

async function refreshPromptMessagesUntilSettled(input: Parameters<typeof refreshPromptMessages>[0]) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await refreshPromptMessages(input)) {
      await refreshSessionStatus(input).catch(() => {})
      return
    }
    await sleep(attempt < 5 ? 500 : 1000)
  }
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const [, setStore] = input.serverSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }
      const prompt = await uploadPromptAttachments({
        serverUrl: input.serverUrl,
        sessionID: input.draft.sessionID,
        prompt: input.draft.prompt,
        signal: input.signal,
        onProgress: input.onUploadProgress,
      })
      const images = draftImages(prompt)

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        variant: input.draft.variant,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      await refreshSessionMessages({
        client: input.client,
        serverSync: input.serverSync,
        directory: input.draft.sessionDirectory,
        sessionID: input.draft.sessionID,
      }).catch(() => {})
      await refreshSessionStatus({
        client: input.client,
        serverSync: input.serverSync,
        directory: input.draft.sessionDirectory,
      }).catch(() => {})
      cleanupPendingPromptFiles(input.draft.prompt)
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const hasPendingFiles = hasPendingPromptFiles(input.draft.prompt)
  const uploadedPrompt = hasPendingFiles
    ? undefined
    : input.draft.prompt
  const draft = uploadedPrompt ? { ...input.draft, prompt: uploadedPrompt } : undefined
  const images = draft ? draftImages(draft.prompt) : []
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: draft?.prompt ?? input.draft.prompt,
    context: draft?.context ?? input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  if (!hasPendingFiles) {
    batch(() => {
      setBusy()
      add()
    })
  }

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        if (!hasPendingFiles) remove()
      })
      return false
    }

    const readyDraft = hasPendingFiles
      ? {
          ...input.draft,
          prompt: await uploadPromptAttachments({
            serverUrl: input.serverUrl,
            sessionID: input.draft.sessionID,
            prompt: input.draft.prompt,
            signal: input.signal,
            onProgress: input.onUploadProgress,
          }),
        }
      : input.draft
    const readyImages = draftImages(readyDraft.prompt)
    const readyParts = hasPendingFiles
      ? buildRequestParts({
          prompt: readyDraft.prompt,
          context: readyDraft.context,
          images: readyImages,
          text,
          sessionID: readyDraft.sessionID,
          messageID,
          sessionDirectory: readyDraft.sessionDirectory,
        })
      : { requestParts, optimisticParts }

    if (hasPendingFiles) {
      input.onUploaded?.()
      batch(() => {
        setBusy()
        input.sync.session.optimistic.add({
          directory: readyDraft.sessionDirectory,
          sessionID: readyDraft.sessionID,
          message,
          parts: readyParts.optimisticParts,
        })
      })
    }

    await input.client.session.promptAsync({
      sessionID: readyDraft.sessionID,
      agent: readyDraft.agent,
      model: readyDraft.model,
      messageID,
      parts: readyParts.requestParts,
      variant: readyDraft.variant,
    })
    void refreshPromptMessagesUntilSettled({
      client: input.client,
      serverSync: input.serverSync,
      directory: readyDraft.sessionDirectory,
      sessionID: readyDraft.sessionID,
      messageID,
    }).catch(() => {})
    cleanupPendingPromptFiles(input.draft.prompt)
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  onSubmittingChange?: (submitting: boolean) => void
  onUploadProgress?: (id: string, progress: UploadProgress | undefined) => void
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk.scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync.todo.set(sessionID, [])
    const [, setStore] = serverSync.child(sdk.directory)
    setStore("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = serverSync.child(dir, { bootstrap: false })
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  let submitting = false

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || DOCKER_WORKSPACE
    if (isNewSession && submitting) return
    if (isNewSession) {
      submitting = true
      input.onSubmittingChange?.(true)
    }
    const finishSubmitting = () => {
      if (!isNewSession || !submitting) return
      submitting = false
      input.onSubmittingChange?.(false)
    }

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "main") {
        client = sdk.createClient({
          directory: projectDirectory,
          experimental_workspaceID: "main",
          throwOnError: true,
        })
      }

      if (worktreeSelection === DOCKER_WORKSPACE) {
        const createdWorkspace = await retry(() => client.experimental.workspace.create({ type: "docker", branch: null }), {
          attempts: 2,
          delay: 250,
        })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("workspace.create.failed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorkspace?.id || !createdWorkspace.directory) {
          finishSubmitting()
          showToast({
            title: language.t("workspace.create.failed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }

        sessionDirectory = createdWorkspace.directory
        client = sdk.createClient({
          directory: sessionDirectory,
          experimental_workspaceID: createdWorkspace.id,
          throwOnError: true,
        })
      }

      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          finishSubmitting()
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk.scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create" && worktreeSelection !== DOCKER_WORKSPACE) {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory && worktreeSelection !== DOCKER_WORKSPACE) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    finishSubmitting()
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const context = prompt.context.items().slice()
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, input.promptLength(currentPrompt))
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext()
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      try {
        await client.session.shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        await refreshSessionMessages({
          client,
          serverSync,
          directory: sessionDirectory,
          sessionID: session.id,
        }).catch(() => {})
        await refreshSessionStatus({
          client,
          serverSync,
          directory: sessionDirectory,
        }).catch(() => {})
        cleanupPendingPromptFiles(currentPrompt)
      } catch (err) {
        showToast({
          title: language.t("prompt.toast.shellSendFailed.title"),
          description: errorMessage(err),
        })
        restoreInput()
      }
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        const hasPendingFiles = hasPendingPromptFiles(currentPrompt)
        if (hasPendingFiles) input.onSubmittingChange?.(true)
        if (!hasPendingFiles) clearInput()
        try {
          const uploaded = draftImages(
            await uploadPromptAttachments({
              serverUrl: sdk.url,
              sessionID: session.id,
              prompt: currentPrompt,
              onProgress: input.onUploadProgress,
            }),
          )
          if (hasPendingFiles) clearInput()
          await client.session.command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: uploaded.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          await refreshSessionMessages({
            client,
            serverSync,
            directory: sessionDirectory,
            sessionID: session.id,
          }).catch(() => {})
          await refreshSessionStatus({
            client,
            serverSync,
            directory: sessionDirectory,
          }).catch(() => {})
          cleanupPendingPromptFiles(currentPrompt)
        } catch (err) {
          showToast({
            title: language.t("prompt.toast.commandSendFailed.title"),
            description: formatServerError(err, language.t, language.t("common.requestFailed")),
          })
          restoreInput()
        }
        input.onSubmittingChange?.(false)
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    const hasPendingFiles = hasPendingPromptFiles(currentPrompt)

    removeCommentItems(commentItems)
    if (hasPendingFiles) input.onSubmittingChange?.(true)
    if (!hasPendingFiles) clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk.scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreInput()
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sdk.scope, sessionDirectory), abortWait, timeout]).finally(
        () => {
          if (timer.id === undefined) return
          clearTimeout(timer.id)
        },
      )
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client,
      serverUrl: sdk.url,
      sync,
      serverSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
      onUploaded: clearInput,
      onUploadProgress: input.onUploadProgress,
    })
      .catch((err) => {
        pending.delete(pendingKey(session.id))
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreInput()
      })
      .finally(() => {
        input.onSubmittingChange?.(false)
      })
  }

  return {
    abort,
    handleSubmit,
  }
}
