#!/usr/bin/env python3
"""
Slowly DM LinkedIn connections (connected on/before config.START_DATE) with config.MESSAGE.

Usage:
    python linkedin_dm.py --dry-run --limit 2   # types the message but never sends
    python linkedin_dm.py --limit 1             # send to one person
    python linkedin_dm.py                       # normal run (stops at DAILY_CAP)
    python linkedin_dm.py --ignore-hours        # run outside ACTIVE_HOURS
"""
import argparse
import json
import os
import random
import re
import sys
import time
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

import config

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, config.SENT_LOG)
PROFILE_PATH = os.path.join(HERE, config.PROFILE_DIR)

# ---------------------------------------------------------------- selectors --
# LinkedIn changes class names often; these are kept in one place for easy fixes.
SEL_CONVO_BUBBLE = ".msg-overlay-conversation-bubble"
SEL_TEXTBOX = [
    "div.msg-form__contenteditable[contenteditable='true']",
    "div[role='textbox'][contenteditable='true']",
]
SEL_SEND = [
    "button.msg-form__send-button",
    "button[type='submit']:has-text('Send')",
]
SEL_THREAD_EVENTS = ".msg-s-event-listitem, li.msg-s-message-list__event"
SEL_CLOSE = [
    "button:has-text('Close your conversation')",
    "button[aria-label^='Close your conversation']",
    "button.msg-overlay-bubble-header__control:last-child",
]
STOP_TEXTS = [
    "reached the weekly limit",
    "you've reached the limit",
    "let's do a quick security check",
    "unusual activity",
]

# JS: find every connection card (an ancestor of a "Connected on …" label that
# also holds a /in/ profile link and a Message control) and describe it.
COLLECT_JS = r"""
() => {
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (!/^Connected\b/i.test(t)) continue;
    let card = node.parentElement;
    for (let i = 0; i < 12 && card; i++) {
      const link = card.querySelector('a[href*="/in/"]');
      const msg = [...card.querySelectorAll('button, a')].find(
        b => /^message\b/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
      if (link && msg) {
        const url = link.href.split('?')[0].replace(/\/$/, '') + '/';
        if (!seen.has(url)) {
          seen.add(url);
          const nameEl = card.querySelector('.mn-connection-card__name') || link;
          let name = (nameEl.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
          if (!name) {
            const al = msg.getAttribute('aria-label') || '';
            name = al.replace(/^Send a message to\s*/i, '').replace(/^Message\s*/i, '');
          }
          out.push({ url, name, connected: t });
        }
        break;
      }
      card = card.parentElement;
    }
  }
  return out;
}
"""

# JS: return a bounding box for the Message button of the card with this profile URL.
FIND_MSG_BTN_JS = r"""
(url) => {
  const slug = new URL(url).pathname.replace(/\/$/, '');
  const links = [...document.querySelectorAll('a[href*="/in/"]')]
    .filter(a => new URL(a.href).pathname.replace(/\/$/, '') === slug);
  for (const link of links) {
    let card = link.parentElement;
    for (let i = 0; i < 12 && card; i++) {
      const msg = [...card.querySelectorAll('button, a')].find(
        b => /^message\b/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
      if (msg) {
        document.querySelectorAll('[data-dm-target]').forEach(e => e.removeAttribute('data-dm-target'));
        msg.setAttribute('data-dm-target', '1');
        return true;
      }
      card = card.parentElement;
    }
  }
  return false;
}
"""


class StopRun(Exception):
    """Raised when LinkedIn shows something that means we should stop for today."""


# ------------------------------------------------------------------- helpers --
def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def rsleep(lo: float, hi: float, label: str = "") -> None:
    secs = random.uniform(lo, hi)
    if label and secs > 30:
        until = datetime.now() + timedelta(seconds=secs)
        log(f"{label}: waiting {secs / 60:.1f} min (until {until:%H:%M:%S})")
    time.sleep(secs)


def short_pause() -> None:
    time.sleep(random.uniform(0.6, 2.2))


def load_log() -> Dict[str, dict]:
    if os.path.exists(LOG_PATH):
        with open(LOG_PATH) as f:
            return json.load(f)
    return {}


def save_log(data: Dict[str, dict]) -> None:
    tmp = LOG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, LOG_PATH)


