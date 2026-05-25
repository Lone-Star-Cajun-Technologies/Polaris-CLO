#!/usr/bin/env node
/**
 * polaris-tools — Codex plugin skill helper
 *
 * Exposes three tools backed by local Polaris CLI invocation.
 * Prints compact JSON to stdout. Never dumps full state files.
 *
 * Usage:
 *   node tools.js polaris_run <issue_id>
 *   node tools.js polaris_loop_continue [provider]
 *   node tools.js polaris_status
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── binary resolution ──────────────────────────────────────────────────────

/**
 * Returns { cmd, args } for the polaris binary, or null if not found.
 * Uses spawnSync with argument arrays — no shell interpolation.
 */
function findPolaris() {
  // 1. polaris on PATH
  const probe = spawnSync('polaris', ['--version'], { stdio: 'pipe', timeout: 5_000 });
  if (!probe.error) return { cmd: 'polaris', args: [] };

  // 2. npx polaris (project-local, no network fetch)
  const npxProbe = spawnSync('npx', ['--no-install', 'polaris', '--version'], {
    stdio: 'pipe',
    timeout: 10_000,
  });
  if (npxProbe.status === 0) return { cmd: 'npx', args: ['--no-install', 'polaris'] };

  return null;
}

function binaryError(tool) {
  return JSON.stringify({
    error:
      'polaris binary not found. Install via: npm link (from repo root) or npm install -g polaris',
    tool,
  });
}

// ── compact runner ─────────────────────────────────────────────────────────

/**
 * Runs a command safely using spawnSync with an explicit args array.
 * @param {string} cmd
 * @param {string[]} args
 */
function runSafe(cmd, args) {
  const result = spawnSync(cmd, args, {
    stdio: 'pipe',
    timeout: 120_000,
    encoding: 'utf8',
  });
  return {
    exit_code: result.status ?? 1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function truncate(str, max = 300) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + ' …(truncated)';
}

// ── tools ──────────────────────────────────────────────────────────────────

function polarisRun(issueId) {
  if (!issueId) {
    console.log(JSON.stringify({ error: 'issue_id is required', tool: 'polaris_run' }));
    process.exit(1);
  }
  const bin = findPolaris();
  if (!bin) { console.log(binaryError('polaris_run')); process.exit(1); }

  const { exit_code, stdout, stderr } = runSafe(bin.cmd, [...bin.args, 'run', issueId]);
  console.log(
    JSON.stringify({
      tool: 'polaris_run',
      issue_id: issueId,
      exit_code,
      summary: truncate(stdout || stderr),
    })
  );
  process.exit(exit_code === 0 ? 0 : 1);
}

function polarisLoopContinue(provider) {
  const bin = findPolaris();
  if (!bin) { console.log(binaryError('polaris_loop_continue')); process.exit(1); }

  const extraArgs = provider ? ['loop', 'continue', '--provider', provider] : ['loop', 'continue'];
  const { exit_code, stdout, stderr } = runSafe(bin.cmd, [...bin.args, ...extraArgs]);
  console.log(
    JSON.stringify({
      tool: 'polaris_loop_continue',
      provider: provider || null,
      exit_code,
      summary: truncate(stdout || stderr),
    })
  );
  process.exit(exit_code === 0 ? 0 : 1);
}

function polarisStatus() {
  const bin = findPolaris();

  // Try `polaris loop status` first
  if (bin) {
    const { exit_code, stdout } = runSafe(bin.cmd, [...bin.args, 'loop', 'status']);
    if (exit_code === 0 && stdout) {
      console.log(
        JSON.stringify({ tool: 'polaris_status', exit_code, summary: truncate(stdout, 600) })
      );
      process.exit(0);
    }
  }

  // Fall back: read current-state.json and emit compact summary
  const stateFile = path.join(
    process.cwd(),
    '.taskchain_artifacts',
    'polaris-run',
    'current-state.json'
  );
  if (!fs.existsSync(stateFile)) {
    console.log(
      JSON.stringify({
        tool: 'polaris_status',
        error: 'No current-state.json found and polaris loop status unavailable',
      })
    );
    process.exit(1);
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    console.log(
      JSON.stringify({
        tool: 'polaris_status',
        error: `Failed to parse current-state.json: ${e.message}`,
      })
    );
    process.exit(1);
  }

  // Compact summary — never dump the full state
  console.log(
    JSON.stringify({
      tool: 'polaris_status',
      run_id: state.run_id,
      status: state.status,
      active_child: state.active_child,
      completed_children: state.completed_children,
      open_children: state.open_children,
      last_commit: state.last_commit,
      updated_at: state.updated_at,
    })
  );
  process.exit(0);
}

// ── dispatch ───────────────────────────────────────────────────────────────

const [, , tool, ...rest] = process.argv;

switch (tool) {
  case 'polaris_run':
    polarisRun(rest[0]);
    break;
  case 'polaris_loop_continue':
    polarisLoopContinue(rest[0]);
    break;
  case 'polaris_status':
    polarisStatus();
    break;
  default:
    console.log(
      JSON.stringify({
        error: `Unknown tool: "${tool}". Valid tools: polaris_run, polaris_loop_continue, polaris_status`,
      })
    );
    process.exit(1);
}
