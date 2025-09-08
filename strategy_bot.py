#!/usr/bin/env python3
"""
Strategy Alert Bot for Boros Trading Opportunities
================================================

Monitors rates.json and alerts on trading opportunities using the strategy framework.
Focuses on Fixed Floating Rate Arbitrage and other high-probability strategies.
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

# Import our strategy framework (only on-chain strategies)
from strats import (
    StrategyManager, MarketCondition, StrategyType,
    ImpliedAPRBandStrategy
)

class StrategyAlertBot:
    def __init__(self, config: Optional[Dict] = None):
        self.config = config or {}
        self.rates_file = "rates.json"
        self.strategy_manager = StrategyManager(config)
        
        # Load environment variables with fallbacks
        default_refresh_interval = int(os.getenv("DATA_REFRESH_INTERVAL_SECONDS", "1800"))  # 30 minutes default
        self.discord_webhook_url = os.getenv("DISCORD_WEBHOOK_URL")
        
        # Bot configuration for on-chain strategies only
        self.check_interval = self.config.get("check_interval", default_refresh_interval)
        self.data_refresh_interval = self.config.get("data_refresh_interval", default_refresh_interval)
        self.min_expected_move = self.config.get("min_expected_move", 0.01)  # 1% minimum expected move for APR bands
        self.alert_cooldown = self.config.get("alert_cooldown", 1800)  # 30 min cooldown
        
        # Track when we last refreshed data
        self.last_data_refresh = 0
        
        # Track last alerts to avoid spam
        self.last_alerts = {}
        
        # We're focusing ONLY on on-chain Boros data - no external CEX data needed
        # Supporting ImpliedAPRBandStrategy and FixedFloatingSwapStrategy using Boros implied vs underlying rates
        
        try:
            print("🤖 Strategy Alert Bot initialized")
            print(f"📊 Monitoring: {self.rates_file}")
            print(f"⏱️  Check interval: {self.check_interval}s")
            print(f"🔄 Data refresh: {self.data_refresh_interval}s")
            print(f"📈 Min expected move: {self.min_expected_move:.1%}")
        except UnicodeEncodeError:
            print("[BOT] Strategy Alert Bot initialized")
            print(f"[INFO] Monitoring: {self.rates_file}")
            print(f"[INFO] Check interval: {self.check_interval}s")
            print(f"[INFO] Data refresh: {self.data_refresh_interval}s")
            print(f"[INFO] Min expected move: {self.min_expected_move:.1%}")
        
    def load_rates_data(self) -> Optional[Dict]:
        """Load latest rates from rates.json"""
        try:
            with open(self.rates_file, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            print(f"❌ {self.rates_file} not found. Run telethon_rates.py first.")
            return None
        except json.JSONDecodeError:
            print(f"❌ Invalid JSON in {self.rates_file}")
            return None
    
    def get_cex_funding_rate(self, symbol: str) -> float:
        """Not used - we focus on on-chain Boros data only
        
        This method is kept for compatibility but always returns 0.0
        since we've excluded all strategies requiring CEX funding rates.
        """
        return 0.0
    
    async def refresh_rates_data(self) -> bool:
        """Fetch fresh rates by calling telethon_rates.py"""
        try:
            print("🔄 Refreshing rates data from Telegram bot...")
            
            # Run telethon_rates.py as subprocess
            result = subprocess.run(
                ["python", "telethon_rates.py"], 
                capture_output=True, 
                text=True,
                timeout=120  # 2 minute timeout
            )
            
            if result.returncode == 0:
                self.last_data_refresh = time.time()
                print("✅ Successfully refreshed rates data")
                return True
            else:
                print(f"❌ Failed to refresh rates data: {result.stderr}")
                return False
                
        except subprocess.TimeoutExpired:
            print("❌ Timeout while refreshing rates data")
            return False
        except Exception as e:
            print(f"❌ Error refreshing rates data: {e}")
            return False
    
    def should_refresh_data(self) -> bool:
        """Check if we should refresh data based on interval"""
        return (time.time() - self.last_data_refresh) > self.data_refresh_interval
    
    def create_market_condition(self, market_data: Dict, symbol: str) -> MarketCondition:
        """Convert rates.json data to MarketCondition object"""
        
        implied_apr = market_data["implied"] / 100  # Convert percentage to decimal
        underlying_apr = market_data["underlying"] / 100  # Convert percentage to decimal
        
        # Calculate spread from Boros data (Underlying - Implied)
        spread = market_data["spread"] / 100  # Already calculated in rates.json
        
        # Extract liquidity info from raw data if available
        raw_text = market_data.get("raw", "")
        liquidity = 1000000  # Default $1M, could parse from Open Interest
        
        return MarketCondition(
            symbol=symbol,
            cex_funding_rate=underlying_apr,  # Use underlying APR as the "floating" rate for fixed/floating swaps
            boros_implied_apr=implied_apr,
            spread=spread,  # Preserve sign for directional strategies
            volatility=0.3,  # Mock volatility
            liquidity=liquidity,
            time_to_next_funding=timedelta(hours=4)
        )
    
    def should_send_alert(self, symbol: str, strategy_type: str) -> bool:
        """Check if we should send alert (avoid spam)"""
        alert_key = f"{symbol}_{strategy_type}"
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
                "timestamp": datetime.utcnow().isoformat(),
                "footer": {"text": "Boros Strategy Bot"}
            }
            
            payload = {"embeds": [embed]}
            
            response = requests.post(
                self.discord_webhook_url,
                json=payload,
                timeout=10
            )
            
            if response.status_code == 204:
                print("✅ Discord alert sent successfully")
            else:
                print(f"❌ Discord alert failed: {response.status_code}")
                
        except Exception as e:
            print(f"❌ Discord webhook error: {e}")
    
    def send_alert(self, symbol: str, strategy_type: str, opportunity: Dict, market: MarketCondition):
        """Send trading opportunity alert"""
        
        alert_key = f"{symbol}_{strategy_type}"
        self.last_alerts[alert_key] = time.time()
        
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        try:
            print(f"\n🚨 TRADING OPPORTUNITY ALERT 🚨")
            print(f"⏰ Time: {timestamp}")
            print(f"📊 Symbol: {symbol}")
            print(f"🎯 Strategy: {strategy_type.replace('_', ' ').title()}")
        except UnicodeEncodeError:
            print(f"\n[ALERT] TRADING OPPORTUNITY ALERT")
            print(f"Time: {timestamp}")
            print(f"Symbol: {symbol}")
            print(f"Strategy: {strategy_type.replace('_', ' ').title()}")
        print(f"=" * 50)
        
        # Handle supported on-chain strategies
        if strategy_type == "implied_apr_bands":
            self.alert_implied_apr_bands(opportunity, market)
        elif strategy_type == "fixed_floating_swap":
            self.alert_fixed_floating_swap(opportunity, market)
        else:
            print(f"Strategy '{strategy_type}' not supported with current data")
            
        print(f"=" * 50)
        try:
            print(f"💰 Expected APY: {opportunity.get('expected_apy', 0):.2%}")
            print(f"⚖️  Risk Score: {opportunity.get('risk_score', 0):.2f}/1.0")
            print(f"💵 Max Position: ${opportunity.get('max_position_size', 0):,.0f}")
            print(f"🔧 Leverage: {opportunity.get('recommended_leverage', 1.0):.1f}x")
        except UnicodeEncodeError:
            print(f"Expected APY: {opportunity.get('expected_apy', 0):.2%}")
            print(f"Risk Score: {opportunity.get('risk_score', 0):.2f}/1.0")
            print(f"Max Position: ${opportunity.get('max_position_size', 0):,.0f}")
            print(f"Leverage: {opportunity.get('recommended_leverage', 1.0):.1f}x")
        print(f"\n")
        
        # Also send to Discord if configured
        discord_title = f"🚨 {strategy_type.replace('_', ' ').title()} Alert"
        discord_description = f"**Symbol:** {symbol}\n**Expected APY:** {opportunity.get('expected_apy', 0):.2%}\n**Risk Score:** {opportunity.get('risk_score', 0):.2f}/1.0\n**Max Position:** ${opportunity.get('max_position_size', 0):,.0f}"
        
        # Color based on strategy type
        color = 0x00ff00 if strategy_type == "implied_apr_bands" else 0x0099ff  # Green for bands, blue for swaps
        self.send_discord_alert(discord_title, discord_description, color)
    
    def alert_fixed_floating_swap(self, opportunity: Dict, market: MarketCondition):
        """Alert for Fixed vs Floating Rate Swap opportunities"""
        
        strategy_type = opportunity["strategy_type"]
        expected_profit = opportunity["expected_profit"]
        theoretical_apy = opportunity["theoretical_apy"]
        
        print(f"📊 Fixed vs Floating Rate Swap (@ViNc2453's Strategy)")
        print(f"   Boros Implied APR: {market.boros_implied_apr:.2%}")
        print(f"   Underlying APR: {market.cex_funding_rate:.2%}")
        print(f"   Spread: {market.spread:.2%}")
        
        if strategy_type == "short_yu_long_perp":
            print(f"🔴 RECOMMENDED ACTION: SHORT YU + LONG UNDERLYING")
            print(f"   Short YU at {market.boros_implied_apr:.2%} (receive fixed payments)")
            print(f"   Long underlying at {market.cex_funding_rate:.2%} (benefit from higher rate)")
            print(f"   Expected profit: {expected_profit:.2%}")
            
        elif strategy_type == "long_yu_short_perp":
            print(f"🟢 RECOMMENDED ACTION: LONG YU + SHORT UNDERLYING")
            print(f"   Long YU at {market.boros_implied_apr:.2%} (pay fixed rate)")
            print(f"   Short underlying at {market.cex_funding_rate:.2%} (benefit from lower cost)")
            print(f"   Expected profit: {expected_profit:.2%}")
    
    def alert_implied_apr_bands(self, opportunity: Dict, market: MarketCondition):
        """Alert for Implied APR Band opportunities"""
        
        current_apr = opportunity["current_implied_apr"]
        target_apr = opportunity["target_implied_apr"]
        position_type = opportunity["position_type"]
        
        print(f"📊 Implied APR Band Trading (@DDangleDan's Strategy)")
        print(f"   Current APR: {current_apr:.2%}")
        print(f"   Target APR: {target_apr:.2%}")
        
        if position_type == "long":
            print(f"🟢 RECOMMENDED ACTION: GO LONG YU")
            print(f"   APR is low ({current_apr:.2%}) - BUY YU")
            print(f"   Exit target: ~{target_apr:.2%}")
            print(f"   Expected move: {opportunity['expected_move']:.2%}")
            
        elif position_type == "short":
            print(f"🔴 RECOMMENDED ACTION: GO SHORT YU")
            print(f"   APR is high ({current_apr:.2%}) - SELL YU")  
            print(f"   Exit target: ~{target_apr:.2%}")
            print(f"   Expected move: {opportunity['expected_move']:.2%}")
    
    async def analyze_opportunities(self):
        """Analyze current rates and identify opportunities"""
        
        # Check if we need to refresh data first
        if self.should_refresh_data():
            await self.refresh_rates_data()
        
        rates_data = self.load_rates_data()
        if not rates_data:
            return
            
        try:
            print(f"📊 Analyzing {len(rates_data['markets'])} markets...")
        except UnicodeEncodeError:
            print(f"[ANALYSIS] Analyzing {len(rates_data['markets'])} markets...")
        
        opportunities_found = 0
        
        # Group markets by symbol to get the best rates for each
        markets_by_symbol = {}
        for market_data in rates_data['markets']:
            symbol = market_data['market']
            if symbol not in markets_by_symbol:
                markets_by_symbol[symbol] = []
            markets_by_symbol[symbol].append(market_data)
        
        # Analyze each symbol
        for symbol, market_list in markets_by_symbol.items():
            
            # For now, use the market with highest implied APR for analysis
            best_market = max(market_list, key=lambda x: x['implied'])
            
            # Create market condition
            market_condition = self.create_market_condition(best_market, symbol)
            
            print(f"\n--- {symbol} Analysis ---")
            print(f"Boros Implied APR: {market_condition.boros_implied_apr:.2%}")
            print(f"Mock CEX Funding: {market_condition.cex_funding_rate:.2%}")
            print(f"Spread: {market_condition.spread:.2%}")
            
            # Evaluate strategies
            opportunities = await self.strategy_manager.evaluate_all_strategies(market_condition)
            
            if not opportunities:
                print(f"No strategies triggered for {symbol}")
                continue
            
            for opp in opportunities:
                strategy_type = opp["strategy"].value
                expected_apy = opp.get("expected_apy", 0)
                risk_score = opp.get("risk_score", 1.0)
                
                print(f"\nStrategy: {strategy_type}")
                print(f"Expected APY: {expected_apy:.2%}")
                print(f"Risk Score: {risk_score:.2f}")
                print(f"Expected APY: {expected_apy:.2%} vs Min Threshold: {self.min_expected_move:.2%}")
                
                # Evaluate supported on-chain strategies
                if strategy_type == "implied_apr_bands":
                    if expected_apy >= self.min_expected_move:
                        print(f"✓ Expected move threshold met - WOULD ALERT")
                        if self.should_send_alert(symbol, strategy_type):
                            self.send_alert(symbol, strategy_type, opp, market_condition)
                            opportunities_found += 1
                    else:
                        print(f"✗ Expected move too small ({expected_apy:.2%} < {self.min_expected_move:.2%})")
                        
                elif strategy_type == "fixed_floating_swap":
                    min_swap_spread = self.config.get("min_swap_spread", 0.05)  # 5% minimum spread
                    if abs(market_condition.spread) >= min_swap_spread:
                        print(f"✓ Spread threshold met - WOULD ALERT")
                        if self.should_send_alert(symbol, strategy_type):
                            self.send_alert(symbol, strategy_type, opp, market_condition)
                            opportunities_found += 1
                    else:
                        print(f"✗ Spread too small ({market_condition.spread:.2%} < {min_swap_spread:.2%})")
                        
                else:
                    print(f"✗ Strategy '{strategy_type}' not supported with current data")
        
        if opportunities_found == 0:
            try:
                print(f"✅ No new opportunities found at {datetime.now().strftime('%H:%M:%S')}")
            except UnicodeEncodeError:
                print(f"[INFO] No new opportunities found at {datetime.now().strftime('%H:%M:%S')}")
        else:
            try:
                print(f"🎯 Found {opportunities_found} new opportunities!")
            except UnicodeEncodeError:
                print(f"[ALERT] Found {opportunities_found} new opportunities!")
    
    async def run(self):
        """Main bot loop"""
        try:
            print(f"🚀 Strategy Alert Bot started at {datetime.now()}")
        except UnicodeEncodeError:
            print(f"[BOT] Strategy Alert Bot started at {datetime.now()}")
        print(f"Press Ctrl+C to stop\n")
        
        while True:
            try:
                await self.analyze_opportunities()
                await asyncio.sleep(self.check_interval)
                
            except KeyboardInterrupt:
                try:
                    print(f"\n🛑 Bot stopped by user")
                except UnicodeEncodeError:
                    print(f"\n[STOP] Bot stopped by user")
                break
            except Exception as e:
                try:
                    print(f"❌ Error: {e}")
                    print(f"⏳ Retrying in {self.check_interval}s...")
                except UnicodeEncodeError:
                    print(f"[ERROR] Error: {e}")
                    print(f"[RETRY] Retrying in {self.check_interval}s...")
                await asyncio.sleep(self.check_interval)

def create_test_alert():
    """Test the alert system with current rates.json data"""
    try:
        print("🧪 Testing Strategy Alert Bot...\n")
    except UnicodeEncodeError:
        print("[TEST] Testing Strategy Alert Bot...\n")
    
    bot = StrategyAlertBot({
        "min_expected_move": 0.005,  # 0.5% lower threshold for testing
        "min_swap_spread": 0.01,     # 1% lower threshold for testing
        "alert_cooldown": 0   # No cooldown for testing
    })
    
    # Run one analysis
    asyncio.run(bot.analyze_opportunities())

async def main():
    """Main entry point"""
    
    # Configuration for on-chain strategies (uses environment variables)
    refresh_interval = int(os.getenv("DATA_REFRESH_INTERVAL_SECONDS", "1800"))  # 30 minutes default
    config = {
        "check_interval": refresh_interval,        # Same as data refresh interval
        "data_refresh_interval": refresh_interval, # From environment variable
        "min_expected_move": 0.01,                 # 1% minimum expected move for APR bands
        "min_swap_spread": 0.02,                   # 2% minimum spread for fixed/floating swaps
        "alert_cooldown": 1800,                    # 30 minute cooldown between alerts
    }
    
    bot = StrategyAlertBot(config)
    await bot.run()

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        create_test_alert()
    else:
        asyncio.run(main())