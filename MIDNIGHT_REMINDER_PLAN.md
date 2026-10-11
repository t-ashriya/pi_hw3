# Midnight Reminder Pi Extension — Planning Document

**HW3, Week 1**
Status: Planning only — not implemented.
Scope: Define acceptance criteria for a new Pi extension that emits a bedtime
reminder around local midnight.

This document is the contract the eventual implementation and its tests must
satisfy. It intentionally contains **no implementation**.

---

## 1. Purpose

Add a Pi extension that automatically reminds the user to go to bed once local
midnight passes, while remaining silent outside the intended window and
respecting interactive-only usage.

---

## 2. Definitions

- **Local midnight**: `00:00:00` in the machine's local timezone (the date the
  system clock rolls over to).
- **Local date**: the calendar date (`YYYY-MM-DD`) in local time.
- **Reminder window**: `00:00` (inclusive) through `06:00` (exclusive) local
  time.
- **Fresh session**: a Pi session that has started or resumed and has not yet
  emitted a reminder for the current local date.
- **Emitted reminder**: a user-visible notification that satisfies the
  delivery requirement in §4.

---

## 3. Local time window (00:00–06:00)

- AC-3.1: A reminder is only eligible to fire while local time is within
  `[00:00, 06:00)`.
- AC-3.2: At or after `06:00` local time, no reminder may fire for that date,
  even if midnight was missed while Pi was not running.
- AC-3.3: Before `00:00` local time, no reminder may fire for the upcoming
  midnight.
- AC-3.4: Window membership must be computed from local time, not UTC, and must
  be correct across timezone changes observed at schedule time.

---

## 4. Automatic notification within 60 seconds of midnight

- AC-4.1: When Pi is running and a session is active across local midnight, a
  reminder is delivered **within 60 seconds** of `00:00:00`.
- AC-4.2: The 60-second tolerance applies to the first eligible emission; it
  must not be used to repeatedly notify.
- AC-4.3: The delivered reminder must be user-visible in the Pi transcript
  (e.g. via a custom message) and must clearly instruct the user to go to bed.
- AC-4.4: Delivery must not require the user to invoke a command.

---

## 5. Startup / resume behavior

- AC-5.1: If Pi starts (or a session resumes) while local time is inside the
  window and no reminder has been emitted for the current local date and
  session, a reminder is delivered promptly (within the same 60-second budget,
  measured from session start).
- AC-5.2: If Pi starts inside the window but the reminder was already emitted
  for the current local date within the same session, no duplicate is sent.
- AC-5.3: If Pi starts after `06:00` local time, no catch-up reminder is sent
  for that date.
- AC-5.4: If Pi starts before `00:00`, it arms for the upcoming midnight and
  fires automatically when the window opens, without user action.
- AC-5.5: Arming must occur from the `session_start` lifecycle hook (or a
  command explicitly invoked by the user), never from the extension factory, so
  non-session loads do not start timers.

---

## 6. Once per local date per session

- AC-6.1: At most one reminder is emitted per local date, per session.
- AC-6.2: The "already reminded" state is scoped to the session; a new session
  on the same date may emit its own reminder (subject to §3–§5).
- AC-6.3: The emitted-date state must be tracked in memory for the session and
  must not leak between sessions.
- AC-6.4: Crossing multiple dates in one long-running session must produce one
  reminder for each eligible date, not more.
- AC-6.5: A reminder suppressed outside the window must not mark the date as
  emitted.

---

## 7. `/bedtime-test` preview command

- AC-7.1: A `/bedtime-test` command is registered and available to the user.
- AC-7.2: Running `/bedtime-test` displays a preview of exactly what the
  reminder would look like at fire time.
- AC-7.3: `/bedtime-test` **must not** change reminder state: it must not mark
  the current (or any) local date as emitted, must not cancel or reschedule the
  armed timer, and must not alter the once-per-date bookkeeping.
- AC-7.4: `/bedtime-test` must work regardless of the current time (inside or
  outside the window), so it can be used to inspect the message.
- AC-7.5: `/bedtime-test` must be side-effect free with respect to notifications
  delivered automatically; it is a preview only.

---

## 8. Interactive-only behavior

- AC-8.1: The extension only arms timers and emits reminder messages in
  interactive sessions (for example when `ctx.mode === "tui"` or the context
  reports UI capability). It must not run headless timers in print, JSON, or
  non-interactive RPC modes.
- AC-8.2: The extension must not block session startup or require UI in a way
  that breaks non-interactive invocations.
- AC-8.3: In non-interactive modes, `/bedtime-test` and automatic scheduling
  must fail gracefully (no crash, no timer started), and the rest of Pi must
  function normally.

---

## 9. Timer cleanup

- AC-9.1: Any timer created by the extension is cleared on `session_shutdown`.
- AC-9.2: Cleanup is idempotent; repeated shutdown/reload paths must not throw
  or leave orphaned timers.
- AC-9.3: After cleanup, no reminder callback may fire from a prior session.
- AC-9.4: Timers that are not currently needed (e.g. after the window closes)
  must be cleared or rescheduled rather than left running indefinitely.
- AC-9.5: Timer handles must be unref'd where supported so a pending reminder
  does not by itself keep the Node/Pi process alive.

---

## 10. Fake-clock tests

- AC-10.1: Scheduling and window logic must be testable without waiting on real
  wall-clock time; the current time source must be injectable (clock function
  or equivalent).
- AC-10.2: Tests must cover, at minimum:
  - firing at exactly `00:00:00` and within the 60-second tolerance;
  - no fire before `00:00`;
  - no fire at or after `06:00`, including missed-midnight catch-up;
  - prompt fire when a session starts inside the window;
  - no duplicate fire for the same local date within one session;
  - one fire per date across multiple dates;
  - `/bedtime-test` produces a preview and leaves state unchanged;
  - timer cleanup clears pending callbacks on shutdown;
  - correct behavior when a fake clock advances the timezone/date boundary.
- AC-10.3: Tests must run under the repository's existing `npm test`
  (`tsx --test tests/*.test.ts`) using Node's built-in test runner and use the
  injected clock rather than real timers.
- AC-10.4: Scheduling logic should be extracted into a pure, Pi-independent
  module so it can be unit-tested without an active Pi session.

---

## 11. Out of scope (for Week 1)

- Persisting the "already reminded" date across sessions or restarts.
- Configurable reminder times or windows.
- Sending reminders through system-level OS notifications.
- Snooze, dismiss, or response handling.
- Modifying the existing `/citecheck` behavior.

---

## 12. Suggested (non-binding) implementation touchpoints

For tracking only; not part of the acceptance criteria:

- New entrypoint: `extensions/reminder/index.ts` (or similar).
- New pure logic: `src/reminder.ts` (window + next-fire computation, state).
- New tests: `tests/reminder.test.ts`.
- `package.json`: add the entrypoint to `pi.extensions` (or rely on directory
  discovery).
- `tsconfig.json`: already includes `extensions/**/*.ts`; no change expected.
