import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextPolicy } from "./policy.ts";

export default function (pi: ExtensionAPI): void {
	registerContextPolicy(pi, {
		// Read the normal merged settings instead of ignoring /settings or a
		// trusted project's explicit compaction.enabled=false. No settings writes.
		enabled: (ctx) => SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionEnabled(),
	});
}
