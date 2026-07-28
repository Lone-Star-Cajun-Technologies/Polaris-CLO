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
      // When config.paperclip is absent the adapter is still constructed but
      // resolvedToken will be undefined, causing dispatch() to fail closed
      // (exit_code: 2, pre_dispatch_failure: true) rather than throwing here.
      const resolvedToken = pcConfig ? (process.env[pcConfig.tokenEnv]?.trim() ?? undefined) : undefined;
      return new PaperclipAdapter({
        baseUrl: pcConfig?.baseUrl ?? "",
        companyId: pcConfig?.companyId ?? "",
        assigneeAgentId: pcConfig?.assigneeAgentId ?? "",
        tokenEnv: pcConfig?.tokenEnv ?? "",
        runIdEnv: pcConfig?.runIdEnv ?? "",
        ...(pcConfig ?? {}),
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
