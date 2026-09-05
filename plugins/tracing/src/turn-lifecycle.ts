const TERMINAL_EVENT_TYPES = new Set(["task_complete", "turn_aborted"]);

export function isTerminalTurnEvent(eventType: string | undefined): boolean {
  return TERMINAL_EVENT_TYPES.has(eventType ?? "");
}