def sent_today(data: Dict[str, dict]) -> int:
    today = date.today().isoformat()
    return sum(1 for v in data.values() if v.get("status") == "sent" and v.get("at", "").startswith(today))


def parse_connected(text: str) -> Optional[date]:
    """'Connected on November 4, 2026' -> date. Handles a few relative forms too."""
    m = re.search(r"Connected on\s+([A-Za-z]+ \d{1,2}, \d{4})", text)
    if m:
        try:
            return datetime.strptime(m.group(1), "%B %d, %Y").date()
        except ValueError:
            return None
    m = re.search(r"(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago", text, re.I)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        days = {"minute": 0, "hour": 0, "day": 1, "week": 7, "month": 30, "year": 365}[unit] * n
        return date.today() - timedelta(days=days)
    if re.search(r"today|just now", text, re.I):
        return date.today()
    if re.search(r"yesterday", text, re.I):
        return date.today() - timedelta(days=1)
    return None


def first_visible(scope, selectors: List[str], timeout: int = 8000):
    deadline = time.time() + timeout / 1000
    while time.time() < deadline:
        for sel in selectors:
            loc = scope.locator(sel)
            try:
                if loc.count() and loc.last.is_visible():
                    return loc.last
            except Exception:
                pass
        time.sleep(0.25)
    return None


def human_click(page, locator) -> None:
    """Move the mouse to the element in a few steps, hover briefly, then click."""
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    if box:
        x = box["x"] + box["width"] * random.uniform(0.3, 0.7)
        y = box["y"] + box["height"] * random.uniform(0.3, 0.7)
        page.mouse.move(x, y, steps=random.randint(8, 25))
        time.sleep(random.uniform(0.15, 0.6))
        page.mouse.click(x, y)
    else:
        locator.click()


def human_type(page, text: str) -> None:
    lo, hi = config.KEY_DELAY_MS
    lines = text.split("\n")
    for i, line in enumerate(lines):
        words = line.split(" ")
        for j, word in enumerate(words):
            chunk = word + (" " if j < len(words) - 1 else "")
            for ch in chunk:
                page.keyboard.type(ch)
                time.sleep(random.uniform(lo, hi) / 1000)
            if random.random() < 0.06:  # occasional "thinking" pause
                time.sleep(random.uniform(0.6, 2.0))
        if i < len(lines) - 1:
            page.keyboard.press("Shift+Enter")
            time.sleep(random.uniform(0.2, 0.7))


def check_for_blocks(page) -> None:
    url = page.url
    if "checkpoint" in url or "authwall" in url or "/login" in url:
        raise StopRun(f"LinkedIn redirected to {url} (login / security check)")
    try:
        body = page.inner_text("body", timeout=3000).lower()
    except Exception:
        return
    for t in STOP_TEXTS:
        if t in body:
            raise StopRun(f"LinkedIn shows: '{t}'")


def gentle_scroll(page, times: int = 1) -> None:
    for _ in range(times):
        page.mouse.wheel(0, random.randint(250, 700))
        time.sleep(random.uniform(0.8, 2.5))
        if random.random() < 0.15:  # sometimes scroll back up a bit, like reading
            page.mouse.wheel(0, -random.randint(100, 300))
            time.sleep(random.uniform(0.5, 1.5))


def load_more(page) -> bool:
    """Scroll to the bottom; click 'Show more results' if present. Returns True if more may exist."""
    before = page.evaluate("document.body.scrollHeight")
    gentle_scroll(page, random.randint(2, 4))
    page.evaluate("window.scrollBy(0, document.body.scrollHeight)")
    time.sleep(random.uniform(1.5, 3.0))
    btn = page.get_by_role("button", name=re.compile(r"show more results", re.I))
    if btn.count() and btn.first.is_visible():
        human_click(page, btn.first)
        time.sleep(random.uniform(2.0, 4.0))
        return True
    after = page.evaluate("document.body.scrollHeight")
    return after > before


# --------------------------------------------------------------- core steps --
def ensure_logged_in(page) -> None:
    page.goto(config.CONNECTIONS_URL, wait_until="domcontentloaded")
    time.sleep(random.uniform(3, 5))
    if "login" in page.url or "authwall" in page.url or "signup" in page.url:
        log("Not logged in. Please log in to LinkedIn in the opened browser window.")
        input(">>> After you've logged in, press Enter here to continue... ")
        page.goto(config.CONNECTIONS_URL, wait_until="domcontentloaded")
        time.sleep(random.uniform(3, 5))
    check_for_blocks(page)


