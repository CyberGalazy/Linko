# LinkedIn → X invite DMs

## Recommended: run it as a local Chrome extension (auto-reloads and resumes)
One-time setup:
1. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the folder `~/Projects/LinkedInAuto/extension`.
3. Open https://www.linkedin.com/mynetwork/invite-connect/connections/ (type it in the address bar or reload the page).
   A black panel appears at the bottom-left. Click **Start**.

When a chat doesn't open (LinkedIn's API says "too many requests"), it pauses 5 min (then 10, 20, up to 30),
**reloads the page, scrolls back down and continues** with the same person. If that happens 5 times in an hour, it stops.
It keeps running across reloads until you click **Stop** (or it runs out of people).

Settings (start person, pacing, DRY_RUN, …) are at the top of `extension/linkedin_dm.js`.
After changing them, click the ↻ icon on the extension's card in `chrome://extensions`, then reload LinkedIn.
Don't also paste the console version while the extension is on.

## Alternative: paste into the Console (no auto-reload)

1. Open https://www.linkedin.com/mynetwork/invite-connect/connections/ in your normal Chrome.
2. Open the Console: Cmd+Option+J. The first time, type `allow pasting` and press Enter.
3. Open `linkedin_dm_console.js`, copy all of it, paste it into the Console and press Enter.

## First run: dry run (default)
`DRY_RUN: true` pastes the message for up to 3 people but never sends it.
Check that it starts with the right person (Oct 28) and that the message looks right.

## Go live
At the top of the file, set `DRY_RUN: false`, then reload the page and paste again.
It sends one DM every 45–90 seconds, with a 5–10 min break every 15 sends. If LinkedIn says "too many requests" (429), it pauses 5 min (then 10, 20, up to 30) and carries on with the same person.

## Controls (type in the Console)
- `DM.stop()`, or the red Stop button at the bottom-left: stop
- `DM.start()`: resume. People already messaged are skipped (the log is kept in the browser).
- `DM.diagnose()`: if it says 0 cards were found, send over the tables it prints
- `DM.diagnoseChat()`: if it says "chat box did not open", send over what it prints
- `DM.exportLog()`: copy the list of people already messaged
- `DM.resetLog()`: clear that list
- `DM.resetRun()`: clear the pause/reload history

Keep the tab in front while it runs. Chrome slows scripts down in background tabs.
