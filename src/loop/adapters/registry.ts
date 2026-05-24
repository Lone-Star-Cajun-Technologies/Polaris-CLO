import type { ExecutionConfig } from '../../config/schema';
import { TerminalCliAdapter } from './terminal-cli';
import type { ExecutionAdapter } from './types';

const SUPPORTED_ADAPTERS = ['terminal-cli'] as const;

export function createAdapter(adapterName: string, config: ExecutionConfig): ExecutionAdapter {
  switch (adapterName) {
    case 'terminal-cli':
      return new TerminalCliAdapter(config);
    default:
      throw new Error(
        `Unknown adapter "${adapterName}". ` +
          `Supported adapters: ${SUPPORTED_ADAPTERS.join(', ')}. ` +
          `Future adapters (agent-subtask) will be added in a later cluster.`
      );
  }
}
