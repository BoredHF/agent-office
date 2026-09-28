# Deploy Agent Office with Dokploy

This fork includes a production Docker image and Compose configuration. It runs
one office process, plus the workers it starts, as the unprivileged `node` user.
Claude Code, OpenCode and Codex are installed in the image. Projects, office data,
provider logins and session histories live in a named volume mounted at
`/home/node`; application code and CLI binaries are outside that volume.

## Dokploy setup

1. Create a project and add a **Compose** service with type **Docker Compose**.
2. Select your GitHub fork, branch `main`, and Compose path
   `./docker-compose.yml`. With the Git provider, use
   `https://github.com/BoredHF/agent-office.git`.
3. Paste [dokploy.env.example](dokploy.env.example) into **Environment**.
   Set a long random `AGENT_OFFICE_PASSWORD` (for example, generate one with
   `openssl rand -hex 32`). Set `GH_TOKEN`, `GIT_USER_NAME` and
   `GIT_USER_EMAIL` for repository work. Configure the credentials for the agent
   you intend to use; the default agent is Claude.
4. Under **Domains**, add your hostname, select service `agent-office`,
   set container port **4600** and path **/**, and enable HTTPS with Let's Encrypt.
   Point the hostname's DNS record at the Dokploy server.
5. Deploy. The health check is `/api/health`. Open your HTTPS domain, sign in with
   the office password, and use the elevator to select the first repository.
6. Create your own administrator account and invite teammates using the app's
   **Accounts** panel.

Dokploy adds the Traefik labels and network for the selected domain. The Compose
file intentionally has no published host port: HTTP and WebSockets reach the
container through Traefik. The office listens on `0.0.0.0:4600` and trusts the
proxy's forwarded headers. HTTPS is required for voice and screen sharing away
from localhost. Restrictive networks may also need a TURN server configured
with the upstream `--turn` option.

The Compose file explicitly maps the supported environment variables into the
container. Adding a new variable to Dokploy's Environment tab alone does not
inject it; add it under `environment:` in the Compose file too.

## Agent and GitHub authentication

- **GitHub:** use `GH_TOKEN` with access only to the repositories the office needs.
  The entrypoint configures `gh` as Git's credential helper, so private clones and
  pushes work without putting tokens in remote URLs. GitHub authentication inside
  the office is separate from Dokploy's GitHub connection.
- **Claude Code:** configure either `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`, or sign in interactively with the CLI. Complete any
  provider onboarding or workspace-trust prompts in its terminal.
- **OpenCode / Codex:** use Dokploy's terminal for the `agent-office` container
  to run the provider's sign-in flow. The entire user home is persistent, including
  `.claude`, `.claude.json`, `.codex`, `.config` and `.local/share`.
  You can set `AGENT_OFFICE_AGENT=opencode` or `codex` to change the default.

The CLIs are installed globally in the image. Changing a Dockerfile version
argument and redeploying updates them without hiding new binaries behind a
persistent volume. No provider API calls are made by the container smoke test.

Users who can enter the office can run commands in its containers and read the
credentials available there. Invite trusted teammates. The image uses a non-root
user and does not mount the Docker socket or host directories.

## Storage, updates and resources

The `agent-office-home` named volume contains:

- `agent-office/.agent-office/`: accounts, signing secret, floors, chat and office settings.
- `projects/<owner>/<repo>/`: project checkouts, worktrees and per-floor state.
- Provider configuration, authentication files and session histories in the user's home.

Back up this volume through Dokploy's Volume Backups. It contains credentials as
well as source code, so keep backups private. Redeployments reuse the volume.
Deleting the volume discards these files. If substituting a bind mount, its
directory must be writable by UID/GID `1000:1000`.

Use a single replica: the application stores local state and owns live terminals.
A container replacement stops running workers; saved sessions and scrollback can
resume afterwards. Updates should go through Dokploy by rebuilding the image.
The app's in-place self-update is disabled for this image.

The default worker ceiling is three. Increase `AGENT_OFFICE_MAX_WORKERS` only
after checking actual CPU and memory use; worker builds and tests determine much
of the capacity required. Upstream's AWS example uses 4 vCPU and 16 GiB RAM, which
is an example configuration rather than a documented minimum.

## Local preview

Copy `deploy/dokploy.env.example` to `.env` and fill in your values, then run:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.local.yml up --build -d
```

Open http://localhost:4600. The local override binds only to loopback.
Select only the root `docker-compose.yml` in Dokploy.

## Verification

```bash
docker build --target test --tag agent-office:test .
bash deploy/test-docker.sh
```

The first command runs upstream type checks and tests. The second builds the
production image in an isolated Compose project, checks non-root execution and
all installed CLI binaries, creates a real PTY, signs in through simulated HTTPS
proxy headers, exercises an authenticated WebSocket, and replaces the container.
It then verifies that the existing login and chat history survived. It removes
only its own temporary Compose project and test volume.

The **Container** GitHub Actions workflow runs the same checks. If GitHub disables
Actions on a newly created fork, enable workflows in that fork's **Actions** tab.

References: [Dokploy Compose](https://docs.dokploy.com/docs/core/docker-compose),
[Dokploy domains](https://docs.dokploy.com/docs/core/docker-compose/domains),
[upstream VPS hosting](https://github.com/AgentSystemLabs/agent-office#running-it-on-a-vps-for-your-team).
