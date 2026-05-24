#!/usr/bin/env node
import { Command } from 'commander';
import { createLoopCommand } from './loop';

const program = new Command('polaris');

program
  .description('Polaris — taskchain orchestration runtime')
  .version('0.1.0', '-v, --version', 'Output the current version');

program.addCommand(createLoopCommand());

program.parse(process.argv);
