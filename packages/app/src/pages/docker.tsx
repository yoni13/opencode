import type {
  ExperimentalWorkspaceDockerResponse,
  ExperimentalWorkspaceListResponse,
  Session,
} from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useMutation, useQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"

type DockerStat = ExperimentalWorkspaceDockerResponse[number]
type Workspace = ExperimentalWorkspaceListResponse[number]

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatBytes(value: unknown) {
  const bytes = finiteNumber(value)
  if (bytes === undefined) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1)
  return `${numberFormat.format(bytes / 1024 ** index)} ${units[index]}`
}

function formatPercent(value: unknown) {
  const percent = finiteNumber(value)
  if (percent === undefined) return "—"
  return `${numberFormat.format(percent)}%`
}

function dockerExtra(workspace: Workspace | undefined) {
  const extra = workspace?.extra
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return
  if ((extra as { kind?: unknown }).kind !== "docker") return
  return extra as Record<string, unknown>
}

function workspaceLabel(workspace: Workspace | undefined, stat: DockerStat) {
  if (workspace?.name) return workspace.name
  return stat.workspaceID
}

function sessionLabel(session: Session | undefined) {
  return session?.title || session?.slug || "—"
}

export default function DockerPage() {
  const navigate = useNavigate()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [state, setState] = createStore({ busy: undefined as string | undefined })

  const workspaces = useQuery(() => ({
    queryKey: [serverSDK.scope, "docker", "workspaces"] as const,
    queryFn: () => serverSDK.client.experimental.workspace.list().then((result) => result.data ?? []),
  }))

  const stats = useQuery(() => ({
    queryKey: [serverSDK.scope, "docker", "stats"] as const,
    queryFn: () => serverSDK.client.experimental.workspace.docker().then((result) => result.data ?? []),
    refetchInterval: 5000,
  }))

  const sessions = useQuery(() => ({
    queryKey: [serverSDK.scope, "docker", "sessions"] as const,
    queryFn: () =>
      serverSDK.client.session
        .list({
          roots: true,
          limit: 5000,
        })
        .then((result) => result.data ?? []),
    refetchInterval: 10_000,
  }))

  const workspaceByID = createMemo(() => new Map((workspaces.data ?? []).map((item) => [item.id, item] as const)))
  const sessionByWorkspaceID = createMemo(() => {
    const map = new Map<string, Session>()
    for (const session of sessions.data ?? []) {
      if (!session.workspaceID) continue
      const current = map.get(session.workspaceID)
      if (current && (current.time.updated ?? current.time.created) >= (session.time.updated ?? session.time.created)) continue
      map.set(session.workspaceID, session)
    }
    return map
  })
  const rows = createMemo(() =>
    (stats.data ?? []).map((stat) => ({
      stat,
      workspace: workspaceByID().get(stat.workspaceID),
      session: sessionByWorkspaceID().get(stat.workspaceID),
    })),
  )
  const orphanRows = createMemo(() => rows().filter((row) => row.stat.workspaceID.startsWith("wrk_") && !row.session))
  const running = createMemo(() => rows().filter((row) => row.stat.running).length)
  const imageBytes = createMemo(() =>
    rows().reduce((total, row) => total + (finiteNumber(row.stat.imageSizeBytes) ?? 0), 0),
  )
  const memoryBytes = createMemo(() =>
    rows().reduce((total, row) => total + (finiteNumber(row.stat.memoryUsageBytes) ?? 0), 0),
  )

  const refresh = () => Promise.all([workspaces.refetch(), stats.refetch(), sessions.refetch()])

  const fail = (err: unknown) =>
    showToast({
      variant: "error",
      title: "Docker request failed",
      description: formatServerError(err, language.t),
    })

  const toggleIdleStop = useMutation(() => ({
    mutationFn: async (input: { stat: DockerStat; workspace: Workspace | undefined }) => {
      const extra = dockerExtra(input.workspace)
      if (!extra) throw new Error("Docker workspace metadata is missing")
      setState("busy", input.stat.workspaceID)
      await serverSDK.client.experimental.workspace.update({
        id: input.stat.workspaceID,
        extra: {
          ...extra,
          idleStopDisabled: !input.stat.idleStopDisabled,
        },
      })
    },
    onError: fail,
    onSettled: () => {
      setState("busy", undefined)
      void refresh()
    },
  }))

  const action = useMutation(() => ({
    mutationFn: async (input: { id: string; action: "start" | "stop" }) => {
      setState("busy", input.id)
      if (input.action === "start") {
        await serverSDK.client.experimental.workspace.docker2.start({ id: input.id })
        return
      }
      await serverSDK.client.experimental.workspace.docker2.stop({ id: input.id })
    },
    onError: fail,
    onSettled: () => {
      setState("busy", undefined)
      void refresh()
    },
  }))

  const cleanOrphans = useMutation(() => ({
    mutationFn: async () => {
      setState("busy", "cleanup")
      await Promise.all(orphanRows().map((row) => serverSDK.client.experimental.workspace.remove({ id: row.stat.workspaceID })))
    },
    onError: fail,
    onSuccess: () =>
      showToast({
        variant: "success",
        title: "Docker cleanup complete",
        description: `Removed ${orphanRows().length} container${orphanRows().length === 1 ? "" : "s"} without sessions.`,
      }),
    onSettled: () => {
      setState("busy", undefined)
      void refresh()
    },
  }))

  return (
    <div class="m-2 min-h-0 flex-1 self-stretch rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <div class="mx-auto flex h-full max-w-[1180px] flex-col px-6 py-8">
        <header class="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-v2-border-border-base pb-5">
          <div class="flex min-w-0 items-center gap-3">
            <ButtonV2 variant="ghost-muted" onClick={() => navigate("/")}>
              Back
            </ButtonV2>
            <div class="flex min-w-0 flex-col gap-1">
              <h1 class="text-[18px] font-semibold leading-6 text-v2-text-text-base">Docker containers</h1>
              <p class="text-[12px] leading-4 text-v2-text-text-muted">
                Manage OpenCode workspace containers on the current server.
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <ButtonV2
              variant="ghost-muted"
              onClick={() => void refresh()}
              disabled={stats.isFetching || workspaces.isFetching || sessions.isFetching}
            >
              Refresh
            </ButtonV2>
            <ButtonV2
              variant="ghost-muted"
              disabled={state.busy === "cleanup" || sessions.isLoading || sessions.isError || orphanRows().length === 0}
              onClick={() => cleanOrphans.mutate()}
            >
              Auto-clean orphans ({orphanRows().length})
            </ButtonV2>
          </div>
        </header>

        <div class="grid grid-cols-2 gap-3 py-5 md:grid-cols-4">
          <DockerMetric label="Containers" value={String(rows().length)} />
          <DockerMetric label="Running" value={String(running())} />
          <DockerMetric label="Image size" value={formatBytes(imageBytes())} />
          <DockerMetric label="RAM" value={formatBytes(memoryBytes())} />
        </div>

        <div class="min-h-0 flex-1 overflow-auto rounded-[8px] border border-v2-border-border-base">
          <Show
            when={!stats.isLoading && rows().length > 0}
            fallback={
              <div class="flex h-40 items-center justify-center text-[13px] text-v2-text-text-muted">
                {stats.isLoading ? "Loading Docker containers..." : "No Docker workspaces found."}
              </div>
            }
          >
            <table class="w-full min-w-[1120px] border-collapse text-left text-[12px]">
              <thead class="sticky top-0 bg-v2-background-bg-layer-01 text-v2-text-text-muted">
                <tr>
                  <DockerHeader label="Workspace" />
                  <DockerHeader label="Session" />
                  <DockerHeader label="Container" />
                  <DockerHeader label="Status" />
                  <DockerHeader label="RAM" />
                  <DockerHeader label="Image size" />
                  <DockerHeader label="Auto-stop setting" />
                  <DockerHeader label="Actions" />
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => {
                    const busy = () => state.busy === "cleanup" || state.busy === row.stat.workspaceID
                    return (
                      <tr class="border-t border-v2-border-border-base">
                        <td class="max-w-[220px] px-4 py-3 align-middle">
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="truncate text-v2-text-text-base">{workspaceLabel(row.workspace, row.stat)}</span>
                            <span class="truncate font-mono text-[11px] text-v2-text-text-faint">
                              {row.stat.workspaceID}
                            </span>
                          </div>
                        </td>
                        <td class="max-w-[240px] px-4 py-3 align-middle">
                          <div class="flex min-w-0 flex-col gap-1">
                            <span class="truncate text-v2-text-text-base">{sessionLabel(row.session)}</span>
                            <Show when={row.session}>
                              {(session) => (
                                <span class="truncate font-mono text-[11px] text-v2-text-text-faint">{session().id}</span>
                              )}
                            </Show>
                          </div>
                        </td>
                        <td class="max-w-[220px] px-4 py-3 align-middle">
                          <div class="flex min-w-0 items-center gap-2">
                            <Icon name="server" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                            <span class="truncate font-mono text-v2-text-text-muted">{row.stat.container}</span>
                          </div>
                        </td>
                        <td class="px-4 py-3 align-middle">
                          <span
                            class="inline-flex h-6 items-center rounded-[4px] border px-2 text-[11px]"
                            classList={{
                              "border-v2-icon-icon-success text-v2-text-text-base": row.stat.running,
                              "border-v2-border-border-base text-v2-text-text-muted": !row.stat.running,
                            }}
                          >
                            {row.stat.status}
                          </span>
                        </td>
                        <td class="px-4 py-3 align-middle text-v2-text-text-muted">
                          <div class="flex flex-col gap-1">
                            <span>{formatBytes(row.stat.memoryUsageBytes)}</span>
                            <span class="text-[11px] text-v2-text-text-faint">{formatPercent(row.stat.memoryPercent)}</span>
                          </div>
                        </td>
                        <td class="px-4 py-3 align-middle text-v2-text-text-muted">{formatBytes(row.stat.imageSizeBytes)}</td>
                        <td class="px-4 py-3 align-middle">
                          <div class="flex min-w-[150px] items-center gap-3">
                            <Switch
                              checked={row.stat.idleStopDisabled}
                              disabled={busy()}
                              onChange={() => toggleIdleStop.mutate({ stat: row.stat, workspace: row.workspace })}
                            >
                              <span class="sr-only">
                                {row.stat.idleStopDisabled
                                  ? `Turn auto-stop on for ${row.stat.container}`
                                  : `Turn auto-stop off for ${row.stat.container}`}
                              </span>
                            </Switch>
                            <div class="flex min-w-0 flex-col gap-1">
                              <span class="text-v2-text-text-base">
                                {row.stat.idleStopDisabled ? "Auto-stop off" : "Auto-stop on"}
                              </span>
                              <span class="text-[11px] text-v2-text-text-faint">
                                {row.stat.idleStopDisabled ? "Keeps running" : "Stops when idle"}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td class="px-4 py-3 align-middle">
                          <div class="flex items-center gap-2">
                            <ButtonV2
                              variant="ghost-muted"
                              disabled={busy() || row.stat.running}
                              onClick={() => action.mutate({ id: row.stat.workspaceID, action: "start" })}
                            >
                              Start
                            </ButtonV2>
                            <ButtonV2
                              variant="ghost-muted"
                              disabled={busy() || !row.stat.running}
                              onClick={() => action.mutate({ id: row.stat.workspaceID, action: "stop" })}
                            >
                              Hibernate
                            </ButtonV2>
                          </div>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </div>
    </div>
  )
}

function DockerMetric(props: { label: string; value: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-2 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-4 py-3">
      <span class="text-[11px] text-v2-text-text-muted">{props.label}</span>
      <span class="truncate text-[16px] font-semibold text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

function DockerHeader(props: { label: string }) {
  return <th class="px-4 py-3 text-[11px] font-medium uppercase tracking-normal">{props.label}</th>
}
