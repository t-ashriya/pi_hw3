# Midnight Reminder Pi Extension

## Overview

Midnight Reminder is a Pi coding agent extension that reminds users to save their work and consider getting some sleep when working late at night.

The extension automatically checks the computer's local time and displays a notification between **12:00 AM and 6:00 AM**.

### Features

- Automatically checks the local time every 30 seconds.
- Displays a reminder once per local calendar date during a session.
- Works even when Pi is idle.
- Provides `/bedtime-test` to preview the notification at any time.
- Provides `/bedtime-demo` to demonstrate midnight using simulated time.
- Runs only in interactive Pi sessions.
- Cleans up timers when the session shuts down.

## Requirements

- Node.js and npm
- Pi coding agent
- Git

## Installation

Clone the repository and install dependencies:

```bash
git clone -b feature/midnight-reminder https://github.com/t-ashriya/pi_hw3.git
cd pi_hw3
npm install
```

## Running the Extension

Start Pi with the extension:

```bash
pi -e ./extensions/reminder/index.ts
```

The extension automatically checks the local time while Pi is running.

### Preview the Notification

Inside Pi, enter:

```text
/bedtime-test
```

The following message appears:

> It is after midnight. Consider saving your work and getting some sleep.

This preview works at any time and does not affect automatic reminders.

### Simulate Midnight

Inside Pi, enter:

```text
/bedtime-demo
```

The demo simulates the clock advancing from 11:59 PM to 12:00 AM and then 12:01 AM. It demonstrates that the reminder is triggered at midnight and is not repeated on the same date.

The simulation does not change the computer's system clock.

## Running Tests

Run all tests:

```bash
npm test
```

Run only the reminder time-policy tests:

```bash
npx tsx --test tests/reminder.test.ts
```

Run the integration tests:

```bash
npx tsx --test tests/reminder-integration.test.ts
```

Check TypeScript types:

```bash
npm run typecheck
```

The tests use simulated local dates and timers to verify midnight reminders without waiting until midnight.

## Expected Behavior

| Local time | Expected behavior |
|---|---|
| 11:59 PM | No reminder |
| 12:00 AM | Reminder appears |
| 12:01 AM, same date | No duplicate reminder |
| 5:59 AM | Reminder appears if not already sent |
| 6:00 AM | No reminder |
| Midnight on the next date | Reminder allowed again |

## Testing Approach

The project follows Test-Driven Development (TDD):

1. **RED:** Write tests before implementing the reminder.
2. **GREEN:** Implement the time policy and Pi integration until the tests pass.
3. **REFACTOR:** Improve the implementation while preserving passing tests.

Tests cover automatic reminders, duplicate prevention, manual previews, interactive-only behavior, and timer cleanup.
