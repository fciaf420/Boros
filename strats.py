"""
Automated Trading Strategies for Boros Funding Rate Arbitrage
============================================================

Implements specific trading strategies based on successful examples from:
- @ViNc2453's 15% spread arbitrage (6,900% theoretical APY)
- @Rightsideonly's triple profit play (7.08% APY with <0.1 ETH risk)
- @phtevenstrong's capital efficient hedging (1000x margin efficiency)

Key Strategies:
1. Fixed vs Floating Rate Swaps
2. Delta Neutral Carry Trades  
3. Mean Reversion on Extreme Rates
4. Capital Efficient Hedging
"""

import asyncio
import json
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
import logging
from enum import Enum

class StrategyType(Enum):
    SIMPLE_DIRECTIONAL = "simple_directional"
    FIXED_FLOATING_SWAP = "fixed_floating_swap"
    TRIPLE_PROFIT = "triple_profit"
    MEAN_REVERSION = "mean_reversion"  
    DELTA_NEUTRAL_HEDGE = "delta_neutral_hedge"
    CAPITAL_EFFICIENT_HEDGE = "capital_efficient_hedge"
    IMPLIED_APR_BANDS = "implied_apr_bands"

class RiskLevel(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

@dataclass
class Position:
    strategy: StrategyType
    symbol: str
    position_type: str  # "long" or "short"
    size: float
    entry_implied_apr: float
    entry_timestamp: datetime
    collateral_used: float
    leverage: float
    health_factor: float
    expected_apy: float
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None

@dataclass
class MarketCondition:
    symbol: str
    cex_funding_rate: float
    boros_implied_apr: float
    spread: float
    volatility: float
    liquidity: float
    time_to_next_funding: timedelta

class SimpleDirectionalStrategy:
    """
    Simple directional YU trading based on Boros implied vs underlying spread.
    
    Logic:
    - LONG YU when underlying > implied by ≥0.5% (expecting YU price to rise)
    - SHORT YU when implied > underlying by ≥0.5% (expecting YU price to fall)
    - Exit when spread approaches zero (≤0.2%)
    - State tracking prevents entry/exit confusion
    
    Pure on-chain strategy - no external CEX positions required.
    """
    
    def __init__(self):
        self.name = "Simple Directional YU Trading"
        self.risk_level = RiskLevel.LOW
        self.min_spread = 0.005  # 0.5% minimum spread
        self.exit_threshold = 0.002  # 0.2% exit threshold
        self.positions_file = "positions_state.json"
        
    def load_positions(self) -> dict:
        """Load current positions from state file"""
        try:
            with open(self.positions_file, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            return {}
    
    def save_positions(self, positions: dict):
        """Save current positions to state file"""
        with open(self.positions_file, 'w') as f:
            json.dump(positions, f, indent=2)
    
    def evaluate_opportunity(self, market: MarketCondition) -> Optional[Dict]:
        """Evaluate directional opportunity with state tracking"""
        
        positions = self.load_positions()
        current_position = positions.get(market.symbol, "NONE")
        
        spread = market.cex_funding_rate - market.boros_implied_apr  # underlying - implied
        abs_spread = abs(spread)
        
        # Entry conditions (no current position)
        if current_position == "NONE":
            if abs_spread >= self.min_spread:
                if spread > 0:  # underlying > implied
                    action = "ENTER_LONG"
                    new_position = "LONG"
                    rationale = f"Underlying ({market.cex_funding_rate:.2%}) > Implied ({market.boros_implied_apr:.2%})"
                else:  # implied > underlying
                    action = "ENTER_SHORT" 
                    new_position = "SHORT"
                    rationale = f"Implied ({market.boros_implied_apr:.2%}) > Underlying ({market.cex_funding_rate:.2%})"
                
                # Update position state
                positions[market.symbol] = new_position
                self.save_positions(positions)
                
                return {
                    "strategy_type": "simple_directional",
                    "action": action,
                    "position_type": new_position.lower(),
                    "current_spread": spread,
                    "abs_spread": abs_spread,
                    "rationale": rationale,
                    "expected_apy": abs_spread * 1.0,  # No leverage
                    "risk_score": 0.3,  # Low risk
                    "max_position_size": 50000  # Conservative
                }
        
        # Exit conditions (have current position)
        else:
            if abs_spread <= self.exit_threshold:
                action = f"EXIT_{current_position}"
                rationale = f"Spread narrowing to {abs_spread:.2%} - approaching crossover"
                
                # Clear position state
                positions[market.symbol] = "NONE"
                self.save_positions(positions)
                
                return {
                    "strategy_type": "simple_directional",
                    "action": action,
                    "position_type": current_position.lower(),
                    "current_spread": spread,
                    "abs_spread": abs_spread,
                    "rationale": rationale,
                    "expected_apy": 0.0,  # Exit, no expected return
                    "risk_score": 0.1,
                    "max_position_size": 0  # Closing position
                }
        
        return None  # No opportunity (either insufficient spread for entry or not ready to exit)

class FixedFloatingSwapStrategy:
    """
    Based on @ViNc2453's example:
    - Binance ETH funding at 8.5% APY (cost to short)
    - Boros implied +6.33% APY (cost to long YU)
    - 2.17% spread = profitable arbitrage opportunity
    
    Strategy: Exploit spreads between CEX funding rates and Boros implied rates
    """
    
    def __init__(self):
        self.name = "Fixed vs Floating Rate Swap"
        self.risk_level = RiskLevel.MEDIUM
        
    def evaluate_opportunity(self, market: MarketCondition) -> Optional[Dict]:
        """Evaluate if conditions are favorable for fixed/floating swap"""
        
        # Look for meaningful spreads between CEX funding and Boros implied APR
        min_spread = 0.02  # 2% minimum spread (based on corrected analysis)
        
        if abs(market.spread) < min_spread:
            return None
            
        # Determine position based on spread direction
        if market.cex_funding_rate < market.boros_implied_apr:
            # Underlying rate is lower than Boros implied rate
            # Strategy: Short YU (receive implied APR), Long underlying (pay underlying rate)
            strategy_type = "short_yu_long_underlying"
            expected_profit = market.boros_implied_apr - market.cex_funding_rate  # Always positive
        else:
            # Underlying rate is higher than Boros implied rate  
            # Strategy: Long YU (pay implied APR), Short underlying (receive underlying rate)
            strategy_type = "long_yu_short_underlying"
            expected_profit = market.cex_funding_rate - market.boros_implied_apr  # Always positive
            
        # Calculate theoretical APY with leverage
        max_leverage = 1.2  # Boros current limit
        theoretical_apy = expected_profit * max_leverage
        
        # Risk assessment
        risk_score = self._assess_risk(market)
        
        return {
            "strategy_type": strategy_type,
            "expected_profit": expected_profit,
            "theoretical_apy": theoretical_apy,
            "expected_apy": theoretical_apy,  # Add this for alert system compatibility
            "risk_score": min(risk_score, 1.0),  # Cap at 1.0 for display
            "max_position_size": min(market.liquidity * 0.1, 1000000),  # 10% of liquidity or $1M
            "recommended_leverage": min(max_leverage, 1.0 + (expected_profit / 0.1))  # Scale leverage with spread
        }
        
    def _assess_risk(self, market: MarketCondition) -> float:
        """Assess risk score from 0-1"""
        risk_factors = [
            min(market.volatility / 0.5, 1.0),  # Higher volatility = higher risk
            max(0, (0.05 - market.liquidity/1000000) / 0.05),  # Lower liquidity = higher risk  
            max(0, (timedelta(hours=2) - market.time_to_next_funding).seconds / 7200)  # Close to funding = higher risk
        ]
        return sum(risk_factors) / len(risk_factors)

class TripleProfitStrategy:
    """
    Based on @Rightsideonly's example:
    - Short YU-ETH at 6.69% implied APR (collect fixed payments)
    - Receive +8.15% from negative CEX funding rates  
    - Benefit from capital appreciation when implied APR drops
    - Result: 7.08% APY with <0.1 ETH risk
    """
    
    def __init__(self):
        self.name = "Triple Profit Play"
        self.risk_level = RiskLevel.HIGH
        
    def evaluate_opportunity(self, market: MarketCondition) -> Optional[Dict]:
        """Evaluate triple profit opportunity"""
        
        # Conditions for triple profit:
        # 1. High Boros implied APR (>6%) to short and collect fixed payments
        # 2. Negative CEX funding rate to receive funding payments
        # 3. Expectation that implied APR will decrease (capital gains)
        
        min_boros_rate = 0.06  # 6% minimum
        max_cex_rate = -0.001  # Negative funding required
        
        if market.boros_implied_apr < min_boros_rate:
            return None
            
        if market.cex_funding_rate > max_cex_rate:
            return None
            
        # Calculate three profit streams
        fixed_income = market.boros_implied_apr  # From shorting YU
        funding_income = abs(market.cex_funding_rate)  # From negative CEX rates
        
        # Estimate capital appreciation potential
        # Assume implied APR might drop 20-30% from current levels
        implied_apr_drop = market.boros_implied_apr * 0.25  # 25% drop
        capital_gain_rate = implied_apr_drop  # Simplified calculation
        
        total_expected_return = fixed_income + funding_income + capital_gain_rate
        
        # Risk-adjusted return (triple profit has execution risk)
        risk_adjustment = 0.7  # 30% haircut for execution risk
        expected_apy = total_expected_return * risk_adjustment
        
        # Position sizing (conservative due to complexity)
        max_position = min(market.liquidity * 0.05, 500000)  # 5% of liquidity or $500K
        
        return {
            "strategy_type": "triple_profit",
            "fixed_income": fixed_income,
            "funding_income": funding_income, 
            "capital_gain_potential": capital_gain_rate,
            "total_return": total_expected_return,
            "expected_apy": expected_apy,
            "max_position_size": max_position,
            "recommended_leverage": 1.1,  # Conservative leverage
            "risk_score": 0.8  # High risk due to complexity
        }

class MeanReversionStrategy:
    """
    Trade extreme funding rates expecting reversion to mean
    - Short funding rates >40% APY (expect decline)
    - Long funding rates <-15% APY (expect recovery)
    """
    
    def __init__(self):
        self.name = "Mean Reversion Trading"
        self.risk_level = RiskLevel.HIGH
        self.mean_funding_rate = 0.10  # Assume 10% APY long-term mean
        
    def evaluate_opportunity(self, market: MarketCondition) -> Optional[Dict]:
        """Evaluate mean reversion opportunity"""
        
        # Convert CEX funding to annualized rate
        annual_funding = market.cex_funding_rate
        
        # Define extreme thresholds
        extreme_high = 0.40  # 40% APY
        extreme_low = -0.15  # -15% APY
        
        if annual_funding > extreme_high:
            # Rate is extremely high - expect reversion down
            strategy_type = "short_extreme_high"
            expected_reversion = annual_funding - self.mean_funding_rate
            position_type = "short"
            
        elif annual_funding < extreme_low:
            # Rate is extremely low - expect reversion up  
            strategy_type = "long_extreme_low"
            expected_reversion = self.mean_funding_rate - annual_funding
            position_type = "long"
            
        else:
            return None  # Not extreme enough
            
        # Time decay factor - mean reversion typically happens over days/weeks
        time_factor = 0.5  # Assume 50% of move happens in our holding period
        
        expected_profit = expected_reversion * time_factor
        theoretical_apy = expected_profit * 1.2  # With leverage
        
        return {
            "strategy_type": strategy_type,
            "position_type": position_type,
            "current_rate": annual_funding,
            "target_rate": self.mean_funding_rate,
            "expected_reversion": expected_reversion,
            "expected_profit": expected_profit,
            "theoretical_apy": theoretical_apy,
            "max_position_size": 750000,  # $750K limit for volatile strategy
            "recommended_leverage": 1.2,
            "risk_score": 0.9,  # Very high risk
            "stop_loss": 0.15,  # 15% stop loss
            "take_profit": 0.30  # 30% take profit
        }

class ImpliedAPRBandStrategy:
    """
    Implements a simple implied-APR band mean reversion based on @DDangleDan's playbook:
    - Long YU when implied APR is near/under 6%, exit around 6.8–7%
    - Short YU when implied APR is above ~8%, exit around 6–6.8%

    Notes:
    - Works off Boros implied APR only (independent from CEX funding), aligning with YU mark APR view.
    - Provides conservative sizing and optional DCA guidance when entries move against you.
    """

    def __init__(self):
        self.name = "Implied APR Bands"
        self.risk_level = RiskLevel.MEDIUM
        # Default symbol band config; values are annualized APR levels (e.g., 0.06 = 6%)
        self.bands_by_symbol = {
            "ETHUSDT": {
                "long_entry": 0.0600,
                "long_exit": 0.0685,   # mid of 6.5-7.0% window
                "short_entry": 0.0800,
                "short_exit": 0.0680,
                "dca_step": 0.0025,    # add every +25 bps adverse move
                "max_adds": 3
            }
        }
        # Fallback bands for symbols not explicitly configured
        self.default_bands = {
            "long_entry": 0.0600,
            "long_exit": 0.0680,
            "short_entry": 0.0800,
            "short_exit": 0.0680,
            "dca_step": 0.0025,
            "max_adds": 2
        }

    def get_bands(self, symbol: str) -> dict:
        return self.bands_by_symbol.get(symbol, self.default_bands)

    def evaluate_opportunity(self, market: MarketCondition) -> Optional[Dict]:
        bands = self.get_bands(market.symbol)
        apr = market.boros_implied_apr

        opp: Optional[Dict] = None

        # Long setup: buy low APR, target mid band
        if apr <= bands["long_entry"]:
            move = max(0.0, bands["long_exit"] - apr)
            # Map APR move to expected APY proxy: use multiplier to reflect YU mark sensitivity
            sensitivity = 4.0  # heuristic proxy; tune with live data/backtests
            expected_apy = move * sensitivity
            opp = {
                "strategy_type": "implied_apr_bands_long",
                "position_type": "long",
                "current_implied_apr": apr,
                "target_implied_apr": bands["long_exit"],
                "expected_move": move,
                "expected_apy": expected_apy,
                "risk_score": 0.5,  # medium
                "max_position_size": min(market.liquidity * 0.03, 250000),
                "recommended_leverage": 1.0,
                "dca_step": bands["dca_step"],
                "max_adds": bands["max_adds"],
                "stop_loss": None,
                "take_profit": None
            }

        # Short setup: sell high APR, target back to mid band
        elif apr >= bands["short_entry"]:
            move = max(0.0, apr - bands["short_exit"])
            sensitivity = 4.0
            expected_apy = move * sensitivity
            opp = {
                "strategy_type": "implied_apr_bands_short",
                "position_type": "short",
                "current_implied_apr": apr,
                "target_implied_apr": bands["short_exit"],
                "expected_move": move,
                "expected_apy": expected_apy,
                "risk_score": 0.6,  # slightly higher risk given potential to be underwater
                "max_position_size": min(market.liquidity * 0.03, 250000),
                "recommended_leverage": 1.0,
                "dca_step": bands["dca_step"],
                "max_adds": bands["max_adds"],
                "stop_loss": None,
                "take_profit": None
            }

        return opp

class DeltaNeutralHedgeStrategy:
    """
    Based on @phtevenstrong's example:
    - Hedge $70K ETH position with just 0.1 ETH margin
    - 1000x capital efficiency vs traditional hedging
    - Protect against funding rate volatility while maintaining delta neutrality
    """
    
    def __init__(self):
        self.name = "Capital Efficient Delta Neutral Hedge"
        self.risk_level = RiskLevel.LOW
        
    def evaluate_opportunity(self, existing_position: Dict, market: MarketCondition) -> Optional[Dict]:
        """Evaluate hedging opportunity for existing position"""
        
        # Check if we have an existing position that needs hedging
        position_value = existing_position.get("value", 0)
        position_type = existing_position.get("type", "")  # "long" or "short"
        
        if position_value < 10000:  # Only hedge positions >$10K
            return None
            
        # Calculate required hedge size
        hedge_size = position_value  # 1:1 hedge ratio
        
        # Calculate margin efficiency 
        # Example: Hedge $70K with 0.1 ETH (~$300) = 233x efficiency
        required_margin = hedge_size / 200  # Assume 200x efficiency (conservative)
        
        # Determine hedge strategy based on existing position
        if position_type == "long":
            # Long position: hedge with short YU or short perp
            hedge_strategy = "short_yu_hedge"
            hedge_action = "short"
        else:
            # Short position: hedge with long YU or long perp  
            hedge_strategy = "long_yu_hedge"
            hedge_action = "long"
            
        # Calculate hedging cost/benefit
        funding_cost = market.cex_funding_rate  # Cost of maintaining perp hedge
        boros_cost = market.boros_implied_apr   # Cost of YU hedge
        
        # Choose cheaper hedge
        if abs(funding_cost) < abs(boros_cost):
            recommended_hedge = "perp_hedge"
            hedge_cost = funding_cost
        else:
            recommended_hedge = "yu_hedge" 
            hedge_cost = boros_cost
            
        capital_efficiency = position_value / required_margin
        
        return {
            "strategy_type": "delta_neutral_hedge",
            "existing_position_value": position_value,
            "hedge_size": hedge_size,
            "required_margin": required_margin,
            "capital_efficiency": capital_efficiency,
            "recommended_hedge": recommended_hedge,
            "hedge_action": hedge_action,
            "hedge_cost": hedge_cost,
            "risk_score": 0.2,  # Low risk - this is defensive
            "expected_apy": -abs(hedge_cost)  # Cost, not profit
        }

class StrategyManager:
    """Manages multiple trading strategies and position execution"""
    
    def __init__(self, config: Optional[Dict] = None):
        self.config = config or {}
        self.strategies = {
            StrategyType.SIMPLE_DIRECTIONAL: SimpleDirectionalStrategy(),
            StrategyType.IMPLIED_APR_BANDS: ImpliedAPRBandStrategy()
            # Removed strategies requiring external CEX positions:
            # StrategyType.FIXED_FLOATING_SWAP: FixedFloatingSwapStrategy(),
            # StrategyType.TRIPLE_PROFIT: TripleProfitStrategy(),
            # StrategyType.MEAN_REVERSION: MeanReversionStrategy(),
            # StrategyType.DELTA_NEUTRAL_HEDGE: DeltaNeutralHedgeStrategy(),
        }

        # Apply config overrides for implied APR bands if provided
        try:
            bands_cfg = self.config.get("implied_apr_bands")
            if bands_cfg:
                bands_strategy: ImpliedAPRBandStrategy = self.strategies[StrategyType.IMPLIED_APR_BANDS]  # type: ignore
                # Expect shape: { "ETHUSDT": {"long_entry": 0.06, ... }, ... }
                if isinstance(bands_cfg, dict):
                    for symbol, band in bands_cfg.items():
                        if not isinstance(band, dict):
                            continue
                        # Merge defaults with overrides
                        merged = {**bands_strategy.default_bands, **band}
                        bands_strategy.bands_by_symbol[symbol] = merged
        except Exception:
            # Fail-safe: ignore malformed config and keep defaults
            pass
        
        self.active_positions: List[Position] = []
        self.max_total_exposure = 5000000  # $5M total exposure limit
        self.max_positions_per_strategy = 3
        
    async def evaluate_all_strategies(self, market: MarketCondition) -> List[Dict]:
        """Evaluate all strategies for given market conditions"""
        
        opportunities = []
        
        # Simple Directional Strategy
        directional_opp = self.strategies[StrategyType.SIMPLE_DIRECTIONAL].evaluate_opportunity(market)
        if directional_opp:
            directional_opp["strategy"] = StrategyType.SIMPLE_DIRECTIONAL
            opportunities.append(directional_opp)

        # Implied APR Bands (Dan's rules)
        bands_opp = self.strategies[StrategyType.IMPLIED_APR_BANDS].evaluate_opportunity(market)
        if bands_opp:
            bands_opp["strategy"] = StrategyType.IMPLIED_APR_BANDS
            opportunities.append(bands_opp)
            
        return opportunities
    
    def should_execute_strategy(self, opportunity: Dict) -> bool:
        """Determine if strategy should be executed based on risk management rules"""
        
        strategy_type = opportunity["strategy"]
        
        # Check position limits
        current_positions = [p for p in self.active_positions if p.strategy == strategy_type]
        if len(current_positions) >= self.max_positions_per_strategy:
            return False
            
        # Check total exposure
        total_exposure = sum(p.size * p.leverage for p in self.active_positions)
        new_exposure = opportunity["max_position_size"] * opportunity.get("recommended_leverage", 1.0)
        
        if total_exposure + new_exposure > self.max_total_exposure:
            return False
            
        # Risk-based thresholds
        min_expected_returns = {
            StrategyType.SIMPLE_DIRECTIONAL: 0.005,    # 0.5% minimum spread
            StrategyType.IMPLIED_APR_BANDS: 0.01       # 1% proxy threshold for band moves
        }
        
        min_return = min_expected_returns.get(strategy_type, 0.10)
        
        if opportunity.get("expected_apy", 0) < min_return:
            return False
            
        # Risk score check
        max_risk_scores = {
            StrategyType.SIMPLE_DIRECTIONAL: 0.5,      # Low risk
            StrategyType.IMPLIED_APR_BANDS: 0.7
        }
        
        max_risk = max_risk_scores.get(strategy_type, 0.6)
        
        if opportunity.get("risk_score", 1.0) > max_risk:
            return False
            
        return True
    
    async def execute_strategy(self, opportunity: Dict, market: MarketCondition) -> Optional[Position]:
        """Execute the trading strategy"""
        
        strategy_type = opportunity["strategy"]
        
        # Calculate position size based on opportunity and risk
        base_position_size = opportunity["max_position_size"]
        risk_adjustment = 1.0 - opportunity.get("risk_score", 0.5)
        
        position_size = base_position_size * risk_adjustment * 0.5  # Conservative sizing
        
        # Create position object
        position = Position(
            strategy=strategy_type,
            symbol=market.symbol,
            position_type=opportunity.get("position_type", "long"),
            size=position_size,
            entry_implied_apr=market.boros_implied_apr,
            entry_timestamp=datetime.now(),
            collateral_used=position_size / opportunity.get("recommended_leverage", 1.0),
            leverage=opportunity.get("recommended_leverage", 1.0),
            health_factor=1.5,  # Start with healthy position
            expected_apy=opportunity.get("expected_apy", 0),
            stop_loss=opportunity.get("stop_loss"),
            take_profit=opportunity.get("take_profit")
        )
        
        # Log the execution
        print(f"\n🚀 EXECUTING STRATEGY: {strategy_type.value}")
        print(f"Symbol: {market.symbol}")
        print(f"Position Size: ${position_size:,.0f}")
        print(f"Expected APY: {opportunity.get('expected_apy', 0):.2%}")
        print(f"Risk Score: {opportunity.get('risk_score', 0):.2f}")
        
        # Add to active positions
        self.active_positions.append(position)
        
        # TODO: Implement actual trade execution
        # This would involve:
        # 1. Connect to Boros smart contracts
        # 2. Execute YU long/short positions  
        # 3. Execute corresponding CEX trades if needed
        # 4. Monitor position health and funding settlements
        
        return position
    
    def monitor_positions(self):
        """Monitor all active positions for risk management"""
        
        current_time = datetime.now()
        
        for position in self.active_positions[:]:  # Use slice to allow removal during iteration
            
            # Check position age
            position_age = current_time - position.entry_timestamp
            
            # Example risk management rules
            if position.health_factor < 1.1:  # Close to liquidation
                print(f"⚠️  LOW HEALTH FACTOR: {position.symbol} - {position.health_factor:.2f}")
                # TODO: Add collateral or close position
                
            elif position_age > timedelta(days=7):  # Position too old
                print(f"🕐 OLD POSITION: {position.symbol} - {position_age.days} days")
                # TODO: Consider closing position
                
            # Check stop loss / take profit
            # This would require current market prices
            # TODO: Implement P&L calculation and exit logic
    
    def get_portfolio_summary(self) -> Dict:
        """Get summary of current portfolio"""
        
        if not self.active_positions:
            return {"total_positions": 0, "total_exposure": 0, "total_collateral": 0}
            
        total_exposure = sum(p.size * p.leverage for p in self.active_positions)
        total_collateral = sum(p.collateral_used for p in self.active_positions)
        weighted_apy = sum(p.expected_apy * p.size for p in self.active_positions) / sum(p.size for p in self.active_positions)
        
        strategies_used = {}
        for position in self.active_positions:
            strategy = position.strategy.value
            if strategy not in strategies_used:
                strategies_used[strategy] = 0
            strategies_used[strategy] += position.size
            
        return {
            "total_positions": len(self.active_positions),
            "total_exposure": total_exposure,
            "total_collateral": total_collateral,
            "weighted_expected_apy": weighted_apy,
            "strategies_breakdown": strategies_used,
            "utilization": total_exposure / self.max_total_exposure
        }

# Example usage
async def test_strategies():
    """Test strategy evaluation with mock market data"""
    
    manager = StrategyManager()
    
    # Mock market conditions based on real examples
    
    # Example 1: @ViNc2453's scenario
    market1 = MarketCondition(
        symbol="ETHUSDT",
        cex_funding_rate=-0.085,  # -8.5% APY from Binance
        boros_implied_apr=0.0633,  # +6.33% APY from Boros
        spread=0.1483,  # 14.83% spread
        volatility=0.3,
        liquidity=15000000,  # $15M
        time_to_next_funding=timedelta(hours=4)
    )
    
    # Example 2: @Rightsideonly's scenario  
    market2 = MarketCondition(
        symbol="ETHUSDT",
        cex_funding_rate=-0.0815,  # Receiving 8.15% from negative rates
        boros_implied_apr=0.0669,   # Short YU-ETH at 6.69% implied APR
        spread=0.1484,  # Large spread
        volatility=0.25,
        liquidity=20000000,
        time_to_next_funding=timedelta(hours=6)
    )
    
    # Test strategy evaluation
    print("Testing Strategy 1 (Fixed/Floating Swap):")
    opportunities1 = await manager.evaluate_all_strategies(market1)
    for opp in opportunities1:
        print(f"  {opp['strategy'].value}: {opp.get('expected_apy', 0):.2%} APY")
        
    print("\nTesting Strategy 2 (Triple Profit):")
    opportunities2 = await manager.evaluate_all_strategies(market2)
    for opp in opportunities2:
        print(f"  {opp['strategy'].value}: {opp.get('expected_apy', 0):.2%} APY")
        
    # Test execution
    if opportunities1 and manager.should_execute_strategy(opportunities1[0]):
        position = await manager.execute_strategy(opportunities1[0], market1)
        print(f"\nPosition created: {position.symbol} {position.position_type} ${position.size:,.0f}")
        
    # Portfolio summary
    summary = manager.get_portfolio_summary()
    print(f"\nPortfolio Summary:")
    print(f"  Positions: {summary['total_positions']}")
    print(f"  Exposure: ${summary['total_exposure']:,.0f}")
    print(f"  Expected APY: {summary.get('weighted_expected_apy', 0):.2%}")

if __name__ == "__main__":
    asyncio.run(test_strategies())
