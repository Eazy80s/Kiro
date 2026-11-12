# 🎓 Studie Files — Study Tracker

A simple, self-contained study management app that runs entirely in your browser.
No installation, no server, no account needed. Your data is saved locally in your browser.

## Features

- **📅 Calendar** — add and view entries (exams, deadlines, lectures, other) on a monthly calendar. Click an entry to delete it.
- **📚 Modules** — create a module for each of your courses.
- **✅ Checklists** — give each module a checklist; add items and tick them off as you go.
- **📊 Module progress bar** — automatically calculated from how many checklist items you've ticked.
- **📊 Overall progress bar** — your total progress, averaged across all your modules, shown on the Dashboard along with an "Upcoming" list of your next entries.

## How to run it

1. Download or clone this repository.
2. Double-click **`index.html`** — it opens in your default browser.

That's it. No build step, no dependencies.

## How your data is saved

Everything you enter is stored in your browser's **local storage**:

- Close the tab and reopen it later → your data is still there.
- It is tied to *that browser on that computer*. A different browser or device starts fresh.

## Project structure

| File | Purpose |
|------|---------|
| `index.html` | Page structure and layout |
| `styles.css` | Styling (dark theme) |
| `app.js` | All app logic + data persistence |

## License

Personal project — use it however you like.
