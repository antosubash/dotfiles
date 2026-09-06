export const MAX_PARALLEL_TASKS = 8;
export const MAX_CHAIN_STEPS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
// Capture has separate finite transport, line, transcript, and stderr budgets.
// Progress/delta traffic must not exhaust the retained-result allowance.
export const TERMINATION_GRACE_MS = 5000;
// A descendant can keep inherited stdout/stderr open after the process-tree
// kill has completed. Never wait indefinitely for `close` in that case.
export const TERMINATION_SETTLEMENT_DEADLINE_MS = 10000;
