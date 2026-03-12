#!/usr/bin/env python3
"""
DEPRECATED — This file is legacy Python code from the early prototype.
The active system is the TypeScript bot in src/ (run via `npm run boros`).
This file is kept for reference only and will be removed in a future cleanup.

──────────────────────────────────────────────────────────────────────────

Boros Strategy Alert Bot - Aligned with Protocol Mechanics
==========================================================

Monitors rates.json and alerts on trading opportunities using strategies
aligned with actual Boros protocol mechanics.

Key Boros Concepts:
- Implied APR: The "price" of YU (market's expected average funding rate)
- Underlying APR: Actual current funding rate from exchange
- Settlement: Periodic P&L realization based on (underlying - fixed) for longs
- Two profit sources: Settlement gains + Capital appreciation from APR movement
"""

import json
import asyncio
import time
import subprocess
import os
import requests
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Import strategy framework with Boros-aligned types
from strats import (
    StrategyManager, StrategyType, BorosMarket, create_boros_market,
    ImpliedAPRBandStrategy, SimpleDirectionalStrategy, SettlementCarryStrategy
)


class BorosAlertBot:
    """
    Alert bot for Boros trading opportunities.

    Uses proper Boros terminology:
    - Implied APR (not "implied yield")
    - Underlying APR (not "CEX funding rate")
    - Settlement mechanics
    """

    def __init__(self, config: Optional[Dict] = None):
        self.config = config or {}
        self.rates_file = "rates.json"
        self.strategy_manager = StrategyManager(config)

        # Load environment variables with fallbacks
        default_refresh_interval = int(os.getenv("DATA_REFRESH_INTERVAL_SECONDS", "1800"))
        self.discord_webhook_url = os.getenv("DISCORD_WEBHOOK_URL")

        # Bot configuration
        self.check_interval = self.config.get("check_interval", default_refresh_interval)
        self.data_refresh_interval = self.config.get("data_refresh_interval", default_refresh_interval)
        self.alert_cooldown = self.config.get("alert_cooldown", 1800)  # 30 min cooldown

        # Minimum thresholds for alerting
        self.min_spread_threshold = self.config.get("min_spread_threshold", 0.005)  # 0.5%
        self.min_settlement_apy = self.config.get("min_settlement_apy", 0.01)  # 1%
        self.min_capital_apy = self.config.get("min_capital_apy", 0.01)  # 1%

        # Tracking
        self.last_data_refresh = 0
        self.last_alerts = {}

        self._print_startup_info()

    def _print_startup_info(self):
        """Print startup information"""
        try:
            print("=" * 60)
            print("🤖 BOROS STRATEGY ALERT BOT")
            print("=" * 60)
            print(f"📊 Data source: {self.rates_file}")
            print(f"⏱️  Check interval: {self.check_interval}s")
            print(f"🔄 Data refresh: {self.data_refresh_interval}s")
            print(f"📉 Min spread threshold: {self.min_spread_threshold:.2%}")
            print(f"💰 Min settlement APY: {self.min_settlement_apy:.2%}")
            print(f"📈 Min capital APY: {self.min_capital_apy:.2%}")
            print("=" * 60)
        except UnicodeEncodeError:
            print("=" * 60)
            print("[BOT] BOROS STRATEGY ALERT BOT")
            print("=" * 60)
            print(f"[INFO] Data source: {self.rates_file}")
            print(f"[INFO] Check interval: {self.check_interval}s")

    def load_rates_data(self) -> Optional[Dict]:
        """Load latest rates from rates.json"""
        try:
            with open(self.rates_file, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            print(f"[ERROR] {self.rates_file} not found. Run telethon_rates.py first.")
            return None
        except json.JSONDecodeError:
            print(f"[ERROR] Invalid JSON in {self.rates_file}")
            return None

    async def refresh_rates_data(self) -> bool:
        """Fetch fresh rates by calling telethon_rates.py"""
        try:
            print("[REFRESH] Refreshing rates data from Telegram bot...")

            result = subprocess.run(
                ["python", "telethon_rates.py"],
                capture_output=True,
                text=True,
                timeout=120
            )

            if result.returncode == 0:
                self.last_data_refresh = time.time()
                print("[SUCCESS] Successfully refreshed rates data")
                return True
            else:
                print(f"[ERROR] Failed to refresh: {result.stderr}")
                return False

        except subprocess.TimeoutExpired:
            print("[ERROR] Timeout while refreshing rates data")
            return False
        except Exception as e:
            print(f"[ERROR] Error refreshing rates data: {e}")
            return False

    def should_refresh_data(self) -> bool:
        """Check if we should refresh data based on interval"""
        return (time.time() - self.last_data_refresh) > self.data_refresh_interval

    def should_send_alert(self, market_symbol: str, strategy_type: str,
                          action: Optional[str] = None) -> bool:
        """Check if we should send alert (avoid spam)"""
        action_part = (action or "").upper()
        alert_key = f"{market_symbol}_{strategy_type}_{action_part}"

        # Always allow exit alerts (safety-first)
        if action_part.startswith("EXIT"):
            return True

        last_alert = self.last_alerts.get(alert_key, 0)
        return (time.time() - last_alert) > self.alert_cooldown

    def send_discord_alert(self, title: str, description: str, color: int = 0x00ff00):
        """Send alert to Discord webhook if configured"""
        if not self.discord_webhook_url:
            return

        try:
            embed = {
                "title": title,
                "description": description,
                "color": color,
                "timestamp": datetime.now().astimezone().isoformat(),
                "footer": {"text": "Boros Strategy Bot | Aligned with Protocol Mechanics"}
            }

            response = requests.post(
                self.discord_webhook_url,
                json={"embeds": [embed]},
                timeout=10
            )

            if response.status_code == 204:
                print("[DISCORD] Alert sent successfully")
            else:
                print(f"[DISCORD] Alert failed: {response.status_code}")

        except Exception as e:
            print(f"[DISCORD] Webhook error: {e}")

    def update_position_state(self, opportunities: List[Dict]):
        """Update position state after conflict resolution"""
        positions_updated = False

        for opp in opportunities:
            if not opp:
                continue

            position_key = opp.get('position_key')
            new_state = opp.get('new_position_state')

            if position_key and new_state is not None:
                try:
                    with open('positions_state.json', 'r') as f:
                        positions = json.load(f)
                except FileNotFoundError:
                    positions = {}

                old_state = positions.get(position_key, 'NONE')
                positions[position_key] = new_state

                with open('positions_state.json', 'w') as f:
                    json.dump(positions, f, indent=2)

                positions_updated = True
                print(f"[POSITION] {position_key}: {old_state} -> {new_state}")

        if not positions_updated:
            print("[INFO] No position updates needed")

    def format_discord_alert(self, opp: Dict, market: BorosMarket) -> tuple:
        """Format opportunity for Discord alert"""
        strategy_type = opp.get('strategy_type', 'unknown')
        action = opp.get('action', 'UNKNOWN')
        is_reversal = opp.get('is_reversal', False)

        # Market info
        market_info = f"{market.base_asset} ({market.exchange} {market.maturity})"

        # Build description based on strategy type
        if strategy_type == "simple_directional":
            settlement_apy = opp.get('expected_settlement_apy', 0)
            capital_apy = opp.get('expected_capital_apy', 0)
            total_apy = opp.get('expected_apy', 0)
            spread = opp.get('current_spread', 0)

            title = "🎯 Simple Directional Alert"
            if is_reversal:
                title = "🔄 POSITION REVERSAL Alert"

            desc_lines = [
                f"**Strategy:** Simple Directional YU Trading",
                f"**Market:** {market_info}",
                f"**Action:** {action}",
                "",
                f"**Boros Metrics:**",
                f"• Implied APR: {market.implied_apr:.2%} (your fixed rate)",
                f"• Underlying APR: {market.underlying_apr:.2%} (floating rate)",
                f"• Spread: {spread:.2%}",
                "",
                f"**Expected Returns:**",
                f"• Settlement APY: {settlement_apy:.2%}",
                f"• Capital APY: {capital_apy:.2%}",
                f"• **Total APY: {total_apy:.2%}**",
                "",
                f"**Risk Score:** {opp.get('risk_score', 0):.2f}/1.0",
            ]

            if is_reversal:
                prev = opp.get('previous_position', '')
                desc_lines.insert(3, f"⚡ **Reversing: {prev} → {action.split('_')[1]}**")

            description = "\n".join(desc_lines)
            color = 0xff0066 if is_reversal else (0x00ff00 if "LONG" in action else 0xff6600)

        elif strategy_type == "implied_apr_bands":
            current_apr = opp.get('current_implied_apr', market.implied_apr)
            target_apr = opp.get('target_implied_apr', current_apr)
            capital_apy = opp.get('expected_capital_apy', 0)

            title = "📊 APR Band Alert"
            if is_reversal:
                title = "🔄 APR Band REVERSAL"

            desc_lines = [
                f"**Strategy:** Implied APR Band Trading",
                f"**Market:** {market_info}",
                f"**Action:** {action}",
                "",
                f"**APR Levels:**",
                f"• Current Implied APR: {current_apr:.2%}",
                f"• Target Implied APR: {target_apr:.2%}",
                f"• Expected Move: {abs(target_apr - current_apr):.2%}",
                "",
                f"**Expected Capital APY:** {capital_apy:.2%}",
                f"**Risk Score:** {opp.get('risk_score', 0):.2f}/1.0",
            ]

            if is_reversal:
                prev = opp.get('previous_position', '')
                desc_lines.insert(3, f"⚡ **Reversing: {prev} → {action.split('_')[1] if '_' in action else action}**")

            description = "\n".join(desc_lines)
            color = 0xff0066 if is_reversal else 0x9933ff

        elif strategy_type == "settlement_carry":
            settlement_apy = opp.get('expected_settlement_apy', 0)

            title = "💰 Settlement Carry Alert"

            desc_lines = [
                f"**Strategy:** Settlement Carry (Pure Yield)",
                f"**Market:** {market_info}",
                f"**Action:** {action}",
                "",
                f"**Settlement Yield:**",
                f"• Implied APR: {market.implied_apr:.2%}",
                f"• Underlying APR: {market.underlying_apr:.2%}",
                f"• **Expected Settlement APY: {settlement_apy:.2%}**",
                "",
                f"**Risk Score:** {opp.get('risk_score', 0):.2f}/1.0",
                f"(Lower risk - predictable settlement income)",
            ]

            description = "\n".join(desc_lines)
            color = 0x33cc33

        else:
            title = f"📢 {strategy_type} Alert"
            description = f"**Market:** {market_info}\n**Action:** {action}"
            color = 0x0099ff

        return title, description, color

    def print_console_alert(self, opp: Dict, market: BorosMarket):
        """Print detailed alert to console"""
        strategy_type = opp.get('strategy_type', 'unknown')
        action = opp.get('action', 'UNKNOWN')
        is_reversal = opp.get('is_reversal', False)

        try:
            print("\n" + "=" * 60)
            if is_reversal:
                print("🔄 POSITION REVERSAL ALERT 🔄")
            else:
                print("🚨 TRADING OPPORTUNITY ALERT 🚨")
            print("=" * 60)

            print(f"\n📊 Market: {market.base_asset} ({market.exchange} {market.maturity})")
            print(f"🎯 Strategy: {strategy_type.replace('_', ' ').title()}")
            print(f"⚡ Action: {action}")

            if is_reversal:
                prev = opp.get('previous_position', '')
                new = action.split('_')[1] if '_' in action else action
                print(f"\n🔄 REVERSAL: {prev} → {new}")

            print(f"\n📈 BOROS METRICS:")
            print(f"   Implied APR:    {market.implied_apr:.2%} (YU 'price')")
            print(f"   Underlying APR: {market.underlying_apr:.2%} (actual rate)")
            print(f"   Spread:         {market.spread:.2%}")

            if market.days_to_maturity:
                print(f"   Days to Maturity: {market.days_to_maturity:.0f}")
                print(f"   Settlements Left: ~{market.settlements_remaining}")

            print(f"\n💰 EXPECTED RETURNS:")
            print(f"   Settlement APY: {opp.get('expected_settlement_apy', 0):.2%}")
            print(f"   Capital APY:    {opp.get('expected_capital_apy', 0):.2%}")
            print(f"   Total APY:      {opp.get('expected_apy', 0):.2%}")

            print(f"\n⚖️  Risk Score: {opp.get('risk_score', 0):.2f}/1.0")
            print(f"💵 Max Position: ${opp.get('max_position_size', 0):,.0f}")

            print(f"\n📝 Rationale: {opp.get('rationale', 'N/A')}")

            # Trading instructions
            print(f"\n" + "-" * 40)
            print("TRADING INSTRUCTIONS:")
            print("-" * 40)

            if "LONG" in action:
                print(f"✅ GO LONG YU on {market.base_asset}")
                print(f"   • Pay fixed rate: {market.implied_apr:.2%} APR")
                print(f"   • Receive floating: Underlying APR (currently {market.underlying_apr:.2%})")
                print(f"   • Profit if: Underlying stays above {market.implied_apr:.2%}")
            elif "SHORT" in action:
                print(f"✅ GO SHORT YU on {market.base_asset}")
                print(f"   • Pay floating: Underlying APR (currently {market.underlying_apr:.2%})")
                print(f"   • Receive fixed: {market.implied_apr:.2%} APR")
                print(f"   • Profit if: Underlying stays below {market.implied_apr:.2%}")
            elif "EXIT" in action:
                pos = action.split('_')[1] if '_' in action else "position"
                print(f"✅ CLOSE {pos} YU position on {market.base_asset}")
                print(f"   • Take profits or cut losses")
                print(f"   • Spread has narrowed or reversed")

            print("=" * 60 + "\n")

        except UnicodeEncodeError:
            # Fallback for Windows console
            print("\n" + "=" * 60)
            if is_reversal:
                print("[REVERSAL] POSITION REVERSAL ALERT")
            else:
                print("[ALERT] TRADING OPPORTUNITY ALERT")
            print("=" * 60)

            print(f"\n[MARKET] {market.base_asset} ({market.exchange} {market.maturity})")
            print(f"[STRATEGY] {strategy_type.replace('_', ' ').title()}")
            print(f"[ACTION] {action}")

            if is_reversal:
                prev = opp.get('previous_position', '')
                new = action.split('_')[1] if '_' in action else action
                print(f"\n[REVERSAL] {prev} -> {new}")

            print(f"\nBOROS METRICS:")
            print(f"   Implied APR:    {market.implied_apr:.2%} (YU 'price')")
            print(f"   Underlying APR: {market.underlying_apr:.2%} (actual rate)")
            print(f"   Spread:         {market.spread:.2%}")

            if market.days_to_maturity:
                print(f"   Days to Maturity: {market.days_to_maturity:.0f}")
                print(f"   Settlements Left: ~{market.settlements_remaining}")

            print(f"\nEXPECTED RETURNS:")
            print(f"   Settlement APY: {opp.get('expected_settlement_apy', 0):.2%}")
            print(f"   Capital APY:    {opp.get('expected_capital_apy', 0):.2%}")
            print(f"   Total APY:      {opp.get('expected_apy', 0):.2%}")

            print(f"\nRisk Score: {opp.get('risk_score', 0):.2f}/1.0")
            print(f"Max Position: ${opp.get('max_position_size', 0):,.0f}")

            print(f"\nRationale: {opp.get('rationale', 'N/A')}")

            print(f"\n" + "-" * 40)
            print("TRADING INSTRUCTIONS:")
            print("-" * 40)

            if "LONG" in action:
                print(f"[LONG] GO LONG YU on {market.base_asset}")
                print(f"   * Pay fixed rate: {market.implied_apr:.2%} APR")
                print(f"   * Receive floating: Underlying APR (currently {market.underlying_apr:.2%})")
                print(f"   * Profit if: Underlying stays above {market.implied_apr:.2%}")
            elif "SHORT" in action:
                print(f"[SHORT] GO SHORT YU on {market.base_asset}")
                print(f"   * Pay floating: Underlying APR (currently {market.underlying_apr:.2%})")
                print(f"   * Receive fixed: {market.implied_apr:.2%} APR")
                print(f"   * Profit if: Underlying stays below {market.implied_apr:.2%}")
            elif "EXIT" in action:
                pos = action.split('_')[1] if '_' in action else "position"
                print(f"[EXIT] CLOSE {pos} YU position on {market.base_asset}")
                print(f"   * Take profits or cut losses")
                print(f"   * Spread has narrowed or reversed")

            print("=" * 60 + "\n")

    async def analyze_opportunities(self):
        """Analyze current rates with proper Boros mechanics"""

        # Check if we need to refresh data
        if self.should_refresh_data():
            await self.refresh_rates_data()

        rates_data = self.load_rates_data()
        if not rates_data:
            return

        print(f"\n[ANALYSIS] Analyzing {len(rates_data['markets'])} markets...")

        # Collect all opportunities
        all_opportunities = []

        for market_data in rates_data['markets']:
            # Convert to BorosMarket
            market = create_boros_market(market_data)

            print(f"\n--- {market.base_asset} ({market.exchange} {market.maturity}) ---")
            print(f"Implied APR: {market.implied_apr:.2%} | Underlying APR: {market.underlying_apr:.2%}")
            print(f"Spread: {market.spread:.2%} ({market.spread_bps:.0f} bps)")

            # Evaluate strategies
            opportunities = await self.strategy_manager.evaluate_all_strategies(market)

            if not opportunities:
                print("No strategies triggered")
                continue

            for opp in opportunities:
                strategy_type = opp.get('strategy_type', 'unknown')
                action = opp.get('action', '')
                total_apy = opp.get('expected_apy', 0)
                settlement_apy = opp.get('expected_settlement_apy', 0)
                capital_apy = opp.get('expected_capital_apy', 0)

                # Apply thresholds
                should_include = False

                if action.startswith("EXIT"):
                    should_include = True  # Always include exits
                elif abs(market.spread) >= self.min_spread_threshold:
                    if settlement_apy >= self.min_settlement_apy or capital_apy >= self.min_capital_apy:
                        should_include = True

                if should_include:
                    # Determine direction
                    direction = None
                    if "LONG" in action:
                        direction = "LONG"
                    elif "SHORT" in action:
                        direction = "SHORT"

                    if direction or action.startswith("EXIT"):
                        all_opportunities.append({
                            'opportunity': opp,
                            'market': market,
                            'strategy_type': strategy_type,
                            'direction': direction,
                            'total_apy': total_apy,
                            'action': action,
                            'is_exit': action.startswith("EXIT")
                        })
                        try:
                            print(f"✓ {strategy_type}: {action} - Total APY: {total_apy:.2%}")
                        except UnicodeEncodeError:
                            print(f"[OK] {strategy_type}: {action} - Total APY: {total_apy:.2%}")

        if not all_opportunities:
            print(f"\n[INFO] No qualifying opportunities at {datetime.now().strftime('%H:%M:%S')}")
            return

        # Global ranking
        print(f"\n" + "=" * 40)
        print("GLOBAL RANKING")
        print("=" * 40)
        print(f"Found {len(all_opportunities)} qualifying opportunities")

        # Sort by total APY (highest first)
        sorted_opps = sorted(all_opportunities, key=lambda x: x['total_apy'], reverse=True)

        print("\nAll Opportunities (by APY):")
        for i, item in enumerate(sorted_opps, 1):
            m = item['market']
            print(f"{i}. {m.base_asset} ({m.exchange}) {item['direction'] or 'EXIT'} - {item['total_apy']:.2%} APY ({item['strategy_type']})")

        # Select best opportunity
        best = sorted_opps[0] if sorted_opps else None

        if best:
            try:
                print(f"\n🏆 BEST: {best['direction'] or 'EXIT'} {best['market'].base_asset} - {best['total_apy']:.2%} APY")
            except UnicodeEncodeError:
                print(f"\n[BEST] {best['direction'] or 'EXIT'} {best['market'].base_asset} - {best['total_apy']:.2%} APY")

        # Update position state
        self.update_position_state([best['opportunity']] if best else [])

        # Send alert for best opportunity
        if best and self.should_send_alert(
            best['market'].symbol,
            best['strategy_type'],
            best['action']
        ):
            opp = best['opportunity']
            market = best['market']

            # Update cooldown
            action_part = (best['action'] or '').upper()
            alert_key = f"{market.symbol}_{best['strategy_type']}_{action_part}"
            self.last_alerts[alert_key] = time.time()

            # Console alert
            self.print_console_alert(opp, market)

            # Discord alert
            title, description, color = self.format_discord_alert(opp, market)
            self.send_discord_alert(title, description, color)
        else:
            print(f"\n[INFO] No new alerts (all in cooldown) at {datetime.now().strftime('%H:%M:%S')}")

    async def run(self):
        """Main bot loop"""
        print(f"\n[START] Bot started at {datetime.now()}")
        print("Press Ctrl+C to stop\n")

        while True:
            try:
                await self.analyze_opportunities()
                await asyncio.sleep(self.check_interval)

            except KeyboardInterrupt:
                print("\n[STOP] Bot stopped by user")
                break
            except Exception as e:
                print(f"[ERROR] {e}")
                print(f"[RETRY] Retrying in {self.check_interval}s...")
                await asyncio.sleep(self.check_interval)


def test_alert():
    """Test the alert system with current rates.json data"""
    print("[TEST] Testing Boros Alert Bot...\n")

    bot = BorosAlertBot({
        "min_spread_threshold": 0.003,  # Lower threshold for testing
        "min_settlement_apy": 0.005,
        "min_capital_apy": 0.005,
        "alert_cooldown": 0,  # No cooldown for testing
        "enable_settlement_carry": True,
    })

    # Skip data refresh in test mode
    bot.last_data_refresh = time.time()

    asyncio.run(bot.analyze_opportunities())


async def main():
    """Main entry point"""
    refresh_interval = int(os.getenv("DATA_REFRESH_INTERVAL_SECONDS", "1800"))

    config = {
        "check_interval": refresh_interval,
        "data_refresh_interval": refresh_interval,
        "min_spread_threshold": 0.005,    # 0.5% minimum spread
        "min_settlement_apy": 0.01,       # 1% minimum settlement APY
        "min_capital_apy": 0.01,          # 1% minimum capital APY
        "alert_cooldown": 1800,           # 30 minute cooldown
        "enable_settlement_carry": False,  # Disabled by default
    }

    bot = BorosAlertBot(config)
    await bot.run()


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "test":
        test_alert()
    else:
        asyncio.run(main())
