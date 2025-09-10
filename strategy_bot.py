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
    ImpliedAPRBandStrategy, SimpleDirectionalStrategy
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
            try:
                print("🔄 Refreshing rates data from Telegram bot...")
            except UnicodeEncodeError:
                print("[REFRESH] Refreshing rates data from Telegram bot...")
            
            # Run telethon_rates.py as subprocess
            result = subprocess.run(
                ["python", "telethon_rates.py"], 
                capture_output=True, 
                text=True,
                timeout=120  # 2 minute timeout
            )
            
            if result.returncode == 0:
                self.last_data_refresh = time.time()
                try:
                    print("✅ Successfully refreshed rates data")
                except UnicodeEncodeError:
                    print("[SUCCESS] Successfully refreshed rates data")
                return True
            else:
                try:
                    print(f"❌ Failed to refresh rates data: {result.stderr}")
                except UnicodeEncodeError:
                    print(f"[ERROR] Failed to refresh rates data: {result.stderr}")
                return False
                
        except subprocess.TimeoutExpired:
            try:
                print("❌ Timeout while refreshing rates data")
            except UnicodeEncodeError:
                print("[ERROR] Timeout while refreshing rates data")
            return False
        except Exception as e:
            try:
                print(f"❌ Error refreshing rates data: {e}")
            except UnicodeEncodeError:
                print(f"[ERROR] Error refreshing rates data: {e}")
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
    
    def should_send_alert(self, symbol: str, strategy_type: str, action: Optional[str] = None) -> bool:
        """Check if we should send alert (avoid spam).

        - Uses separate cooldown keys for ENTER vs EXIT (by including action).
        - Always allow EXIT alerts to bypass cooldown to ensure timely exits.
        """
        action_part = (action or "").upper()
        alert_key = f"{symbol}_{strategy_type}" + (f"_{action_part}" if action_part else "")

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
                try:
                    print("✅ Discord alert sent successfully")
                except UnicodeEncodeError:
                    print("[SUCCESS] Discord alert sent successfully")
            else:
                try:
                    print(f"❌ Discord alert failed: {response.status_code}")
                except UnicodeEncodeError:
                    print(f"[ERROR] Discord alert failed: {response.status_code}")
                
        except Exception as e:
            try:
                print(f"❌ Discord webhook error: {e}")
            except UnicodeEncodeError:
                print(f"[ERROR] Discord webhook error: {e}")
    
    def send_alert(self, symbol: str, strategy_type: str, opportunity: Dict, market: MarketCondition):
        """Send trading opportunity alert"""
        
        # Use action-aware cooldown key so ENTER and EXIT have independent cooldowns
        action_part = (opportunity.get('action') or '').upper()
        alert_key = f"{symbol}_{strategy_type}" + (f"_{action_part}" if action_part else "")
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
        if strategy_type == "simple_directional":
            self.alert_simple_directional(opportunity, market)
        elif strategy_type == "implied_apr_bands":
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
        
        # Enhanced description with strategy names
        if strategy_type == "simple_directional":
            action = opportunity.get('action', 'UNKNOWN')
            current_spread = opportunity.get('current_spread', 0)
            rationale = opportunity.get('rationale', 'No rationale provided')
            
            discord_description = f"**Strategy:** Simple Directional YU Trading\n**Symbol:** {symbol}\n**Action:** {action}\n**Current Spread:** {current_spread:.2%}\n**Rationale:** {rationale}\n**Expected APY:** {opportunity.get('expected_apy', 0):.2%}\n**Risk Score:** {opportunity.get('risk_score', 0):.2f}/1.0\n**Max Position:** ${opportunity.get('max_position_size', 0):,.0f}"
        elif strategy_type == "fixed_floating_swap":
            action_type = opportunity.get('strategy_type', 'unknown')
            expected_profit = opportunity.get('expected_profit', 0)
            implied_apr = market.boros_implied_apr
            underlying_apr = market.cex_funding_rate
            
            if 'short_yu' in action_type:
                action_desc = f"SHORT YU (receive {implied_apr:.2%}) + LONG underlying (pay {underlying_apr:.2%})"
            else:
                action_desc = f"LONG YU (pay {implied_apr:.2%}) + SHORT underlying (receive {underlying_apr:.2%})"
                
            discord_description = f"**Strategy:** Boros Spread Arbitrage (@ViNc2453)\n**Symbol:** {symbol}\n**Action:** {action_desc}\n**Net Profit:** {expected_profit:.2%} APR\n**Expected APY:** {opportunity.get('expected_apy', 0):.2%}\n**Risk Score:** {opportunity.get('risk_score', 0):.2f}/1.0"
        elif strategy_type == "implied_apr_bands":
            position_type = opportunity.get('position_type', 'unknown')
            current_apr = opportunity.get('current_implied_apr', 0)
            target_apr = opportunity.get('target_implied_apr', 0)
            action = (opportunity.get('action') or '').upper()
            if action.startswith('EXIT'):
                discord_description = (
                    f"**Strategy:** Implied APR Bands (@DDangleDan)\n"
                    f"**Symbol:** {symbol}\n"
                    f"**Action:** EXIT {position_type.upper()} YU\n"
                    f"**Current APR:** {current_apr:.2%}\n"
                    f"**Exit Target:** {target_apr:.2%}\n"
                    f"**Reason:** Target reached; close position to realize move\n"
                    f"**Risk Score:** {opportunity.get('risk_score', 0):.2f}/1.0"
                )
            else:
                discord_description = (
                    f"**Strategy:** Implied APR Bands (@DDangleDan)\n"
                    f"**Symbol:** {symbol}\n"
                    f"**Action:** Go {position_type.title()} YU\n"
                    f"**Current APR:** {current_apr:.2%}\n"
                    f"**Target APR:** {target_apr:.2%}\n"
                    f"**Expected APY:** {opportunity.get('expected_apy', 0):.2%}\n"
                    f"**Risk Score:** {opportunity.get('risk_score', 0):.2f}/1.0\n"
                    f"**Max Position:** ${opportunity.get('max_position_size', 0):,.0f}"
                )
        else:
            discord_description = f"**Symbol:** {symbol}\n**Expected APY:** {opportunity.get('expected_apy', 0):.2%}\n**Risk Score:** {opportunity.get('risk_score', 0):.2f}/1.0\n**Max Position:** ${opportunity.get('max_position_size', 0):,.0f}"
        
        # Color based on strategy type  
        if strategy_type == "simple_directional":
            color = 0xff6600  # Orange for directional
        elif strategy_type == "implied_apr_bands":
            color = 0x00ff00  # Green for bands
        else:
            color = 0x0099ff  # Blue for other strategies
        self.send_discord_alert(discord_title, discord_description, color)
    
    def alert_fixed_floating_swap(self, opportunity: Dict, market: MarketCondition):
        """Alert for Fixed vs Floating Rate Swap opportunities"""
        
        strategy_type = opportunity["strategy_type"]
        expected_profit = opportunity["expected_profit"]
        theoretical_apy = opportunity["theoretical_apy"]
        
        print(f"📊 Boros Implied vs Underlying Spread (@ViNc2453's Strategy)")
        print(f"   Current Spread: {market.spread:.2%} (Implied: {market.boros_implied_apr:.2%} | Underlying: {market.cex_funding_rate:.2%})")
        print(f"   Target Profit: {expected_profit:.2%}")
        
        if strategy_type == "short_yu_long_underlying":
            print(f"🔴 TRADING PLAN: SHORT YU + LONG UNDERLYING")
            print(f"   📍 WHAT TO DO:")
            print(f"      • SHORT YU position (receive {market.boros_implied_apr:.2%} APR)")
            print(f"      • LONG underlying asset (pay {market.cex_funding_rate:.2%} APR)")
            print(f"      • NET PROFIT: {expected_profit:.2%} APR")
            print(f"   📍 WHY: Implied rate ({market.boros_implied_apr:.2%}) > Underlying rate ({market.cex_funding_rate:.2%})")
            print(f"   📍 EXIT: Close when rates converge or profit target hit")
            
        elif strategy_type == "long_yu_short_underlying":
            print(f"🟢 TRADING PLAN: LONG YU + SHORT UNDERLYING")
            print(f"   📍 WHAT TO DO:")
            print(f"      • LONG YU position (pay {market.boros_implied_apr:.2%} APR)")
            print(f"      • SHORT underlying asset (receive {market.cex_funding_rate:.2%} APR)")
            print(f"      • NET PROFIT: {expected_profit:.2%} APR")
            print(f"   📍 WHY: Underlying rate ({market.cex_funding_rate:.2%}) > Implied rate ({market.boros_implied_apr:.2%})")
            print(f"   📍 EXIT: Close when rates converge or profit target hit")
    
    def alert_simple_directional(self, opportunity: Dict, market: MarketCondition):
        """Alert for Simple Directional YU Trading opportunities"""
        
        action = opportunity["action"]
        position_type = opportunity["position_type"]
        current_spread = opportunity["current_spread"]
        abs_spread = opportunity["abs_spread"]
        rationale = opportunity["rationale"]
        
        try:
            print(f"📊 Simple Directional YU Trading (On-Chain Only)")
        except UnicodeEncodeError:
            print(f"[CHART] Simple Directional YU Trading (On-Chain Only)")
        print(f"   Current Spread: {current_spread:.2%} (|{abs_spread:.2%}|)")
        print(f"   {rationale}")
        
        if "ENTER" in action:
            if "LONG" in action:
                try:
                    print(f"🟢 TRADING PLAN: ENTER LONG YU POSITION")
                    print(f"   📍 WHAT TO DO:")
                    print(f"      • BUY YU (go long)")
                    print(f"      • Underlying APR > Implied APR by {abs_spread:.2%}")
                    print(f"      • Expected: YU price should rise as rates converge")
                    print(f"   📍 EXIT CRITERIA:")
                    print(f"      • When spread narrows to ≤0.2% (approaching crossover)")
                    print(f"      • Monitor for reversal signals")
                except UnicodeEncodeError:
                    print(f"[LONG] TRADING PLAN: ENTER LONG YU POSITION")
                    print(f"   [PLAN] WHAT TO DO:")
                    print(f"      * BUY YU (go long)")
                    print(f"      * Underlying APR > Implied APR by {abs_spread:.2%}")
                    print(f"      * Expected: YU price should rise as rates converge")
                    print(f"   [EXIT] EXIT CRITERIA:")
                    print(f"      * When spread narrows to <=0.2% (approaching crossover)")
                    print(f"      * Monitor for reversal signals")
            else:  # SHORT
                try:
                    print(f"🔴 TRADING PLAN: ENTER SHORT YU POSITION")
                    print(f"   📍 WHAT TO DO:")
                    print(f"      • SELL YU (go short)")
                    print(f"      • Implied APR > Underlying APR by {abs_spread:.2%}")
                    print(f"      • Expected: YU price should fall as rates converge")
                    print(f"   📍 EXIT CRITERIA:")
                    print(f"      • When spread narrows to ≤0.2% (approaching crossover)")
                    print(f"      • Monitor for reversal signals")
                except UnicodeEncodeError:
                    print(f"[SHORT] TRADING PLAN: ENTER SHORT YU POSITION")
                    print(f"   [PLAN] WHAT TO DO:")
                    print(f"      * SELL YU (go short)")
                    print(f"      * Implied APR > Underlying APR by {abs_spread:.2%}")
                    print(f"      * Expected: YU price should fall as rates converge")
                    print(f"   [EXIT] EXIT CRITERIA:")
                    print(f"      * When spread narrows to <=0.2% (approaching crossover)")
                    print(f"      * Monitor for reversal signals")
                      
        elif "EXIT" in action:
            current_position = "LONG" if "LONG" in action else "SHORT"
            try:
                print(f"⚪ TRADING PLAN: EXIT {current_position} YU POSITION")
                print(f"   📍 WHAT TO DO:")
                print(f"      • Close your {current_position.lower()} YU position")
                print(f"      • Spread has narrowed to {abs_spread:.2%} - near crossover")
                print(f"      • Take profits/limit losses before reversal")
                print(f"   📍 RATIONALE:")
                print(f"      • Rates are converging - directional move ending")
                print(f"      • Risk of reversal increases as spread approaches zero")
            except UnicodeEncodeError:
                print(f"[EXIT] TRADING PLAN: EXIT {current_position} YU POSITION")
                print(f"   [PLAN] WHAT TO DO:")
                print(f"      * Close your {current_position.lower()} YU position")
                print(f"      * Spread has narrowed to {abs_spread:.2%} - near crossover")
                print(f"      * Take profits/limit losses before reversal")
                print(f"   [REASON] RATIONALE:")
                print(f"      * Rates are converging - directional move ending")
                print(f"      * Risk of reversal increases as spread approaches zero")

    def alert_implied_apr_bands(self, opportunity: Dict, market: MarketCondition):
        """Alert for Implied APR Band opportunities"""
        
        current_apr = opportunity["current_implied_apr"]
        target_apr = opportunity["target_implied_apr"]
        position_type = opportunity["position_type"]
        expected_move = opportunity.get('expected_move', 0)
        action = (opportunity.get('action') or '').upper()
        
        print(f"📊 Implied APR Band Trading (@DDangleDan's Strategy)")
        print(f"   Current APR: {current_apr:.2%} | Target: {target_apr:.2%} | Expected Move: {expected_move:.2%}")
        
        if action.startswith('EXIT'):
            side = 'LONG' if 'LONG' in action else 'SHORT'
            print(f"⚪ TRADING PLAN: EXIT {side} YU")
            print(f"   📍 WHAT TO DO: Close your {side.lower()} YU position")
            print(f"   📍 RATIONALE: Target reached (~{target_apr:.2%}); realize gains and reset")
        else:
            if position_type == "long":
                print(f"🟢 TRADING PLAN: GO LONG YU")
                print(f"   📍 ENTRY: APR is low ({current_apr:.2%}) - BUY YU now")
                print(f"   📍 EXIT: Sell when APR reaches ~{target_apr:.2%}")
                print(f"   📍 DCA SCALING: Add 25% more every +25bps move against you (max 3 adds)")
            elif position_type == "short":
                print(f"🔴 TRADING PLAN: GO SHORT YU")
                print(f"   📍 ENTRY: APR is high ({current_apr:.2%}) - SELL YU now")  
                print(f"   📍 EXIT: Cover when APR drops to ~{target_apr:.2%}")
                print(f"   📍 DCA SCALING: Add 25% more every +25bps move against you (max 3 adds)")
    
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
                if strategy_type == "simple_directional":
                    min_directional_spread = self.config.get("min_directional_spread", 0.005)  # 0.5% minimum spread
                    abs_spread = opp.get("abs_spread", 0)
                    action = (opp.get("action") or "").upper()

                    # Always alert on EXIT actions regardless of entry threshold
                    if action.startswith("EXIT"):
                        if self.should_send_alert(symbol, strategy_type, action):
                            self.send_alert(symbol, strategy_type, opp, market_condition)
                            opportunities_found += 1
                    else:
                        if abs_spread >= min_directional_spread:
                            try:
                                print(f"✓ Spread threshold met - WOULD ALERT")
                            except UnicodeEncodeError:
                                print(f"[CHECK] Spread threshold met - WOULD ALERT")
                            if self.should_send_alert(symbol, strategy_type, action):
                                self.send_alert(symbol, strategy_type, opp, market_condition)
                                opportunities_found += 1
                        else:
                            try:
                                print(f"✗ Spread too small ({abs_spread:.2%} < {min_directional_spread:.2%})")
                            except UnicodeEncodeError:
                                print(f"[X] Spread too small ({abs_spread:.2%} < {min_directional_spread:.2%})")
                        
                elif strategy_type == "implied_apr_bands":
                    action = (opp.get("action") or "").upper()
                    if action.startswith("EXIT"):
                        # Always alert on EXIT for APR bands
                        if self.should_send_alert(symbol, strategy_type, action):
                            self.send_alert(symbol, strategy_type, opp, market_condition)
                            opportunities_found += 1
                    else:
                        if expected_apy >= self.min_expected_move:
                            try:
                                print(f"✓ Expected move threshold met - WOULD ALERT")
                            except UnicodeEncodeError:
                                print(f"[CHECK] Expected move threshold met - WOULD ALERT")
                            if self.should_send_alert(symbol, strategy_type, action):
                                self.send_alert(symbol, strategy_type, opp, market_condition)
                                opportunities_found += 1
                        else:
                            try:
                                print(f"✗ Expected move too small ({expected_apy:.2%} < {self.min_expected_move:.2%})")
                            except UnicodeEncodeError:
                                print(f"[X] Expected move too small ({expected_apy:.2%} < {self.min_expected_move:.2%})")
                        
                elif strategy_type == "fixed_floating_swap":
                    min_swap_spread = self.config.get("min_swap_spread", 0.02)  # 2% minimum spread
                    if abs(market_condition.spread) >= min_swap_spread:
                        try:
                            print(f"✓ Spread threshold met - WOULD ALERT")
                        except UnicodeEncodeError:
                            print(f"[CHECK] Spread threshold met - WOULD ALERT")
                        if self.should_send_alert(symbol, strategy_type):
                            self.send_alert(symbol, strategy_type, opp, market_condition)
                            opportunities_found += 1
                    else:
                        try:
                            print(f"✗ Spread too small ({market_condition.spread:.2%} < {min_swap_spread:.2%})")
                        except UnicodeEncodeError:
                            print(f"[X] Spread too small ({market_condition.spread:.2%} < {min_swap_spread:.2%})")
                        
                else:
                    try:
                        print(f"✗ Strategy '{strategy_type}' not supported with current data")
                    except UnicodeEncodeError:
                        print(f"[X] Strategy '{strategy_type}' not supported with current data")
        
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
        "min_expected_move": 0.005,       # 0.5% lower threshold for testing
        "min_directional_spread": 0.003,  # 0.3% lower threshold for testing
        "min_swap_spread": 0.01,          # 1% lower threshold for testing
        "alert_cooldown": 0               # No cooldown for testing
    })
    # Avoid refreshing data during test; use existing rates.json
    bot.last_data_refresh = time.time()
    
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
        "min_directional_spread": 0.005,           # 0.5% minimum spread for directional strategy
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
