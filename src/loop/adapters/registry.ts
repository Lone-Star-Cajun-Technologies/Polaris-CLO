import type { ExecutionConfig } from "../../config/schema.js";
import { AgentSubtaskAdapter } from "./agent-subtask.js";
import { TerminalCliAdapter } from "./terminal-cli.js";
import { PaperclipAdapter } from "./paperclip.js";
import type { ExecutionAdapter } from "./types.js";

const SUPPORTED_ADAPTERS = ['terminal-cli', 'agent-subtask', 'paperclip'] as const;

export function createAdapter(adapterName: string, config: ExecutionConfig): ExecutionAdapter {
  switch (adapterName) {
    case 'terminal-cli':
      return new TerminalCliAdapter(config);
    case 'agent-subtask':
      return new AgentSubtaskAdapter();
    case 'paperclip': {
      const pcConfig = config.paperclip;
      if (pcConfig?.enabled !== true) {
        throw new Error(
          'Paperclip adapter is disabled. Set execution.paperclip.enabled to true before selecting it.',
        );
      }
      // The enabled gate is checked before construction; a missing token then
      // remains a dispatch-time fail-closed precondition.
      const resolvedToken = process.env[pcConfig.tokenEnv]?.trim() ?? undefined;
      return new PaperclipAdapter({
        ...pcConfig,
        resolvedToken,
      });
    }
    default:
      throw new Error(
        `Unknown adapter "${adapterName}". ` +
          `Supported adapters: ${SUPPORTED_ADAPTERS.join(', ')}.`
      );
  }
}
