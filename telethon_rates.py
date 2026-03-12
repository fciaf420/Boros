"""
DEPRECATED — This file is legacy Python code from the early prototype.
The active system is the TypeScript bot in src/ (run via `npm run boros`).
This file is kept for reference only and will be removed in a future cleanup.
"""

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, List

import requests
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.tl.custom.message import Message


load_dotenv()

API_ID = int(os.getenv("TG_API_ID", "0"))
API_HASH = os.getenv("TG_API_HASH")
PHONE = os.getenv("TG_PHONE")
TARGET_BOT = os.getenv("TARGET_BOT")
ALERT_BOT_TOKEN = os.getenv("ALERT_BOT_TOKEN")
ALERT_CHAT_ID = os.getenv("ALERT_CHAT_ID")
OUTPUT_JSON = os.getenv("OUTPUT_JSON", "rates.json")

# Markets to query from the bot's inline keyboard (exact button text)
MARKETS: List[str] = [
    "BTCUSDT Binance 26 Sept 2025",
    "ETHUSDT Binance 26 Sept 2025",
    "BTCUSDT Binance 26 Sept 2025",
    "ETHUSDT Binance 26 Sept 2025",
    
]

IMPLIED_RE = re.compile(r"Implied\s*APR[:\s]*([\d.]+)%", re.I)
UNDER_RE = re.compile(r"Underlying\s*APR.*?([\d.]+)%", re.I)
DAYS_RE = re.compile(r"(\d+)\s*days", re.I)

LONG_SPREAD_BPS = 50
SHORT_SPREAD_BPS = -50


@dataclass
class MarketData:
    market: str
    implied: float
    underlying: float
    days: Optional[int]
    raw: str


def alert(text: str) -> None:
    """Send alert message using Telegram Bot API (optional)."""
    if not ALERT_BOT_TOKEN or not ALERT_CHAT_ID:
        # Alerts optional: print locally if bot not configured
        print("ALERT:", text)
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{ALERT_BOT_TOKEN}/sendMessage",
            json={"chat_id": ALERT_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception as exc:  # pragma: no cover - network errors
        print("Alert error:", exc)


def parse_rates(msg_text: str) -> tuple[Optional[float], Optional[float], Optional[int]]:
    implied = underlying = days = None
    m1 = IMPLIED_RE.search(msg_text)
    m2 = UNDER_RE.search(msg_text)
    m3 = DAYS_RE.search(msg_text)
    if m1:
        implied = float(m1.group(1))
    if m2:
        underlying = float(m2.group(1))
    if m3:
        days = int(m3.group(1))
    return implied, underlying, days


async def fetch_market(client: TelegramClient, market_button_text: str) -> MarketData:
    if not TARGET_BOT:
        raise RuntimeError("TARGET_BOT is required (bot username) to fetch data")
    # Assume we're already on the main menu; grab the latest menu message
    menu: Message = (await client.get_messages(TARGET_BOT, limit=1))[0]
    try:
        await menu.click(text=market_button_text)
        await asyncio.sleep(0.5)
        reply: Message = (await client.get_messages(TARGET_BOT, limit=1))[0]
    except Exception as exc:
        raise RuntimeError(f"Could not click '{market_button_text}': {exc}")

    implied, underlying, days = parse_rates(reply.message)
    if implied is None or underlying is None:
        reply = (await client.get_messages(TARGET_BOT, limit=1))[0]
        implied, underlying, days = parse_rates(reply.message)

    if implied is None or underlying is None:
        raise RuntimeError(f"Failed to parse rates for {market_button_text}")

    # Go back to the main menu to prepare for the next market
    try:
        await reply.click(text="Back to main menu")
        await asyncio.sleep(0.4)
    except Exception:
        pass

    return MarketData(
        market=market_button_text,
        implied=implied,
        underlying=underlying,
        days=days,
        raw=reply.message[:1000],
    )


async def main() -> None:
    async with TelegramClient("user_session", API_ID, API_HASH) as client:
        if not await client.is_user_authorized():
            await client.send_code_request(PHONE)
            code = input("Enter the login code: ")
            await client.sign_in(PHONE, code)

        # Start once to reach the bot's main menu
        await client.send_message(TARGET_BOT, "/start")
        await asyncio.sleep(0.4)

        results: List[MarketData] = []
        for market in MARKETS:
            try:
                data = await fetch_market(client, market)
                results.append(data)
            except FloodWaitError as exc:
                print("Rate limited, sleeping", exc.seconds)
                time.sleep(exc.seconds + 1)
            except Exception as exc:
                alert(f"⚠️ Could not fetch {market}: {exc}")

        for d in results:
            spread = d.underlying - d.implied
            spread_bps = spread * 100
            msg = (
                f"<b>{d.market}</b>\n"
                f"Implied: {d.implied:.2f}% | Underlying: {d.underlying:.2f}% "
                f"(Spread: {spread:+.2f}%)\n"
                f"Days to mat: {d.days or '?'}"
            )
            if spread_bps >= LONG_SPREAD_BPS:
                alert("🟢 LONG candidate (carry +):\n" + msg)
                # place_trade('LONG', d)
            elif spread_bps <= SHORT_SPREAD_BPS:
                alert("🔴 SHORT candidate (carry +):\n" + msg)
                # place_trade('SHORT', d)
            else:
                alert("ℹ️ Neutral (carry weak):\n" + msg)

        # Save results to JSON for offline use
        try:
            payload = {
                "generated_at": datetime.utcnow().isoformat() + "Z",
                "markets": [
                    {
                        "market": d.market,
                        "implied": d.implied,
                        "underlying": d.underlying,
                        "days": d.days,
                        "spread": round(d.underlying - d.implied, 6),
                        "spread_bps": round((d.underlying - d.implied) * 100, 3),
                        "raw": d.raw,
                    }
                    for d in results
                ],
            }
            with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            print(f"Saved results to {OUTPUT_JSON}")
        except Exception as exc:
            print("Failed to write JSON:", exc)

if __name__ == "__main__":
    asyncio.run(main())
