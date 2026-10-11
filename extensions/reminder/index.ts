/**
 * Midnight Reminder Pi extension.
 *
 * Emits a bedtime reminder once per local date while local time is inside the
 * `[00:00, 06:00)` window. Scheduling is interactive-only, checks every 30
 * seconds (including while Pi is idle), and is cleaned up on session shutdown.
 *
 * The time policy itself lives in `src/reminder.ts`; this file only adapts it
 * to Pi's lifecycle and UI. See MIDNIGHT_REMINDER_PLAN.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateReminder, type ReminderState } from "../../src/reminder.ts";

type ReminderMode = ExtensionContext["mode"];
type TimerHandle = ReturnType<typeof setInterval> | number;

/** Exact user-visible reminder text. */
export const REMINDER_MESSAGE =
	"It is after midnight. Consider saving your work and getting some sleep.";

/** How often the local time is checked while a session is active. */
export const CHECK_INTERVAL_MS = 30_000;

/** Injectable runtime seams for tests (fake timers / simulated clock). */
export interface ReminderDeps {
	now?: () => Date;
	setIntervalFn?: (handler: () => void, ms: number) => TimerHandle;
	clearIntervalFn?: (handle: TimerHandle) => void;
}

export interface MidnightReminderController {
	/** Arm the reminder for a session. No-op in non-interactive modes. */
	startSession(ctx: Pick<ExtensionContext, "mode" | "ui">): void;
	/** Clear the timer and reset per-session state. Idempotent. */
	handleShutdown(): void;
	/** Preview the reminder. Never changes automatic reminder state. */
	preview(ctx: Pick<ExtensionContext, "mode" | "ui">): void;
}

function isInteractiveMode(mode: ReminderMode): boolean {
	return mode === "tui";
}

/**
 * Build a session-scoped reminder controller. Kept free of module-level
 * timers so a fresh controller can be created per extension runtime.
 */
export function createMidnightReminder(deps: ReminderDeps = {}): MidnightReminderController {
	const now = deps.now ?? (() => new Date());
	const schedule = deps.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
	const cancel =
		deps.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

	let state: ReminderState = { remindedDate: null };
	let timer: TimerHandle | null = null;

	function deliver(ctx: Pick<ExtensionContext, "ui">): void {
		ctx.ui.notify(REMINDER_MESSAGE, "info");
	}

	function check(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
		if (!isInteractiveMode(ctx.mode)) return;
		const decision = evaluateReminder(now(), state);
		state = decision.state;
		if (decision.remind) deliver(ctx);
	}

	function clearTimer(): void {
		if (timer !== null) {
			cancel(timer);
			timer = null;
		}
	}

	function startSession(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
		if (!isInteractiveMode(ctx.mode)) return;
		// Clear any prior timer so an extension reload cannot duplicate timers.
		clearTimer();
		// A new session starts with fresh once-per-date bookkeeping.
		state = { remindedDate: null };
		check(ctx);
		timer = schedule(() => check(ctx), CHECK_INTERVAL_MS);
		(timer as { unref?: () => void }).unref?.();
	}

	function handleShutdown(): void {
		clearTimer();
		state = { remindedDate: null };
	}

	function preview(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
		if (!isInteractiveMode(ctx.mode)) return;
		// Preview only: do not touch `state` or the armed timer.
		deliver(ctx);
	}

	return { startSession, handleShutdown, preview };
}

export default function midnightReminderExtension(
	pi: ExtensionAPI,
	deps: ReminderDeps = {},
): void {
	const reminder = createMidnightReminder(deps);

	pi.on("session_start", async (_event, ctx) => {
		reminder.startSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		reminder.handleShutdown();
	});

	pi.registerCommand("bedtime-test", {
		description: "Preview the midnight reminder without changing reminder state",
		handler: async (_args, ctx) => {
			reminder.preview(ctx);
		},
	});
}
