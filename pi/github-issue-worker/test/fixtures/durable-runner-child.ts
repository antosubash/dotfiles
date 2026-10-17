// Child process for the crash test: starts a run whose first tool call is a long bash command, so the parent
// can SIGKILL this process mid-call and resume the run from the same session store.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxRunner } from "../helpers/durable-runner.js";

const [root, prompt] = process.argv.slice(2) as [string, string];
const { run } = await fauxRunner(root, [
  fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30; echo slept" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("child should never answer"),
]);
await run(prompt);
