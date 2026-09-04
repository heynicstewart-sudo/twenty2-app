# T2C Outreach — LinkedIn capture extension

A Chrome/Edge extension that **reads** LinkedIn (profiles, conversation threads,
your recent connection acceptances) and syncs what it read to the T2C Outreach
CRM. It **never** sends a message or a connection request — you still do those
yourself.

## What it does

| Job | How it's triggered | What it reads |
|---|---|---|
| **Capture a profile** | Passively when you open a profile of someone the CRM says needs a message; or a paced background batch | Name, headline, location, the full About section; the batch also opens `/details/experience/` and `/details/education/` in the same tab for the full history |
| **Sync a conversation** | Popup → "Sync the open conversation" | Every message in the thread (full text, not the inbox preview), who sent it, timestamps → updates Conversation Context, flips "Reply Received", drafts the follow-up |
| **Recent acceptances** | Popup → "Sync recent connections" | Your notifications for "X accepted your invitation" → advances those contacts from Connection Pending to Connected |

The batch only queues contacts who are **in a live campaign**, at a
**draft-imminent stage** (Connected, or Message 1/2 Sent with a reply logged),
have a LinkedIn URL, and haven't been captured from LinkedIn in the last 30 days.

## Not getting the account flagged

This is scraping-while-you-browse, which LinkedIn tolerates far better than
cloud automation — but only if it behaves like a person. The guardrails, all
adjustable in Options (lower = safer, don't raise them):

- **32–65s randomised gap** between profile loads, plus a **2–5 min break every 8**.
- **18/hour and 45/day** hard caps (shared across passive + batch). Passive
  captures count too. Where LinkedIn renders Experience/Education inline on the
  profile (most accounts) the batch reads it there — one page load per contact,
  same as before. Only the stripped-down profile layout, which hides those
  sections, makes the batch open `/details/experience/` + `/details/education/`
  in the same tab (up to 3 loads, still one contact against the caps). Set
  `deepScrape: false` in Options-stored settings to never open the sub-pages.
- Batches only run **7am–9pm local**.
- If any LinkedIn page shows a "browsing too fast" / security-check screen, the
  **batch aborts for the rest of the day** and tells you.
- **2 failures in a row** stops the batch.
- One batch at a time, one background tab at a time, real page loads (no direct
  API hammering).

Sensible daily volume for cold outreach is roughly 20–25 messages and 20
connection requests. Keep the caps near that. Don't run back-to-back 45-profile
batches all day.

## Server setup (one-time)

On the Railway deployment, set an env var:

```
EXTENSION_TOKEN=<a long random string>
```

The `/api/extension/*` routes return 503 until this is set. That's the only
server config.

## Install (unpacked)

1. `chrome://extensions` → toggle **Developer mode** on.
2. **Load unpacked** → pick this `extension/` folder.
3. Click the extension icon → **Set token** → fill in:
   - **CRM URL**: `https://twenty2-app-production.up.railway.app` (or your Railway URL)
   - **Extension token**: the same value you set as `EXTENSION_TOKEN`
   - **Client slug**: leave blank unless you run more than one client base
4. The popup should show `Connected — <account>` and a "N due" count.

## Daily use

- Send your connection requests as normal.
- Once a day: popup → **Sync recent connections** (marks who accepted).
- Then: popup → **Capture due profiles** and walk away. Come back to a queue of
  contacts with real About/Experience and message 1 drafts waiting.
- When you check a reply in your inbox, open the thread → popup → **Sync the open
  conversation**. Reply gets logged, follow-up drafted.

## Maintenance

LinkedIn's profile is server-driven UI (SDUI): CSS classes are per-deploy
hashes and useless. `content.js` keys off two things that have proven durable:

- **card id suffixes** — `[id*="Topcard"]`, `[id*="AboutDetailsSection"]`,
  `[id*="ExperienceDetailsSection"]`, `[id*="EducationDetailsSection"]`
- **visible text order** — `scrapeDetails()` reads the section as an ordered
  text sequence and `parseExperience()` reconstructs entries from it (handles
  both flat roles and grouped-employer sub-roles).

If captures come back thin, re-run the probes: open a profile, then its
`/details/experience/` page, and check those id substrings still exist and that
`orderedText()` on the section still yields `title / company / dates / location`
rows. Update the id fragments or the `isDateRange` / `isBareDuration` heuristics
as needed — that's the standing cost of reading LinkedIn at all.
