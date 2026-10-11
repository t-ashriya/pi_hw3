/**
 * Midnight Reminder — Pi extension integration tests.
 *
 * Exercises `extensions/reminder/index.ts` through a fake ExtensionAPI with
 * fake timers and a simulated local clock. No real timers or system time.
 *
 * Acceptance criteria: MIDNIGHT_REMINDER_PLAN.md §3, §5, §6, §7, §8, §9, §10.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ReminderMode = ExtensionContext["mode"];

import midnightReminderExtension, {
	REMINDER_MESSAGE,
} from "../extensions/reminder/index.ts";

/** Build a Date from local components, independent of host timezone. */
function localTime(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): Date {
	return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function createClock(initial: Date) {
	let current = initial;
	return {
		now: () => current,
		set: (date: Date) => {
			current = date;
		},
	};
}

function createTimers() {
	let nextId = 1;
	const handlers = new Map<number, () => void>();
	let setCalls = 0;
	let clearCalls = 0;
	return {
		setIntervalFn: (handler: () => void) => {
			setCalls += 1;
			const id = nextId++;
			handlers.set(id, handler);
			return id as unknown as ReturnType<typeof setInterval>;
		},
		clearIntervalFn: (handle: number | ReturnType<typeof setInterval>) => {
			clearCalls += 1;
			handlers.delete(handle as unknown as number);
		},
		tick: () => {
			for (const handler of [...handlers.values()]) handler();
		},
		active: () => handlers.size,
		setCalls: () => setCalls,
		clearCalls: () => clearCalls,
	};
}

interface FakeCommand {
	handler: (args: string, ctx: FakeContext) => unknown;
}

interface FakeContext {
	mode: ReminderMode;
	hasUI: boolean;
	ui: { notify: (message: string, type?: string) => void };
}

interface FakePi {
	on(event: string, handler: (event: unknown, ctx: FakeContext) => unknown): void;
	registerCommand(name: string, options: FakeCommand): void;
	getCommands(): unknown[];
	emit(event: string, ctx: FakeContext): Promise<void>;
	commands: Map<string, FakeCommand>;
}

function createFakePi(): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx: FakeContext) => unknown>>();
	const commands = new Map<string, FakeCommand>();
	return {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		getCommands() {
			return [...commands.keys()];
		},
		async emit(event, ctx) {
			for (const handler of handlers.get(event) ?? []) {
				await handler({ type: event }, ctx);
			}
		},
		commands,
	};
}

function createContext(mode: ReminderMode) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx: FakeContext = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			notify: (message, type) => {
				notifications.push({ message, type });
			},
		},
	};
	return { ctx, notifications };
}

function setup(options: { now: Date; mode?: ReminderMode }) {
	const clock = createClock(options.now);
	const timers = createTimers();
	const pi = createFakePi();
	midnightReminderExtension(pi as unknown as ExtensionAPI, {
		now: clock.now,
		setIntervalFn: timers.setIntervalFn,
		clearIntervalFn: timers.clearIntervalFn,
	});
	const { ctx, notifications } = createContext(options.mode ?? "tui");
	return { clock, timers, pi, ctx, notifications };
}

describe("midnight reminder extension integration", () => {
	it("notifies immediately on interactive startup inside the window (AC-5.1)", async () => {
		const { pi, ctx, notifications, timers } = setup({ now: localTime(2025, 1, 2, 0, 0) });

		await pi.emit("session_start", ctx);

		assert.deepEqual(
			notifications.map((entry) => entry.message),
			[REMINDER_MESSAGE],
		);
		assert.equal(timers.active(), 1);
	});

	it("notifies while idle when local midnight passes (AC-4.1)", async () => {
		const { clock, timers, pi, ctx, notifications } = setup({ now: localTime(2025, 1, 1, 23, 59) });

		await pi.emit("session_start", ctx);
		assert.equal(notifications.length, 0);

		clock.set(localTime(2025, 1, 2, 0, 0));
		timers.tick();

		assert.deepEqual(
			notifications.map((entry) => entry.message),
			[REMINDER_MESSAGE],
		);
	});

	it("does not notify twice for the same local date (AC-6.1)", async () => {
		const { clock, timers, pi, ctx, notifications } = setup({ now: localTime(2025, 1, 2, 0, 0) });

		await pi.emit("session_start", ctx);
		assert.equal(notifications.length, 1);

		clock.set(localTime(2025, 1, 2, 0, 1));
		timers.tick();
		clock.set(localTime(2025, 1, 2, 5, 59));
		timers.tick();

		assert.equal(notifications.length, 1);
	});

	it("previews with /bedtime-test without changing reminder state (AC-7.2, AC-7.3)", async () => {
		const { clock, timers, pi, ctx, notifications } = setup({ now: localTime(2025, 1, 1, 23, 59) });

		await pi.emit("session_start", ctx);
		await pi.commands.get("bedtime-test")?.handler("", ctx);
		assert.deepEqual(
			notifications.map((entry) => entry.message),
			[REMINDER_MESSAGE],
		);

		// Preview must not consume the date: the automatic reminder still fires.
		clock.set(localTime(2025, 1, 2, 0, 0));
		timers.tick();
		assert.equal(notifications.length, 2);

		// And the date is still only reminded once.
		clock.set(localTime(2025, 1, 2, 0, 1));
		timers.tick();
		assert.equal(notifications.length, 2);
	});

	it("does not start timers or notify in non-interactive mode (AC-8.1)", async () => {
		const { clock, timers, pi, ctx, notifications } = setup({
			now: localTime(2025, 1, 2, 0, 0),
			mode: "print",
		});

		await pi.emit("session_start", ctx);
		await pi.commands.get("bedtime-test")?.handler("", ctx);
		clock.set(localTime(2025, 1, 2, 0, 1));
		timers.tick();

		assert.equal(notifications.length, 0);
		assert.equal(timers.active(), 0);
		assert.equal(timers.setCalls(), 0);
	});

	it("clears the timer on session_shutdown (AC-9.1, AC-9.3)", async () => {
		const { clock, timers, pi, ctx, notifications } = setup({ now: localTime(2025, 1, 1, 23, 59) });

		await pi.emit("session_start", ctx);
		assert.equal(timers.active(), 1);

		await pi.emit("session_shutdown", ctx);
		assert.equal(timers.active(), 0);

		clock.set(localTime(2025, 1, 2, 0, 0));
		timers.tick();
		assert.equal(notifications.length, 0);
	});

	it("does not leave duplicate timers when the session restarts (AC-9.2)", async () => {
		const { timers, pi, ctx } = setup({ now: localTime(2025, 1, 2, 0, 0) });

		await pi.emit("session_start", ctx);
		await pi.emit("session_start", ctx);

		assert.equal(timers.active(), 1);
	});
});
