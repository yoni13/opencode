# Fork Differences

This fork is not a drop-in behavior match for upstream OpenCode. It keeps the
same general product shape, but changes the default execution model around
sessions, files, tools, and the web UI.

## Docker Sessions

Upstream OpenCode normally runs sessions directly on the host project directory.
This fork creates a Docker workspace for new sessions by default.

- New sessions created through the web UI or API are placed in a Docker-backed
  workspace unless a caller explicitly targets an existing workspace or `main`.
- The default session container is built from
  `packages/opencode/src/control-plane/adapters/docker/Dockerfile`.
- The current base image is `debian:13-slim`.
- Containers are named `opencode-<workspace_id>`, for example
  `opencode-wrk_...`.
- The agent sees the project at `/workspace`.
- The host copy of that workspace lives under
  `~/.local/share/opencode/docker-workspace/<workspace_id>/workspace`.
- OpenCode config is snapshotted for the workspace and mounted read-only at
  `/root/.config/opencode`.
- Skills are snapshotted into the workspace config and mounted at
  `/root/.agents` and `/root/.claude`.

Docker must be installed and usable when launching OpenCode with Docker sessions.
Startup fails early if `docker info` does not work for the server user.

## Container Image Setup

The Docker image includes a minimal agent runtime:

- shell basics such as `bash`, `curl`, `wget`, `git`, `jq`, `file`, `tree`,
  `zip`, `unzip`, `ripgrep`, `fd`, `rsync`, and process tools
- Python 3, `pip`, `venv`, and `uv`
- Node.js and npm
- selected document, PDF, OCR, browser, Java, and reverse-engineering support
  installed by the Docker setup script

The setup script resolution order is:

1. `<project>/.opencode/docker/setup.sh`
2. `~/.config/opencode/docker/setup.sh`
3. an empty default setup script

Changing either setup script changes the generated image hash for future Docker
workspaces. Existing containers are not rebuilt automatically.

Shared caches are mounted into containers to reduce repeated install cost:

- `/opt/opencode/browser-cache`
- `/root/.npm`
- `/root/.cache/uv`

If present on the host, selected IDA/reverse-engineering paths are mounted into
containers so IDA MCP tooling can access the same workspace view as the agent.

## Tool And MCP Execution

Upstream tools generally execute in the OpenCode server process context. In this
fork, location-scoped tools resolve Docker workspace placement and execute
against the matching container when the session owns a Docker workspace.

This includes shell execution and the core file tools such as read, write, edit,
grep, glob, and apply-patch. Tool output storage is also resolved through the
session location so agents should see container paths instead of host-only paths.

MCP processes are also location-scoped. For Docker sessions, MCP command servers
are launched through `docker exec` where applicable, so MCPs see `/workspace`
and the container filesystem. The instance state cache is keyed by workspace as
well as directory to avoid reusing host-side MCP state for Docker workspaces.

Subagents inherit the session location, so a subagent for a Docker-backed
session should use the same Docker workspace rather than falling back to the
host.

## Permissions

This fork is intended to use Docker as the main sandbox boundary. The web UI
auto-accepts session permissions for Docker-backed sessions where configured,
instead of requiring a prompt for every normal file or shell action.

This is intentionally different from upstream's more conservative host-based
permission flow. Do not treat Docker auto-allow behavior as appropriate for
non-container execution.

## Workspace And Session Routing

The fork adds Docker workspaces to the experimental workspace system.

- Workspace metadata stores Docker-specific fields under `extra.kind =
  "docker"`.
- Session list routing treats the configured `workspace.default_directory` as
  the project scope, so a default directory such as `/root/blank` can list the
  Docker sessions created from that default starting point.
- Session create without an explicit workspace creates a Docker workspace first,
  then creates the session inside that workspace.
- Passing `workspace=main` or `x-opencode-workspace: main` keeps creation on the
  normal non-Docker project.

The global config supports `workspace.default_directory` for servers that should
default to a specific starting directory.

## Uploads And Attachments

Upstream clients often send model-supported attachments directly in prompt
parts. This fork adds a streaming upload path for clients that need to place
large files into the session workspace without loading the whole file into
memory or sending it to the model provider.

- Endpoint: `POST /session/:sessionID/upload?path=<relative_path>`
- The request body is streamed to the session workspace.
- Existing target names are preserved by renaming the new file with a numeric
  suffix, such as `file (1).zip`.
- Upload paths are constrained to the session workspace and checked against
  symlink escape through parent validation.
- The response returns the workspace-relative path, `file:` URL, MIME type, and
  size.
- The web UI shows upload progress for large attachments.

Model-supported media, such as images or PDFs when the selected model supports
them, may still be sent as model media, but the file is also saved into the
workspace.

Unsupported large files should be uploaded into `/workspace` and referenced by
path in the prompt rather than converted into `data:` URLs.

## Web UI Additions

This fork adds web UI features that are not present upstream:

- Docker container name is visible in session context.
- A Docker management page is available at `/docker`.
- The Docker page shows workspace, latest session title, container name, status,
  RAM, image size, workspace size, and total disk usage.
- Containers can be started or hibernated from the UI.
- Auto-stop can be toggled per Docker workspace. The UI labels this as
  `Auto-stop on` or `Auto-stop off`.
- There is an auto-clean action for Docker workspaces whose `wrk_` container no
  longer has a matching session.
- Shell output triggered from the input box is shown expanded by default.
- The send button shows an active loading state while prompt submission is in
  progress.

## Container Lifecycle

Docker workspaces are persistent, but containers are hibernated when idle.

- Idle containers stop after five minutes by default.
- A stopped container is started again when the session or workspace is used.
- Auto-stop can be disabled per workspace when a container must keep running,
  for example while serving a site.
- Removing a Docker workspace removes both the container and its host-side
  workspace directory under `~/.local/share/opencode/docker-workspace`.

Image disk usage and workspace disk usage are reported together in the Docker
management UI.

## Compatibility Notes For Third-Party Clients

Third-party clients can keep using the normal OpenCode session APIs, but should
account for these fork-specific details:

- A new session may return a host-side session directory under
  `~/.local/share/opencode/docker-workspace/.../workspace`, while the agent
  sees the same files at `/workspace`.
- For large local files, prefer `POST /session/:sessionID/upload` and then send
  a prompt that references the returned path.
- Avoid sending very large `data:` URL prompt parts; mobile clients can run out
  of memory before the server receives the prompt.
- Use `workspace=main` only when host execution is wanted.
- If a client filters sessions by directory, use the configured default
  directory for project-level listing rather than the internal Docker workspace
  path.

## Provider Setup

This fork is commonly deployed with a custom CommandCode provider configuration.
That provider is not part of upstream OpenCode behavior and may be installed or
updated separately from the OpenCode server build.

## Operational Paths

Common paths used by this fork:

- Docker workspace data:
  `~/.local/share/opencode/docker-workspace`
- Docker image build cache:
  `~/.cache/opencode/docker-session-image`
- Shared Docker session cache:
  `~/.cache/opencode/docker-session-shared`
- Global Docker setup script:
  `~/.config/opencode/docker/setup.sh`
- Project Docker setup script:
  `.opencode/docker/setup.sh`

## Upstream Merge Notes

When merging from upstream, pay special attention to:

- session creation and listing
- workspace routing middleware
- permission defaults
- MCP process startup
- shell/tool execution paths
- file attachment and media handling
- web UI session timeline/event refresh logic
- generated SDK routes for experimental workspace endpoints

Those areas carry fork behavior that should not be overwritten accidentally.
