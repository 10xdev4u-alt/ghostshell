/**
 * Shared line-range types for the twin-view synchronization layer.
 *
 * The twin-view buffers the filtered serial stream into logical lines and
 * records the range of line indexes a tool call produced. The chat panel
 * renders those ranges as jump links.
 */

/** Inclusive range of serial line indexes. `end < start` means no output. */
export interface LineRange {
  start: number;
  end: number;
}

/** A line range bound to the tool call that produced it. */
export interface ToolLineRange extends LineRange {
  callId: string;
}
