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
    "BTCUSDT Binance 26 Dec 2025",
    "ETHUSDT Binance 26 Dec 2025",
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
        try:
            print("ALERT:", text)
        except UnicodeEncodeError:
            # Fallback for Windows console encoding issues
            print("ALERT:", text.encode('ascii', 'replace').decode('ascii'))
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{ALERT_BOT_TOKEN}/sendMessage",
            json={"chat_id": ALERT_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception as exc:  # pragma: no cover - network errors
        try:
            print("Alert error:", exc)
        except UnicodeEncodeError:
            print("Alert error:", str(exc).encode('ascii', 'replace').decode('ascii'))


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
    
    print(f"Fetching market: {market_button_text}")
    
    # Get the latest menu message and ensure it has the keyboard
    menu: Message = (await client.get_messages(TARGET_BOT, limit=1))[0]
    
    # Check if menu has inline keyboard, if not send /start to get it
    if not (hasattr(menu, 'reply_markup') and menu.reply_markup):
        print("No keyboard found, sending /start...")
        await client.send_message(TARGET_BOT, "/start")
        await asyncio.sleep(1.0)
        menu: Message = (await client.get_messages(TARGET_BOT, limit=1))[0]
    
    try:
        await menu.click(text=market_button_text)
        await asyncio.sleep(1.0)  # Wait longer for response
        reply: Message = (await client.get_messages(TARGET_BOT, limit=1))[0]
        
        # Verify we got market data, not the menu
        if "Select a market you want to view" in reply.message:
            print(f"Still on menu after clicking {market_button_text}, trying again...")
            await asyncio.sleep(1.0)
            await menu.click(text=market_button_text)
            await asyncio.sleep(1.0)
            reply: Message = (await client.get_messages(TARGET_BOT, limit=1))[0]
            
    except Exception as exc:
        try:
            error_msg = str(exc)
            print(f"Click error: {error_msg}")
        except UnicodeEncodeError:
            error_msg = str(exc).encode('ascii', 'replace').decode('ascii')
            print(f"Click error (encoded): {error_msg}")
        raise RuntimeError(f"Could not click '{market_button_text}': {error_msg}")

    implied, underlying, days = parse_rates(reply.message)
    
    if implied is None or underlying is None:
        # Try getting another message in case there's a delay
        await asyncio.sleep(1.0)
        reply = (await client.get_messages(TARGET_BOT, limit=1))[0]
        implied, underlying, days = parse_rates(reply.message)

    if implied is None or underlying is None:
        # Save debug info and fail
        with open(f"debug_{market_button_text.replace(' ', '_').lower()}.txt", "w", encoding="utf-8") as f:
            f.write(reply.message)
        raise RuntimeError(f"Failed to parse rates for {market_button_text}")

    # Go back to the main menu to prepare for the next market
    try:
        await reply.click(text="Back to Main Menu")
        await asyncio.sleep(0.4)
    except Exception as e:
        try:
            # Try alternative text
            await reply.click(text="Back to main menu")
            await asyncio.sleep(0.4)
        except Exception as e2:
            print(f"Warning: Could not click back button: {e2}")
            # Send /start to reset to main menu
            await client.send_message(TARGET_BOT, "/start")
            await asyncio.sleep(0.4)

    # Extract just the market name (e.g., "BTCUSDT") from full button text
    market_name = market_button_text.split()[0] if market_button_text else market_button_text
    
    return MarketData(
        market=market_name,
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
        await asyncio.sleep(1.0)  # Give more time for bot to respond

        results: List[MarketData] = []
        for i, market in enumerate(MARKETS):
            try:
                print(f"\n--- Processing market {i+1}/4: {market} ---")
                data = await fetch_market(client, market)
                results.append(data)
                try:
                    print(f"✅ Successfully fetched {data.market}: Implied {data.implied}% | Underlying {data.underlying}%")
                except UnicodeEncodeError:
                    print(f"[SUCCESS] Fetched {data.market}: Implied {data.implied}% | Underlying {data.underlying}%")
            except FloodWaitError as exc:
                print("Rate limited, sleeping", exc.seconds)
                await asyncio.sleep(exc.seconds + 1)
                # Retry after rate limit
                try:
                    data = await fetch_market(client, market)
                    results.append(data)
                except Exception as retry_exc:
                    alert(f"⚠️ Could not fetch {market} after retry: {retry_exc}")
            except Exception as exc:
                try:
                    print(f"❌ Failed to fetch {market}: {exc}")
                except UnicodeEncodeError:
                    print(f"[FAILED] Could not fetch {market}: {exc}")
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
                "generated_at": datetime.now(timezone.utc).isoformat(),
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
