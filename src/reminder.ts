/**
 * Midnight reminder time policy.
 *
 * Pure date logic, independent of Pi's UI and timers. Callers own scheduling
 * and persistence; this module only decides whether a reminder is due for a
 * given moment and session state.
 *
 * Window: local 00:00 (inclusive) to 06:00 (exclusive), once per local date.
 * See MIDNIGHT_REMINDER_PLAN.md §3, §4, §6.
 */

/** Session-scoped reminder bookkeeping. */
export interface ReminderState {
	/** Local date (`YYYY-MM-DD`) already reminded this session, or null. */
	remindedDate: string | null;
}

/** Result of evaluating the policy at a point in time. */
export interface ReminderDecision {
	/** Whether a reminder should be emitted now. */
	remind: boolean;
	/** Updated state to carry forward (never mutated in place). */
	state: ReminderState;
}

const WINDOW_START_MINUTES = 0;
const WINDOW_END_MINUTES = 6 * 60;

/** Format a Date as its local calendar date, `YYYY-MM-DD`. */
export function toLocalDateString(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** True when local time is in `[00:00, 06:00)`. */
export function isWithinReminderWindow(date: Date): boolean {
	const minutesSinceMidnight = date.getHours() * 60 + date.getMinutes();
	return minutesSinceMidnight >= WINDOW_START_MINUTES && minutesSinceMidnight < WINDOW_END_MINUTES;
}

/**
 * Decide whether to remind at `now` given session `state`.
 *
 * Reminds only inside the window and only if this local date has not already
 * been reminded this session. Outside the window the state is returned
 * unchanged, so a missed date is never marked as reminded.
 */
export function evaluateReminder(now: Date, state: ReminderState): ReminderDecision {
	if (!isWithinReminderWindow(now)) {
		return { remind: false, state };
	}

	const localDate = toLocalDateString(now);
	if (state.remindedDate === localDate) {
		return { remind: false, state };
	}

	return { remind: true, state: { remindedDate: localDate } };
}
