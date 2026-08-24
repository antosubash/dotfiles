import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type RiskRule = {
  description: string;
  pattern: RegExp;
};

const RISK_RULES: RiskRule[] = [
  // `rm -f` is routine idempotent cleanup; prompt only when deletion is recursive.
  { description: "recursive file deletion", pattern: /\brm\b[^\n;&|]*(?:-[a-z]*r[a-z]*|--recursive)\b/i },
  { description: "find command deleting files", pattern: /\bfind\b[^\n;&|]*\s-delete\b/i },
  { description: "privileged command", pattern: /(^|[;&|]\s*|\s)sudo\s/i },
  { description: "discarding Git working-tree or index changes", pattern: /\bgit\s+(?:reset\s+--hard|clean\b[^\n;&|]*(?:-[a-z]*f|--force)|checkout\s+--\s+[.]|restore\s+(?:--worktree\s+)?(?:[.]|:\/))/i },
  { description: "force-pushing Git history", pattern: /\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?|-f)\b/i },
  { description: "recursive ownership or permission change", pattern: /\b(?:chmod|chown)\b[^\n;&|]*(?:-R|--recursive)\b/i },
  { description: "disk or filesystem overwrite", pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted|shred)\b|\bdd\b[^\n;&|]*\bof=/i },
  { description: "infrastructure destruction", pattern: /\bterraform\s+(?:destroy|apply\b[^\n;&|]*-destroy)\b|\b(?:kubectl\s+delete|helm\s+uninstall)\b/i },
  { description: "broad Docker cleanup", pattern: /\bdocker\s+(?:system|volume|network)\s+prune\b|\bdocker\s+rm\b[^\n;&|]*\s-f\b/i },
  { description: "database object or data deletion", pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i },
  { description: "forced process termination", pattern: /\b(?:kill\s+-9|pkill\b|killall\b)/i },
];

export function destructiveCommandRisks(command: string): string[] {
  return RISK_RULES
    .filter(({ pattern }) => pattern.test(command))
    .map(({ description }) => description);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    const risks = destructiveCommandRisks(command);

    if (risks.length === 0) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Command requires interactive approval: ${risks.join(", ")}`,
      };
    }

    const approved = await ctx.ui.confirm(
      "Approve destructive command?",
      `${risks.join("; ")}\n\n${command}`,
    );

    if (!approved) {
      return { block: true, reason: "Destructive command rejected by user" };
    }
  });
}
