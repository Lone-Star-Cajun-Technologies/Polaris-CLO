#!/usr/bin/env node

const [, , cmd, ...rest] = process.argv;

function usage(): void {
  console.log('Usage: polaris <command> [subcommand]');
  console.log('');
  console.log('Commands:');
  console.log('  run                  Start or resume a Polaris run');
  console.log('  loop continue        Advance the current taskchain loop');
  console.log('  loop status          Print current loop state');
  console.log('  status               Alias for loop status');
  process.exit(1);
}

switch (cmd) {
  case 'run':
    console.log('[polaris] run — not yet implemented (Cluster 4)');
    break;

  case 'loop': {
    const sub = rest[0];
    if (sub === 'continue') {
      console.log('[polaris] loop continue — not yet implemented (Cluster 4)');
    } else if (sub === 'status') {
      console.log('[polaris] loop status — not yet implemented (Cluster 4)');
    } else {
      console.error(`Unknown loop subcommand: ${sub ?? '(none)'}`);
      usage();
    }
    break;
  }

  case 'status':
    console.log('[polaris] status — not yet implemented (Cluster 4)');
    break;

  default:
    if (!cmd) {
      usage();
    } else {
      console.error(`Unknown command: ${cmd}`);
      usage();
    }
}
