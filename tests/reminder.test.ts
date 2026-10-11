/**
 * Midnight Reminder — time policy tests (written test-first).
 *
 * These tests target the pure time-policy module that does not exist yet:
 * `src/reminder.ts`. Until that module is implemented, this file is expected
 * to fail at import time. It deliberately uses simulated local dates rather
 * than the real system clock.
 *
 * Acceptance criteria: MIDNIGHT_REMINDER_PLAN.md §3, §4, §6, §10.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	evaluateReminder,
	type ReminderState,
} from "../src/reminder.ts";

/**
 * Build a Date in the machine's local timezone. Because it is constructed from
 * local components (not an ISO/UTC string), `getHours()` and friends return
 * exactly the values supplied here regardless of the host timezone.
 */
function localTime(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): Date {
	return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** Convenience literal matching a session that has not reminded yet. */
const NOT_YET_REMINDED: ReminderState = { remindedDate: null };

describe("midnight reminder time policy", () => {
	it("does not remind at 23:59 before midnight (AC-3.3)", () => {
		const now = localTime(2025, 1, 1, 23, 59);
		const decision = evaluateReminder(now, NOT_YET_REMINDED);

		assert.equal(decision.remind, false);
		assert.equal(decision.state.remindedDate, null);
	});

	it("reminds at exactly 00:00 local time (AC-4.1)", () => {
		const now = localTime(2025, 1, 2, 0, 0);
		const decision = evaluateReminder(now, NOT_YET_REMINDED);

		assert.equal(decision.remind, true);
		assert.equal(decision.state.remindedDate, "2025-01-02");
	});

	it("does not remind again at 00:01 on the same local date (AC-6.1)", () => {
		const midnight = localTime(2025, 1, 2, 0, 0);
		const first = evaluateReminder(midnight, NOT_YET_REMINDED);
		assert.equal(first.remind, true);

		const oneMinuteLater = localTime(2025, 1, 2, 0, 1);
		const second = evaluateReminder(oneMinuteLater, first.state);

		assert.equal(second.remind, false);
		assert.equal(second.state.remindedDate, "2025-01-02");
	});

	it("reminds at 05:59 when not already sent (AC-3.1, AC-5.1)", () => {
		const now = localTime(2025, 1, 2, 5, 59);
		const decision = evaluateReminder(now, NOT_YET_REMINDED);

		assert.equal(decision.remind, true);
		assert.equal(decision.state.remindedDate, "2025-01-02");
	});

	it("does not remind at 06:00 local time (AC-3.2)", () => {
		const now = localTime(2025, 1, 2, 6, 0);
		const decision = evaluateReminder(now, NOT_YET_REMINDED);

		assert.equal(decision.remind, false);
		assert.equal(decision.state.remindedDate, null);
	});

	it("allows a reminder again at midnight on the next local date (AC-6.4)", () => {
		const firstMidnight = localTime(2025, 1, 2, 0, 0);
		const first = evaluateReminder(firstMidnight, NOT_YET_REMINDED);
		assert.equal(first.remind, true);
		assert.equal(first.state.remindedDate, "2025-01-02");

		const nextMidnight = localTime(2025, 1, 3, 0, 0);
		const second = evaluateReminder(nextMidnight, first.state);

		assert.equal(second.remind, true);
		assert.equal(second.state.remindedDate, "2025-01-03");
	});
});
