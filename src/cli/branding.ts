/**
 * Centralized Polaris CLO branding strings and terminal banner.
 * All brand copy lives here — change once, applies everywhere.
 */

export const BRAND = {
  name: "Polaris CLO",
  fullName: "POLARIS CLO",
  subtitle: "Command Line Orchestrator",
  tagline: "Navigate · Align · Orchestrate",
  pkg: "@lsctech/polaris",
} as const;

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const CYAN = `${ESC}[36m`;
const BRIGHT_BLUE = `${ESC}[94m`;

/**
 * Returns the startup banner string.
 * Strips ANSI codes when stdout is not a TTY (e.g. pipes, CI).
 */
export function getBanner(forceColor = false): string {
  const color = forceColor || (process.stdout.isTTY ?? false);

  const star   = color ? `${BRIGHT_BLUE}✦${RESET}` : "✦";
  const title  = color ? `${BOLD}${CYAN}POLARIS CLO${RESET}` : "POLARIS CLO";
  const sub    = color ? `${DIM}${BRAND.subtitle}${RESET}` : BRAND.subtitle;
  const tag    = color ? `${DIM}${BRAND.tagline}${RESET}` : BRAND.tagline;
  const rule   = color ? `${DIM}${"─".repeat(38)}${RESET}` : "─".repeat(38);

  return [
    "",
    `  ${star}  ${title}`,
    `  ${rule}`,
    `  ${sub}`,
    `  ${tag}`,
    "",
  ].join("\n");
}
