import type { ReviewPacket } from "../governance/types.js";

export function filterUndecided(packets: ReviewPacket[]): ReviewPacket[] {
  return packets.filter(
    (p) => p.reviewDecision === undefined || p.reviewDecision === "defer",
  );
}

export function formatPacketCard(
  packet: ReviewPacket,
  index: number,
  total: number,
): string {
  const divider = "─".repeat(65);
  return [
    divider,
    `[${index}/${total}] ${packet.sourcePath}`,
    `  → ${packet.proposedDestination}`,
    `  Authority risk:  ${packet.authorityRisk.toUpperCase()}`,
    `  Recommendation:  ${packet.recommendation}`,
    ``,
    `[a]pprove  [r]eject  [d]efer  [s]kip  [q]uit`,
    divider,
  ].join("\n");
}
