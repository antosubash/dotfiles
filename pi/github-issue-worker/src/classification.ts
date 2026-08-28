import type { GitHubIssue } from "./types.js";

export type IssueCategory =
  | "runtime-content"
  | "component-ui"
  | "source-page"
  | "integrated-ui"
  | "backend-only";

export function classifyIssue(issue: GitHubIssue): IssueCategory {
  const text = `${issue.title}\n${issue.body}\n${issue.labels.map((label) => label.name).join(" ")}`;
  const ui = /\b(?:ui|visual|mobile|desktop|responsive|css|style|layout|spacing|height|width|font|figma|component|widget|page|header|card)\b/i.test(text);
  const integration = /\b(?:api|backend|database|auth|login|permission|tenant resolution|server|worker|job|upload|websocket)\b/i.test(text);
  const codeSurface = /\b(?:css|class|design token|stylesheet|responsive|breakpoint|typescript|react|code)\b/i.test(text);
  const runtimeContent = /\b(?:content only|cms content|runtime-managed|editor|page builder|copy change|translation text|slug)\b/i.test(text);
  const sourcePage = /\b(?:checked-in content|source-backed|mdx|markdown|static page|page content)\b/i.test(text);

  if (runtimeContent && !codeSurface) return "runtime-content";
  if (ui && integration) return "integrated-ui";
  if (ui && (codeSurface || /\b(?:size|height|width|gap|spacing|align)/i.test(text))) {
    return "component-ui";
  }
  if (ui || sourcePage) return "source-page";
  return "backend-only";
}
