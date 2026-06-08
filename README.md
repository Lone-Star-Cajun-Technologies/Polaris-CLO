<p align="center">
  <img src="https://raw.githubusercontent.com/ItIsYeBananaduck/Polaris/main/branding/assets/polaris-logo.png" alt="Polaris CLO" width="200" />
</p>

<h1 align="center">Polaris CLO</h1>
<p align="center"><strong>Command Line Orchestrator</strong></p>
<p align="center"><em>Navigate. Align. Orchestrate.</em></p>

---

Polaris is a taskchain orchestration framework for governed AI agent workflows. It dispatches, tracks, and finalizes implementation work across AI providers — keeping every run bounded, auditable, and connected to your issue tracker.

## Install

```bash
npm install -g @lsctech/polaris
```

Requires **Node.js 22+**.

## Quick Start

```bash
# Initialize Polaris in your repository
polaris init --adopt

# Check configuration
polaris doctor

# Start a governed run
polaris run POL-123

# Check status
polaris status

# Finalize completed work
polaris finalize
```

## Configuration

Polaris is configured via `polaris.config.json` at the repository root.

```json
{
  "version": "1.0",
  "repo": {
    "name": "my-project",
    "sourceRoots": ["src"]
  },
  "tracker": {
    "adapter": "github",
    "github": {
      "enabled": true,
      "owner": "my-org",
      "repo": "my-project",
      "labelPrefix": "status:"
    }
  }
}
```

## Tracker Adapters

| Adapter | Description |
|---|---|
| `github` | GitHub Issues — label-based lifecycle states, PAT auth |
| `linear` | Linear — team/project scoped, API key auth |
| `jira` | Jira Cloud — REST API v3, Basic auth |
| `local` | Local file graph only, no external sync |

Set credentials via environment variables:

```bash
export GITHUB_TOKEN=ghp_...
export LINEAR_API_KEY=lin_api_...
export JIRA_API_TOKEN=your_token
```

## Documentation

- **[Setup Guide](docs/SETUP.md)** — Installation, tracker configuration, environment variables
- **[Usage Guide](docs/USAGE.md)** — Daily workflow, commands, configuration reference, troubleshooting

## License

MIT — © LSC Technologies
