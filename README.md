# Polaris

Polaris — standalone taskchain orchestration framework for governed AI agent workflows.

## Quickstart

### Local Install

For development and local use:

```bash
# Clone the repository
git clone <repository-url>
cd polaris

# Install dependencies
npm install

# Build the project
npm run build

# Run Polaris commands
npx polaris --help
```

### Global Install

For system-wide availability:

```bash
# From the repository root
npm install -g .

# Then run from anywhere
polaris --help
```

## First Run

### Initialize a New Repository

```bash
# Initialize Polaris in your current repository
polaris init

# Or adopt an existing repository with Polaris governance
polaris init --adopt
```

### Check Configuration Readiness

```bash
# Verify your Polaris configuration and environment
polaris config doctor
```

The config doctor command checks:
- Config file validity (`polaris.config.json`)
- Provider configuration (if using external agents)
- Tracker adapter setup (if using Linear or other trackers)
- Artifact hygiene and directory structure

### First Governed Run

After initialization and passing the config doctor check:

```bash
# Start a governed run (supervised mode by default)
polaris loop start

# Or run in auto mode for full automation
polaris loop start --mode auto
```

## Core Commands

- `polaris init` — Initialize Polaris in a repository
- `polaris init --adopt` — Adopt an existing repository
- `polaris config doctor` — Check configuration readiness
- `polaris config show` — Display resolved configuration
- `polaris loop start` — Start a governed run
- `polaris status` — Show current run state
- `polaris finalize` — Finalize a completed run

## Configuration

Polaris is configured via `polaris.config.json` in your repository root. Run `polaris config show` to see the resolved configuration after defaults are applied.

## Documentation

See `POLARIS.md` for operational guidance and `AGENTS.md` for agent role definitions.

## License

MIT
