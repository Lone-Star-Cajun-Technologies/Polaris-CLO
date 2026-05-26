#!/usr/bin/env node
/**
 * polaris-tools — Codex plugin skill helper
 *
 * Exposes compact read-only helpers backed by local Polaris CLI invocation.
 * Prints compact JSON to stdout. Never dumps full state files.
 *
 * Usage:
 *   node tools.js polaris_status
 *   node tools.js polaris_loop_status
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
  if (probe.status === 0 && !probe.error) return { cmd: 'polaris', args: [] };

  // 2. npx polaris (project-local, no network fetch)
  const npxProbe = spawnSync('npx', ['--no-install', 'polaris', '--version'], {
    stdio: 'pipe',
    timeout: 10_000,
  });
  if (npxProbe.status === 0) return { cmd: 'npx', args: ['--no-install', 'polaris'] };

  return null;
}

function binaryError(tool) {
  return {
    error:
      'polaris binary not found. Install via: npm link (from repo root) or npm install -g polaris',
    tool,
  };
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
  return str.slice(0, max) + ' ...(truncated)';
}

// ── tools ──────────────────────────────────────────────────────────────────

function printJson(value, exitCode = 0) {
  console.log(JSON.stringify(value));
  process.exit(exitCode);
}

function operatorOnly(tool, cliEquivalent) {
  printJson(
    {
      tool,
      error: 'operator_only',
      message:
        `${cliEquivalent} is mutating or deferred and is not exposed as a casual Codex plugin helper. Use the governed operator workflow with an explicit approval boundary.`,
    },
    1
  );
}

function compactState(tool, state) {
  return {
    tool,
    run_id: state.run_id,
    cluster_id: state.cluster_id,
    status: state.status,
    active_child: state.active_child || null,
    next_open_child: state.next_open_child ?? null,
    completed_children: Array.isArray(state.completed_children) ? state.completed_children : [],
    open_children: Array.isArray(state.open_children) ? state.open_children : [],
    updated_at: state.updated_at,
  };
}

function compactCliStatus(tool, exit_code, stdout, stderr) {
  if (exit_code !== 0) {
    return {
      tool,
      exit_code,
      error: 'polaris status command failed',
      summary: truncate(stderr || stdout, 600),
    };
  }

  try {
    return {
      ...compactState(tool, JSON.parse(stdout)),
      exit_code,
    };
  } catch {
    return { tool, exit_code, summary: truncate(stdout || stderr, 600) };
  }
}

function statusFromStateFile(tool) {
  const stateFile = path.join(
    process.cwd(),
    '.taskchain_artifacts',
    'polaris-run',
    'current-state.json'
  );
  if (!fs.existsSync(stateFile)) return null;

  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return compactState(tool, state);
  } catch (e) {
    return {
      tool,
      error: `Failed to parse current-state.json: ${e.message}`,
    };
  }
}

function polarisStatus(tool, cliArgs) {
  const bin = findPolaris();

  if (bin) {
    const { exit_code, stdout, stderr } = runSafe(bin.cmd, [...bin.args, ...cliArgs]);
    const result = compactCliStatus(tool, exit_code, stdout, stderr);
    printJson(result, exit_code === 0 ? 0 : 1);
  }

  const fallback = statusFromStateFile(tool);
  if (fallback) {
    printJson(fallback, fallback.error ? 1 : 0);
  }

  printJson(binaryError(tool), 1);
}

function unknownTool(tool) {
  console.log(
    JSON.stringify({
      error: `Unknown tool: "${tool}". Valid tools: polaris_status, polaris_loop_status. Operator-only legacy names: polaris_run, polaris_loop_continue`,
    })
  );
  process.exit(1);
}

// ── dispatch ───────────────────────────────────────────────────────────────

const [, , tool, ...rest] = process.argv;

switch (tool) {
  case 'polaris_run':
    operatorOnly('polaris_run', 'polaris run <issue_id>');
    break;
  case 'polaris_loop_continue':
    operatorOnly('polaris_loop_continue', 'polaris loop continue');
    break;
  case 'polaris_status':
    polarisStatus('polaris_status', ['status', '--json']);
    break;
  case 'polaris_loop_status':
    polarisStatus('polaris_loop_status', ['loop', 'status', '--json']);
    break;
  default:
    unknownTool(tool);
}