def collect_targets(page, done: Dict[str, dict], needed: int) -> List[dict]:
    """Scroll the connections list until we have `needed` eligible, not-yet-messaged people."""
    targets: List[dict] = []
    seen = set()
    stale_rounds = 0
    passed_start = False
    while len(targets) < needed and stale_rounds < 4:
        cards = page.evaluate(COLLECT_JS)
        new = 0
        for c in cards:
            if c["url"] in seen:
                continue
            seen.add(c["url"])
            new += 1
            d = parse_connected(c["connected"])
            if d is None:
                log(f"  ? couldn't read date for {c['name']!r}: {c['connected']!r} — skipping")
                continue
            if d > config.START_DATE:
                continue
            if not passed_start:
                passed_start = True
                log(f"Reached connections from {d:%b %d, %Y} — starting here.")
            if c["url"] in done:
                continue
            c["date"] = d.isoformat()
            targets.append(c)
            if len(targets) >= needed:
                break
        if len(targets) >= needed:
            break
        if not passed_start and new:
            log(f"  scrolling past newer connections... ({len(seen)} checked so far)")
        more = load_more(page)
        stale_rounds = 0 if (new or more) else stale_rounds + 1
    log(f"Found {len(targets)} people to message ({len(seen)} cards scanned).")
    return targets


def find_message_button(page, url: str):
    for _ in range(25):
        if page.evaluate(FIND_MSG_BTN_JS, url):
            return page.locator("[data-dm-target='1']").first
        if not load_more(page):
            break
    return None


def convo_scope(page):
    bubbles = page.locator(SEL_CONVO_BUBBLE)
    if bubbles.count():
        return bubbles.last
    return page  # full-page messaging view


def close_convo(page) -> None:
    scope = convo_scope(page)
    if scope is page:
        if "/messaging/" in page.url:
            page.go_back(wait_until="domcontentloaded")
            time.sleep(random.uniform(2, 4))
        return
    btn = first_visible(scope, SEL_CLOSE, timeout=3000)
    if btn:
        human_click(page, btn)
    else:
        page.keyboard.press("Escape")
    time.sleep(random.uniform(0.8, 2.0))


def message_person(page, person: dict, dry_run: bool) -> str:
    """Returns 'sent', 'dry-run', 'skipped-existing', or raises."""
    btn = find_message_button(page, person["url"])
    if not btn:
        raise RuntimeError("could not find their card / Message button")
    human_click(page, btn)
    time.sleep(random.uniform(2.0, 4.0))
    check_for_blocks(page)

    scope = convo_scope(page)
    box = first_visible(scope, SEL_TEXTBOX, timeout=12000)
    if not box:
        raise RuntimeError("message box didn't open (maybe InMail/Premium prompt)")

    # Look at existing thread.
    time.sleep(random.uniform(1.0, 2.5))
    try:
        thread_text = scope.inner_text(timeout=3000) if scope is not page else page.inner_text("main", timeout=3000)
    except Exception:
        thread_text = ""
    if config.MESSAGE_FINGERPRINT in thread_text:
        close_convo(page)
        return "skipped-existing"
    if config.SKIP_EXISTING_THREADS and scope.locator(SEL_THREAD_EVENTS).count() > 0:
        close_convo(page)
        return "skipped-existing"

    # Clear any draft, then type.
    human_click(page, box)
    page.keyboard.press("Meta+A")
    page.keyboard.press("Backspace")
    time.sleep(random.uniform(0.5, 1.5))
    human_type(page, config.MESSAGE)
    time.sleep(random.uniform(1.0, 3.0))  # "re-read" before sending

    if dry_run:
        log("  [dry-run] message typed, NOT sending.")
        time.sleep(random.uniform(2, 4))
        page.keyboard.press("Meta+A")
        page.keyboard.press("Backspace")
        close_convo(page)
        # LinkedIn may ask to discard draft
        discard = page.get_by_role("button", name=re.compile(r"discard", re.I))
        if discard.count() and discard.first.is_visible():
            discard.first.click()
        return "dry-run"

    send = first_visible(scope, SEL_SEND, timeout=5000)
    if send and send.is_enabled():
        human_click(page, send)
    else:
        page.keyboard.press("Enter")

    # Confirm it landed in the thread.
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            events = scope.locator(SEL_THREAD_EVENTS)
            if events.count() and config.MESSAGE_FINGERPRINT in events.last.inner_text(timeout=1000):
                break
        except Exception:
            pass
        time.sleep(0.5)
    else:
        check_for_blocks(page)
        raise RuntimeError("couldn't confirm message was sent")

    time.sleep(random.uniform(1.5, 3.5))
    close_convo(page)
    return "sent"


