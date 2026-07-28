# Polaris Setup Guide

Polaris is a taskchain orchestration framework for governed AI agent workflows. This guide covers installation, configuration, and connecting Polaris to your issue tracker.

---

## Prerequisites

- **Node.js** 22 or higher
- **Git** (Polaris works inside a Git repository)
- An issue tracker account (Linear, GitHub, or Jira Cloud) — or run tracker-free in local mode

---

## Installation

### From npm (recommended)

```bash
npm install -g @lsctech/polaris
```

Verify the install:

```bash
polaris --version
```

### From source

```bash
git clone https://github.com/lsctech/polaris.git
cd polaris
npm install
npm run build
npm link   # makes `polaris` available globally
```

---

## Transferring the Repository to Your Organization

If you are migrating the Polaris repo to a GitHub organization before distribution:

1. Go to the repository on GitHub → **Settings** → **General**
2. Scroll to **Danger Zone** → click **Transfer**
3. Enter the repository name to confirm, then enter the destination organization (e.g. `lsctech`)
4. Click **I understand, transfer this repository**

After transfer, update the remote in any local clones:

```bash
git remote set-url origin https://github.com/lsctech/polaris.git
```

---

## Initializing a Repository

Inside any Git repository, run:

```bash
polaris init --adopt
```

This will:
- Scan your source tree and generate a `polaris.config.json`
- Create a `.polaris/` directory for run state, map artifacts, and cognition notes
- Add runtime directories to `.gitignore`
- Stage adoption outputs ready for commit

For a dry run (no writes):

```bash
polaris init --adopt --dry-run
```

---

## Configuration (`polaris.config.json`)

Polaris is configured via `polaris.config.json` at the repo root. A minimal config:

```json
{
  "version": "1.0",
  "repo": {
    "name": "my-project",
    "sourceRoots": ["src"]
  }
}
```

Run the config doctor at any time to check for issues:

```bash
polaris doctor
```

### Provider routing and compatibility mode

Polaris dispatches in one of two modes, controlled by `execution.routerPolicy.providerRegistry`:

- **Compatibility mode** (default): the registry is empty or missing. `providerPolicy.<role>.providers` is the provider preference/fallback order; unless `execution.rotation` is configured, the first configured provider allowed by the role policy is selected. Because the router engine is not engaged, `providers_tried` contains only that selected provider.
- **Router mode**: the registry is present. The router builds a full ordered, scored candidate list from the registry metadata and `providerPolicy.<role>.providers` acts as an eligibility filter. `providers_tried` contains the ordered candidate list, and the adapter may try the next candidate on a pre-dispatch failure.

To enable router mode, populate `execution.routerPolicy.providerRegistry` with at least `eligibleRoles` for each provider.

---

### Parallel Paperclip dispatch

When `execution.routerPolicy.parallelPaperclip` is `true`, the parent loop may dispatch up to `execution.routerPolicy.defaultWorkerPool.maxActiveWorkers` Paperclip children concurrently. When absent or `false`, dispatch remains fully serial.

**Resumability limitation (v1):** if the parent process crashes mid-batch, Polaris resumes from the persisted cluster/run state, but in-flight Paperclip children continue running independently. The parent cannot reattach to or cancel those children on resume; it can only pick up remaining unstarted children. Track terminal Paperclip issue status manually to avoid orphaned assignments.

---

## Execution Adapters

Polaris supports multiple execution backends. The default is `terminal-cli`, where Polaris shells out to a local CLI. If you need a governed adapter that talks to an external runtime, use `paperclip` for the execution adapter.

> Note: The `paperclip` adapter configures **execution**, not your issue tracker. Tracker selection stays under the `tracker` block and is unrelated to `execution.adapter`.

### Paperclip execution adapter

The Paperclip adapter dispatches child work to a Paperclip-managed company/agent instead of running local CLIs. It requires a shared workspace that both Polaris and Paperclip can access.

1. Make sure the target Paperclip server or company runner and this Polaris checkout share the same working directory or can reach a shared filesystem path.
2. Confirm your Paperclip company ID, the assignee agent ID for this repo, and any required token/runID environment variables are available in the operator environment.
3. Add the execution config to `polaris.config.json`:

```json
{
  "execution": {
    "adapter": "paperclip",
    "paperclip": {
      "baseUrl": "http://127.0.0.1:3100",
      "companyId": "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
      "assigneeAgentId": "39f35fc9-5434-4226-83e3-a435809aac81",
      "tokenEnv": "PAPERCLIP_API_KEY",
      "runIdEnv": "PAPERCLIP_RUN_ID"
    }
  }
}
```

