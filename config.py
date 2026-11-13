"""Settings for linkedin_dm.py — edit these, not the script."""
from datetime import date

MESSAGE = """Hey! Would love to connect on X (Twitter) as well. Always great to connect with like-minded people, share ideas and engage in interesting discussions.

Here's my profile: https://x.com/Gauransh20"""

# A unique bit of MESSAGE used to detect "already sent this to them" in an existing thread.
MESSAGE_FINGERPRINT = "x.com/Gauransh20"

# Only message people connected ON or BEFORE this date (newer ones are skipped).
START_DATE = date(2026, 11, 4)

DAILY_CAP = 25                       # max messages per calendar day
ACTIVE_HOURS = (10, 20)              # only send between 10:00 and 20:00 local time

# Pauses (seconds)
BETWEEN_MESSAGES = (180, 540)        # 3–9 min between messages
BREAK_EVERY = (5, 8)                 # take a long break after this many messages
LONG_BREAK = (900, 1800)             # 15–30 min
KEY_DELAY_MS = (40, 140)             # per-keystroke typing delay

# If True, skip anyone you already have any chat history with.
# If False, only skip people whose thread already contains MESSAGE_FINGERPRINT.
SKIP_EXISTING_THREADS = False

CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/"
PROFILE_DIR = "chrome-profile"       # persistent browser profile (keeps you logged in)
SENT_LOG = "sent_log.json"