def idle_noise(page) -> None:
    """Small, harmless human-ish actions between messages."""
    r = random.random()
    if r < 0.4:
        gentle_scroll(page, random.randint(1, 3))
    elif r < 0.6:
        page.mouse.move(random.randint(100, 1100), random.randint(100, 700), steps=random.randint(10, 30))


def in_active_hours() -> bool:
    h = datetime.now().hour
    return config.ACTIVE_HOURS[0] <= h < config.ACTIVE_HOURS[1]


# ---------------------------------------------------------------------- main --
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="type messages but never press Send")
    ap.add_argument("--limit", type=int, default=None, help="max messages this run")
    ap.add_argument("--ignore-hours", action="store_true", help="run outside ACTIVE_HOURS")
    args = ap.parse_args()

    done = load_log()
    remaining = config.DAILY_CAP - sent_today(done)
    if args.limit is not None:
        remaining = min(remaining, args.limit)
    if remaining <= 0:
        log(f"Daily cap of {config.DAILY_CAP} already reached today. Run again tomorrow.")
        return
    if not args.ignore_hours and not in_active_hours():
        log(f"Outside active hours {config.ACTIVE_HOURS}. Use --ignore-hours to override.")
        return

    log(f"Will message up to {remaining} people{' (DRY RUN)' if args.dry_run else ''}.")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            PROFILE_PATH,
            channel="chrome",
            headless=False,
            viewport={"width": random.randint(1280, 1440), "height": random.randint(800, 900)},
            locale="en-US",
            args=["--disable-blink-features=AutomationControlled"],
            ignore_default_args=["--enable-automation"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            ensure_logged_in(page)
            targets = collect_targets(page, done, remaining + 5)  # a few spare in case of skips
            # Back to top, then work through them in order.
            page.evaluate("window.scrollTo(0, 0)")
            time.sleep(random.uniform(1, 3))

            count = 0
            since_break = 0
            next_break = random.randint(*config.BREAK_EVERY)
            for person in targets:
                if count >= remaining:
                    break
                if not args.ignore_hours and not in_active_hours():
                    log("Active hours ended — stopping for today.")
                    break
                log(f"→ {person['name']} (connected {person['date']})")
                try:
                    status = message_person(page, person, args.dry_run)
                except StopRun:
                    raise
                except (RuntimeError, PWTimeout) as e:
                    log(f"  ✗ skipped: {e}")
                    try:
                        close_convo(page)
                    except Exception:
                        pass
                    continue

                log(f"  ✓ {status}")
                if status in ("sent", "skipped-existing"):
                    done[person["url"]] = {
                        "name": person["name"],
                        "connected": person["date"],
                        "status": status,
                        "at": datetime.now().isoformat(timespec="seconds"),
                    }
                    save_log(done)
                if status in ("sent", "dry-run"):
                    count += 1
                    since_break += 1
                    if count >= remaining:
                        break
                    if since_break >= next_break:
                        rsleep(*config.LONG_BREAK, label="Long break")
                        since_break = 0
                        next_break = random.randint(*config.BREAK_EVERY)
                    else:
                        idle_noise(page)
                        if args.dry_run:
                            rsleep(5, 12)
                        else:
                            rsleep(*config.BETWEEN_MESSAGES, label="Next message")
                else:
                    rsleep(8, 25)
                check_for_blocks(page)

            log(f"Done. Messaged {count} people this run "
                f"({sent_today(done)}/{config.DAILY_CAP} sent today).")
        except StopRun as e:
            log(f"STOPPING: {e}. Check LinkedIn manually before running again.")
        except KeyboardInterrupt:
            log("Interrupted — progress is saved in sent_log.json.")
        finally:
            time.sleep(2)
            ctx.close()


if __name__ == "__main__":
    sys.exit(main())
