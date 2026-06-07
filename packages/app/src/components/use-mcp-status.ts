import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"

export function useMcpStatus() {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()
  const workspaceID = createMemo(() => (params.id ? sync.session.get(params.id)?.workspaceID : undefined))
  const client = createMemo(() => {
    const workspace = workspaceID()
    if (!workspace) return sdk.client
    return sdk.createClient({
      directory: sync.directory,
      experimental_workspaceID: workspace,
      throwOnError: true,
    })
  })
  const query = createQuery(() => ({
    queryKey: [sdk.scope, sync.directory, "mcp", workspaceID()] as const,
    enabled: !!workspaceID(),
    queryFn: () => client().mcp.status().then((result) => result.data ?? {}),
  }))

  return {
    client,
    workspaceID,
    data: createMemo(() => (workspaceID() ? (query.data ?? {}) : (sync.data.mcp ?? {}))),
    ready: createMemo(() => (workspaceID() ? !query.isLoading : sync.data.mcp_ready)),
    refetch: () =>
      workspaceID()
        ? query.refetch()
        : queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory))),
  }
}
