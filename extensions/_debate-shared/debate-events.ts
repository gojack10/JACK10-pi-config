/**
 * Shared event bus for debate-related events.
 * Both debate.ts and vega-tts-auto.ts import this to coordinate.
 */
import { EventEmitter } from "node:events";

class DebateEventBus extends EventEmitter {
  /** True while a debate is in progress. */
  active = false;
}

export const debateEvents = new DebateEventBus();