4. Set the environment variables the adapter needs. For a Paperclip-backed runtime these typically include the API token and run ID values used by the operator. Use whatever local secret manager your org prefers; do not hardcode them in `polaris.config.json`.

```bash
export PAPERCLIP_API_KEY=...
export PAPERCLIP_RUN_ID=...
```

### Shared workspace requirement

Paperclip execution writes and reads run artifacts on disk. Operators must ensure:

- The paperclip-backed process can create and edit files in the Polaris repo.
- Concurrent runs/runners can participate in the same filesystem workspace if the operator uses shared dispatch behavior.
- Rollback remains straightforward if the paperclip runtime becomes unreachable; the working tree should remain valid for switching back to a local or CLI adapter.

### Dry-run / mock test path

Before depending on Paperclip for live dispatch, verify routing shape with a smaller probe or mock run packet. The validator and exec-adapter layers already warn when adapter config is malformed; use `polaris doctor` plus a single control child first.

### Timeout and recovery

- The Paperclip-backed run is bounded by Polaris run timeouts plus the operator's Paperclip timeout/retry behavior.
- If a dispatch or heartbeat fails, check `.polaris/runs/<run-id>/current-state.json` and rerun with `polaris run <issue> --resume`.
- For immediate rollback to local execution: set `execution.adapter` back to `terminal-cli` or `agent-subtask` in `polaris.config.json`.

## Tracker Adapters

Polaris is tracker-agnostic. Choose one of the following adapters, or omit the `tracker` block to run in local-only mode.

---

### Linear

1. Generate a Linear API key: **Linear Settings** → **API** → **Personal API Keys**
2. Find your team ID and (optional) project ID from the Linear URL or API
3. Add to `polaris.config.json`:

```json
{
  "tracker": {
    "adapter": "linear",
    "linear": {
      "enabled": true,
      "teamId": "YOUR_TEAM_ID",
      "projectId": "YOUR_PROJECT_ID"
    }
  }
}
```

4. Set your API key as an environment variable:

```bash
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxx
```

---

### GitHub Issues

GitHub Issues uses your repository's issue tracker with label-based lifecycle states.

1. Create a GitHub personal access token with `repo` scope at **GitHub Settings** → **Developer settings** → **Personal access tokens**
2. Add to `polaris.config.json`:

```json
{
  "tracker": {
    "adapter": "github",
    "github": {
      "enabled": true,
      "owner": "lsctech",
      "repo": "my-project",
      "labelPrefix": "status:"
    }
  }
}
```

3. Set your token:

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

**Lifecycle labels** — Polaris will create and manage labels with the prefix you configure (default `status:`):

| Label | Lifecycle state |
|---|---|
| `status:in-progress` | In progress |
| `status:in-review` | In review |
| `status:blocked` | Blocked |
| `status:done` | Closed (issue closed) |

---

### Jira Cloud

1. Generate an Atlassian API token at: https://id.atlassian.com/manage-profile/security/api-tokens
2. Find your Jira Cloud base URL (e.g. `https://lsctech.atlassian.net`) and your project key
3. Add to `polaris.config.json`:

```json
{
  "tracker": {
    "adapter": "jira",
    "jira": {
      "enabled": true,
      "baseUrl": "https://lsctech.atlassian.net",
      "email": "you@lsctech.biz",
      "projectKey": "POL"
    }
  }
}
```

4. Set your API token:

```bash
export JIRA_API_TOKEN=your_token_here
```

Polaris maps Jira status names to its normalized lifecycle states automatically using common patterns. To override a specific mapping:

```json
{
  "tracker": {
    "jira": {
      "statusMappings": {
        "Awaiting Review": "in_review",
        "Dev Complete": "done"
      }
    }
  }
}
```

---

### Local Mode (no tracker)

Omit the `tracker` block entirely. Polaris will use its local file-backed graph and no external sync will occur.

---

## Running Polaris

```bash
# Start or continue the active run
polaris run

# Check run and tracker status
polaris status

# Finalize the current run (create PR, reconcile tracker)
polaris finalize

# Inspect the current run's active cluster
polaris status --verbose
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `LINEAR_API_KEY` | When using Linear | Linear personal API key |
| `GITHUB_TOKEN` | When using GitHub | GitHub PAT with `repo` scope |
| `JIRA_API_TOKEN` | When using Jira | Atlassian API token |
| `POLARIS_NATIVE_SUBTASK_PROVIDER` | Optional | Override CLI subtask provider (`copilot`, `codex`) |

---

## Publishing to npm

```bash
# Build and test, then publish
npm publish --access public
```

The `prepublishOnly` script runs `npm run build && npm test` automatically before publish.
