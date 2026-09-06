import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { destructiveCommandRisks } from "./destructive-command-approval/rules.ts";

export { destructiveCommandRisks } from "./destructive-command-approval/rules.ts";

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
