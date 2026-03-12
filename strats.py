"""
DEPRECATED — This file is legacy Python code from the early prototype.
The active system is the TypeScript bot in src/ (run via `npm run boros`).
This file is kept for reference only and will be removed in a future cleanup.

──────────────────────────────────────────────────────────────────────────

Boros Trading Strategies - Aligned with Protocol Mechanics
==========================================================

Implements trading strategies based on actual Boros protocol mechanics:
- Yield Units (YU) trading with proper settlement modeling
- Two profit sources: Settlement gains + Implied APR movement
- Time-to-maturity decay
- Proper margin and leverage calculations

Reference: https://pendle.gitbook.io/boros
"""

import asyncio
import json
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
import logging
from enum import Enum
import math

# =============================================================================
# ENUMS AND CONSTANTS
# =============================================================================

class StrategyType(Enum):
    SIMPLE_DIRECTIONAL = "simple_directional"
    IMPLIED_APR_BANDS = "implied_apr_bands"
    SETTLEMENT_CARRY = "settlement_carry"  # New: pure settlement profit strategy

class RiskLevel(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

class PositionSide(Enum):
    LONG = "LONG"
    SHORT = "SHORT"
    NONE = "NONE"

# Settlement intervals by exchange (in hours)
SETTLEMENT_INTERVALS = {
    "Binance": 8,
    "Hyperliquid": 1,
    "Default": 8
}

# =============================================================================
# DATA CLASSES - Aligned with Boros Terminology
# =============================================================================

@dataclass
class BorosMarket:
    """
    Market data structure aligned with Boros terminology.

    Boros Terms:
    - Implied APR: The "price" of YU, market's expected average funding rate until maturity
    - Underlying APR: Current actual funding rate from the exchange
    - Spread: Difference between underlying and implied (our calculation)
    """
    symbol: str                    # Unique market ID (e.g., "BTCUSDT_BINANCE_SEP_2025")
    base_asset: str               # Base asset (e.g., "BTCUSDT")
    exchange: str                 # Exchange name (e.g., "Binance", "Hyperliquid")
    maturity: str                 # Maturity date string (e.g., "26 Sept 2025")
    maturity_date: Optional[datetime] = None  # Parsed maturity date

    # Core Boros metrics (as decimals, e.g., 0.07 = 7%)
    implied_apr: float = 0.0      # Boros Implied APR - the "price" of YU
    underlying_apr: float = 0.0   # Boros Underlying APR - actual funding rate

    # Derived metrics
    spread: float = 0.0           # underlying_apr - implied_apr
    spread_bps: float = 0.0       # Spread in basis points

    # Market depth (from raw data if available)
    open_interest: float = 0.0    # Open interest in base asset units
    volume_24h: float = 0.0       # 24h volume in base asset units

    # Settlement info
    settlement_interval_hours: int = 8  # Hours between settlements

    def __post_init__(self):
        """Calculate derived fields"""
        self.spread = self.underlying_apr - self.implied_apr
        self.spread_bps = self.spread * 10000
        self.settlement_interval_hours = SETTLEMENT_INTERVALS.get(
            self.exchange, SETTLEMENT_INTERVALS["Default"]
        )

    @property
    def days_to_maturity(self) -> Optional[float]:
        """Calculate days until maturity"""
        if self.maturity_date:
            delta = self.maturity_date - datetime.now()
            return max(0, delta.total_seconds() / 86400)
        return None

    @property
    def years_to_maturity(self) -> Optional[float]:
        """Calculate years until maturity (for APR calculations)"""
        days = self.days_to_maturity
        if days is not None:
            return days / 365
        return None

    @property
    def settlements_remaining(self) -> Optional[int]:
        """Estimate number of settlements until maturity"""
        days = self.days_to_maturity
        if days is not None:
            hours_remaining = days * 24
            return int(hours_remaining / self.settlement_interval_hours)
        return None


@dataclass
class YUPosition:
    """
    Represents a Yield Unit position on Boros.

    Per Boros docs:
    - Long YU: Pay fixed (implied at entry), Receive underlying
    - Short YU: Pay underlying, Receive fixed (implied at entry)
    """
    strategy: StrategyType
    market: BorosMarket
    side: PositionSide
    size_yu: float                # Number of YU (notional exposure in base asset)
    entry_implied_apr: float      # Implied APR at entry (becomes your fixed rate)
    entry_timestamp: datetime

    # Margin and leverage
    collateral: float = 0.0       # Collateral backing position
    leverage: float = 1.0         # Position leverage
    initial_margin: float = 0.0   # Margin consumed by position

    # P&L tracking
    realized_settlement_pnl: float = 0.0   # Accumulated from settlements
    unrealized_apr_pnl: float = 0.0        # From implied APR movement

    # Risk metrics
    health_factor: float = 1.5
    liquidation_implied_apr: Optional[float] = None

    @property
    def fixed_apr(self) -> float:
        """Your fixed rate - the implied APR at entry"""
        return self.entry_implied_apr

    @property
    def notional_value(self) -> float:
        """Position notional value in base asset terms"""
        return self.size_yu

    def calculate_settlement_pnl(self, current_underlying_apr: float,
                                   settlement_interval_hours: int) -> float:
        """
        Calculate P&L from a single settlement.

        Per Boros docs:
        - Long: Receive (underlying - fixed) scaled to settlement period
        - Short: Receive (fixed - underlying) scaled to settlement period
        """
        # Scale APR to settlement period (APR is annual, settlement is every X hours)
        period_fraction = settlement_interval_hours / (365 * 24)

        if self.side == PositionSide.LONG:
            # Long: pay fixed, receive underlying
            rate_diff = current_underlying_apr - self.fixed_apr
        elif self.side == PositionSide.SHORT:
            # Short: pay underlying, receive fixed
            rate_diff = self.fixed_apr - current_underlying_apr
        else:
            return 0.0

        # Settlement P&L = notional * rate_diff * period_fraction
        return self.size_yu * rate_diff * period_fraction

    def calculate_position_value(self, current_implied_apr: float,
                                   years_to_maturity: float) -> float:
        """
        Calculate current position value based on implied APR.

        Per Boros docs:
        - YU value = (APR difference from entry) * years_to_maturity * notional
        - Value decays linearly as maturity approaches
        """
        if years_to_maturity <= 0:
            return 0.0

        if self.side == PositionSide.LONG:
            # Long benefits when implied APR rises
            apr_change = current_implied_apr - self.entry_implied_apr
        elif self.side == PositionSide.SHORT:
            # Short benefits when implied APR falls
            apr_change = self.entry_implied_apr - current_implied_apr
        else:
            return 0.0

        return self.size_yu * apr_change * years_to_maturity


@dataclass
class TradingOpportunity:
    """Standardized opportunity output for all strategies"""
    strategy_type: str
    action: str                   # ENTER_LONG, ENTER_SHORT, EXIT_LONG, EXIT_SHORT
    position_type: str            # "long" or "short"
    market: BorosMarket

    # Core metrics
    current_spread: float         # underlying - implied
    implied_apr: float
    underlying_apr: float

    # Expected returns (separated by source)
    expected_settlement_apy: float = 0.0   # From settlement gains
    expected_capital_apy: float = 0.0      # From implied APR movement
    expected_total_apy: float = 0.0        # Combined

    # Risk metrics
    risk_score: float = 0.5       # 0-1 scale
    max_position_size: float = 0.0
    recommended_leverage: float = 1.0

    # Position management
    position_key: str = ""        # For state tracking
    new_position_state: str = ""  # LONG, SHORT, or NONE
    is_reversal: bool = False
    previous_position: str = ""

    # Rationale
    rationale: str = ""

    def to_dict(self) -> Dict:
        """Convert to dictionary for compatibility with existing alert system"""
        return {
            "strategy_type": self.strategy_type,
            "action": self.action,
            "position_type": self.position_type,
            "current_spread": self.current_spread,
            "abs_spread": abs(self.current_spread),
            "implied_apr": self.implied_apr,
            "underlying_apr": self.underlying_apr,
            "expected_settlement_apy": self.expected_settlement_apy,
            "expected_capital_apy": self.expected_capital_apy,
            "expected_apy": self.expected_total_apy,
            "risk_score": self.risk_score,
            "max_position_size": self.max_position_size,
            "recommended_leverage": self.recommended_leverage,
            "position_key": self.position_key,
            "new_position_state": self.new_position_state,
            "is_reversal": self.is_reversal,
            "previous_position": self.previous_position,
            "rationale": self.rationale,
            # Legacy compatibility fields
            "current_implied_apr": self.implied_apr,
            "target_implied_apr": self.implied_apr,  # Will be set by specific strategies
        }


# =============================================================================
# MARGIN CALCULATIONS - Per Boros Docs
# =============================================================================

def calculate_initial_margin(notional_size: float, years_to_maturity: float,
                              implied_apr: float, leverage: float) -> float:
    """
    Calculate initial margin required per Boros formula.

    Formula: InitialMargin = (NotionalSize * YearsToMaturity * ImpliedAPR) / Leverage
    """
    if leverage <= 0:
        leverage = 1.0
    return (notional_size * years_to_maturity * implied_apr) / leverage


def calculate_maintenance_margin(initial_margin: float) -> float:
    """
    Maintenance margin is 50% of initial margin per Boros docs.
    """
    return initial_margin * 0.5


def calculate_health_factor(net_balance: float, maintenance_margin: float) -> float:
    """
    Health factor = Net Balance / Maintenance Margin
    Liquidation occurs when health factor falls to 0.
    """
    if maintenance_margin <= 0:
        return float('inf')
    return net_balance / maintenance_margin


def calculate_liquidation_implied_apr(position: YUPosition, market: BorosMarket) -> Optional[float]:
    """
    Calculate the implied APR at which position gets liquidated.

    This is when Net Balance = Maintenance Margin.
    """
    if not market.years_to_maturity or market.years_to_maturity <= 0:
        return None

    maintenance_margin = calculate_maintenance_margin(position.initial_margin)

    # Simplified calculation - actual would need current collateral state
    # Liquidation APR depends on position direction
    if position.side == PositionSide.LONG:
        # Long gets liquidated when implied APR drops significantly
        # Rough estimate: entry APR - (collateral - maintenance) / (notional * years)
        buffer = (position.collateral - maintenance_margin) / (position.size_yu * market.years_to_maturity)
        return max(0, position.entry_implied_apr - buffer)
    elif position.side == PositionSide.SHORT:
        # Short gets liquidated when implied APR rises significantly
        buffer = (position.collateral - maintenance_margin) / (position.size_yu * market.years_to_maturity)
        return position.entry_implied_apr + buffer

    return None


# =============================================================================
# STRATEGY: Simple Directional YU Trading
# =============================================================================

class SimpleDirectionalStrategy:
    """
    Directional YU trading based on spread between implied and underlying APR.

    Per Boros mechanics:
    - LONG YU when underlying > implied: You pay lower fixed rate, receive higher floating
    - SHORT YU when implied > underlying: You receive higher fixed rate, pay lower floating

    Profit sources:
    1. Settlement gains: Each settlement, collect (underlying - fixed) for longs
    2. Capital gains: If implied APR moves in your favor, position value increases
    """

    def __init__(self):
        self.name = "Simple Directional YU Trading"
        self.risk_level = RiskLevel.LOW

        # Exchange-specific thresholds (tighter for faster settlement)
        self.thresholds = {
            "Hyperliquid": {
                "entry_spread": 0.007,    # 0.7% - tighter due to hourly settlements
                "exit_spread": 0.001,     # 0.1% - faster exits
                "reversal_spread": 0.005  # 0.5% - reversal threshold
            },
            "Binance": {
                "entry_spread": 0.005,    # 0.5% - standard threshold
                "exit_spread": 0.002,     # 0.2% - standard exit
                "reversal_spread": 0.004  # 0.4% - reversal threshold
            }
        }
        self.positions_file = "positions_state.json"

    def load_positions(self) -> dict:
        try:
            with open(self.positions_file, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def save_positions(self, positions: dict):
        with open(self.positions_file, 'w') as f:
            json.dump(positions, f, indent=2)

    def get_thresholds(self, exchange: str) -> dict:
        return self.thresholds.get(exchange, self.thresholds["Binance"])

    def calculate_expected_returns(self, market: BorosMarket, side: PositionSide) -> Tuple[float, float, float]:
        """
        Calculate expected returns from both profit sources.

        Returns: (settlement_apy, capital_apy, total_apy)
        """
        spread = market.spread  # underlying - implied

        # Settlement APY: If spread persists, you earn this per year
        if side == PositionSide.LONG:
            # Long earns when underlying > implied
            settlement_apy = max(0, spread)
        elif side == PositionSide.SHORT:
            # Short earns when implied > underlying
            settlement_apy = max(0, -spread)
        else:
            settlement_apy = 0.0

        # Capital APY: Estimate based on mean reversion assumption
        # Assume spread will revert by 50% over holding period
        mean_reversion_factor = 0.5

        if side == PositionSide.LONG:
            # Long profits if implied APR rises (spread narrows from positive)
            capital_apy = abs(spread) * mean_reversion_factor if spread > 0 else 0
        elif side == PositionSide.SHORT:
            # Short profits if implied APR falls (spread narrows from negative)
            capital_apy = abs(spread) * mean_reversion_factor if spread < 0 else 0
        else:
            capital_apy = 0.0

        total_apy = settlement_apy + capital_apy

        return settlement_apy, capital_apy, total_apy

    def check_exit_conditions(self, market: BorosMarket, current_position: str) -> Optional[TradingOpportunity]:
        """Check if current position should be exited"""
        thresholds = self.get_thresholds(market.exchange)
        spread = market.spread
        abs_spread = abs(spread)

        should_exit = False
        rationale = ""

        # Exit condition 1: Spread narrowing (approaching crossover)
        if abs_spread <= thresholds["exit_spread"]:
            should_exit = True
            rationale = f"Spread narrowed to {abs_spread:.2%} - approaching zero, take profits"

        # Exit condition 2: Strong contrary signal (spread reversed)
        elif current_position == "LONG" and spread <= -thresholds["reversal_spread"]:
            should_exit = True
            rationale = f"Spread reversed to {spread:.2%} (implied > underlying) - exit LONG"
        elif current_position == "SHORT" and spread >= thresholds["reversal_spread"]:
            should_exit = True
            rationale = f"Spread reversed to {spread:.2%} (underlying > implied) - exit SHORT"

        if not should_exit:
            return None

        return TradingOpportunity(
            strategy_type="simple_directional",
            action=f"EXIT_{current_position}",
            position_type=current_position.lower(),
            market=market,
            current_spread=spread,
            implied_apr=market.implied_apr,
            underlying_apr=market.underlying_apr,
            expected_settlement_apy=0.0,
            expected_capital_apy=0.0,
            expected_total_apy=0.0,
            risk_score=0.1,
            max_position_size=0,
            rationale=rationale
        )

    def check_entry_conditions(self, market: BorosMarket) -> Optional[TradingOpportunity]:
        """Check if new position should be entered"""
        thresholds = self.get_thresholds(market.exchange)
        spread = market.spread
        abs_spread = abs(spread)

        if abs_spread < thresholds["entry_spread"]:
            return None

        # Determine direction based on spread
        if spread > 0:
            # Underlying > Implied: LONG YU
            # You pay lower implied (fixed), receive higher underlying
            side = PositionSide.LONG
            action = "ENTER_LONG"
            rationale = f"Underlying ({market.underlying_apr:.2%}) > Implied ({market.implied_apr:.2%}) by {spread:.2%}"
        else:
            # Implied > Underlying: SHORT YU
            # You receive higher implied (fixed), pay lower underlying
            side = PositionSide.SHORT
            action = "ENTER_SHORT"
            rationale = f"Implied ({market.implied_apr:.2%}) > Underlying ({market.underlying_apr:.2%}) by {abs_spread:.2%}"

        # Calculate expected returns
        settlement_apy, capital_apy, total_apy = self.calculate_expected_returns(market, side)

        # Risk assessment based on spread magnitude and time to maturity
        risk_score = 0.3  # Base risk for directional trades
        if market.days_to_maturity and market.days_to_maturity < 30:
            risk_score += 0.2  # Higher risk near maturity (less time for convergence)

        # Position sizing (conservative)
        max_position = min(market.open_interest * 0.05, 50000) if market.open_interest > 0 else 50000

        opp = TradingOpportunity(
            strategy_type="simple_directional",
            action=action,
            position_type=side.value.lower(),
            market=market,
            current_spread=spread,
            implied_apr=market.implied_apr,
            underlying_apr=market.underlying_apr,
            expected_settlement_apy=settlement_apy,
            expected_capital_apy=capital_apy,
            expected_total_apy=total_apy,
            risk_score=risk_score,
            max_position_size=max_position,
            recommended_leverage=1.0,
            rationale=rationale
        )
        opp.new_position_state = side.value

        return opp

    def evaluate_opportunity(self, market: BorosMarket) -> Optional[Dict]:
        """Two-phase evaluation: exit then entry with position reversal detection"""

        positions = self.load_positions()
        key = f"SIMPLE_DIRECTIONAL:{market.symbol}"
        current_position = positions.get(key, "NONE")

        # Phase 1: Check exit conditions if we have a position
        exit_signal = None
        if current_position != "NONE":
            exit_signal = self.check_exit_conditions(market, current_position)

        # Phase 2: Check entry conditions
        entry_signal = self.check_entry_conditions(market)

        # Phase 3: Determine what to return
        if exit_signal and entry_signal:
            # Position reversal
            entry_signal.position_key = key
            entry_signal.is_reversal = True
            entry_signal.previous_position = current_position
            entry_signal.rationale = f"REVERSAL: Exit {current_position} -> Enter {entry_signal.new_position_state}. {entry_signal.rationale}"
            return entry_signal.to_dict()

        elif exit_signal:
            exit_signal.position_key = key
            exit_signal.new_position_state = "NONE"
            return exit_signal.to_dict()

        elif entry_signal and current_position == "NONE":
            entry_signal.position_key = key
            return entry_signal.to_dict()

        return None


# =============================================================================
# STRATEGY: Implied APR Band Trading
# =============================================================================

class ImpliedAPRBandStrategy:
    """
    Trade implied APR mean reversion within defined bands.

    Based on the concept that implied APR tends to oscillate around a mean:
    - LONG YU when implied APR is low (cheap): Bet on APR rising
    - SHORT YU when implied APR is high (expensive): Bet on APR falling

    This is primarily a CAPITAL APPRECIATION strategy.
    Settlement gains/losses are secondary since we're betting on APR movement.

    Key insight from Boros docs:
    - Implied APR is the "price" of YU
    - When implied APR rises, long positions profit
    - When implied APR falls, short positions profit
    """

    def __init__(self):
        self.name = "Implied APR Band Trading"
        self.risk_level = RiskLevel.MEDIUM
        self.positions_file = "positions_state.json"

        # Band configurations by symbol (values are APR as decimals)
        self.bands_by_symbol = {
            "ETHUSDT": {
                "long_entry": 0.0500,    # Buy YU when implied APR <= 5%
                "long_exit": 0.0700,     # Sell when implied APR reaches 7%
                "short_entry": 0.0900,   # Short YU when implied APR >= 9%
                "short_exit": 0.0700,    # Cover when implied APR reaches 7%
                "dca_step": 0.0050,      # Add position every 50bps adverse move
                "max_adds": 3
            },
            "BTCUSDT": {
                "long_entry": 0.0550,
                "long_exit": 0.0750,
                "short_entry": 0.0950,
                "short_exit": 0.0750,
                "dca_step": 0.0050,
                "max_adds": 3
            }
        }

        # Default bands for unconfigured symbols
        self.default_bands = {
            "long_entry": 0.0600,
            "long_exit": 0.0750,
            "short_entry": 0.0900,
            "short_exit": 0.0750,
            "dca_step": 0.0050,
            "max_adds": 2
        }

    def load_positions(self) -> dict:
        try:
            with open(self.positions_file, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def save_positions(self, positions: dict):
        with open(self.positions_file, 'w') as f:
            json.dump(positions, f, indent=2)

    def get_bands(self, base_asset: str) -> dict:
        """Get band configuration for asset"""
        return self.bands_by_symbol.get(base_asset, self.default_bands)

    def calculate_expected_capital_return(self, current_apr: float, target_apr: float,
                                            years_to_maturity: Optional[float]) -> float:
        """
        Calculate expected return from implied APR movement.

        Per Boros docs, position value = notional * APR_change * years_to_maturity
        For APY calculation, we annualize this.
        """
        apr_move = abs(target_apr - current_apr)

        # Sensitivity factor: how much position value changes per APR point
        # This depends on time to maturity
        if years_to_maturity and years_to_maturity > 0:
            # Longer maturity = more sensitivity to APR changes
            sensitivity = min(years_to_maturity * 2, 4.0)  # Cap at 4x
        else:
            sensitivity = 2.0  # Default assumption

        return apr_move * sensitivity

    def check_exit_conditions(self, market: BorosMarket, current_position: str,
                               bands: dict) -> Optional[TradingOpportunity]:
        """Check if current APR band position should be exited"""
        apr = market.implied_apr

        should_exit = False
        target_apr = 0.0

        if current_position == "LONG" and apr >= bands["long_exit"]:
            should_exit = True
            target_apr = bands["long_exit"]
        elif current_position == "SHORT" and apr <= bands["short_exit"]:
            should_exit = True
            target_apr = bands["short_exit"]

        if not should_exit:
            return None

        opp = TradingOpportunity(
            strategy_type="implied_apr_bands",
            action=f"EXIT_{current_position}",
            position_type=current_position.lower(),
            market=market,
            current_spread=market.spread,
            implied_apr=apr,
            underlying_apr=market.underlying_apr,
            expected_settlement_apy=0.0,
            expected_capital_apy=0.0,
            expected_total_apy=0.0,
            risk_score=0.2,
            max_position_size=0,
            rationale=f"Target APR {target_apr:.2%} reached - take profits"
        )
        # Add target APR for display
        opp_dict = opp.to_dict()
        opp_dict["target_implied_apr"] = target_apr
        opp_dict["current_implied_apr"] = apr
        return opp_dict

    def check_entry_conditions(self, market: BorosMarket, bands: dict) -> Optional[TradingOpportunity]:
        """Check if new APR band position should be entered"""
        apr = market.implied_apr

        side = None
        target_apr = 0.0
        rationale = ""

        if apr <= bands["long_entry"]:
            side = PositionSide.LONG
            target_apr = bands["long_exit"]
            rationale = f"Implied APR ({apr:.2%}) is LOW - buy YU expecting rise to {target_apr:.2%}"
        elif apr >= bands["short_entry"]:
            side = PositionSide.SHORT
            target_apr = bands["short_exit"]
            rationale = f"Implied APR ({apr:.2%}) is HIGH - short YU expecting fall to {target_apr:.2%}"
        else:
            return None

        # Calculate expected capital return
        capital_apy = self.calculate_expected_capital_return(apr, target_apr, market.years_to_maturity)

        # Settlement APY is secondary but include it
        # For band trading, we're not primarily betting on settlement direction
        settlement_apy = 0.0  # Neutral assumption

        total_apy = capital_apy + settlement_apy

        # Risk assessment
        risk_score = 0.5  # Base risk for mean reversion trades

        # Higher risk if far from target
        apr_distance = abs(apr - target_apr)
        if apr_distance > 0.03:  # More than 3% to go
            risk_score += 0.1

        # Position sizing
        max_position = min(market.open_interest * 0.03, 250000) if market.open_interest > 0 else 250000

        opp = TradingOpportunity(
            strategy_type="implied_apr_bands",
            action=f"ENTER_{side.value}",
            position_type=side.value.lower(),
            market=market,
            current_spread=market.spread,
            implied_apr=apr,
            underlying_apr=market.underlying_apr,
            expected_settlement_apy=settlement_apy,
            expected_capital_apy=capital_apy,
            expected_total_apy=total_apy,
            risk_score=risk_score,
            max_position_size=max_position,
            recommended_leverage=1.0,
            rationale=rationale
        )
        opp.new_position_state = side.value

        # Convert to dict and add band-specific fields
        opp_dict = opp.to_dict()
        opp_dict["target_implied_apr"] = target_apr
        opp_dict["current_implied_apr"] = apr
        opp_dict["expected_move"] = abs(target_apr - apr)
        opp_dict["dca_step"] = bands["dca_step"]
        opp_dict["max_adds"] = bands["max_adds"]
        opp_dict["new_position"] = side.value  # For compatibility

        return opp_dict

    def evaluate_opportunity(self, market: BorosMarket) -> Optional[Dict]:
        """Two-phase evaluation with position reversal detection"""
        bands = self.get_bands(market.base_asset)

        positions = self.load_positions()
        key = f"APR_BANDS:{market.symbol}"
        current_position = positions.get(key, "NONE")

        # Phase 1: Check exit conditions
        exit_signal = None
        if current_position != "NONE":
            exit_signal = self.check_exit_conditions(market, current_position, bands)

        # Phase 2: Check entry conditions
        entry_signal = self.check_entry_conditions(market, bands)

        # Phase 3: Determine what to return
        if exit_signal and entry_signal:
            # Position reversal
            entry_signal["position_key"] = key
            entry_signal["is_reversal"] = True
            entry_signal["previous_position"] = current_position
            new_pos = entry_signal.get("new_position_state", entry_signal.get("new_position", ""))
            entry_signal["rationale"] = f"REVERSAL: Exit {current_position} -> Enter {new_pos} at {market.implied_apr:.2%} APR"
            if "new_position" in entry_signal:
                del entry_signal["new_position"]
            return entry_signal

        elif exit_signal:
            exit_signal["position_key"] = key
            exit_signal["new_position_state"] = "NONE"
            return exit_signal

        elif entry_signal and current_position == "NONE":
            entry_signal["position_key"] = key
            if "new_position" in entry_signal:
                del entry_signal["new_position"]
            return entry_signal

        return None


# =============================================================================
# STRATEGY: Settlement Carry (Pure Yield)
# =============================================================================

class SettlementCarryStrategy:
    """
    Pure settlement profit strategy - hold position to collect settlement payments.

    Unlike directional strategies that bet on spread convergence, this strategy
    focuses purely on collecting settlement payments over time.

    Best for:
    - Large, persistent spreads
    - Longer time horizons
    - Lower risk tolerance (settlements are more predictable)

    Per Boros docs:
    - Each settlement, collateral is adjusted by (underlying - fixed) for longs
    - Over time, settlements accumulate into realized P&L
    """

    def __init__(self):
        self.name = "Settlement Carry"
        self.risk_level = RiskLevel.LOW
        self.positions_file = "positions_state.json"

        # Minimum spread to justify entering (accounts for fees)
        self.min_spread_threshold = 0.02  # 2% minimum spread

        # Minimum time to maturity (days) - need enough settlements
        self.min_days_to_maturity = 30

    def load_positions(self) -> dict:
        try:
            with open(self.positions_file, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def calculate_expected_settlement_return(self, market: BorosMarket,
                                               side: PositionSide) -> float:
        """
        Calculate expected settlement return if held to maturity.

        Assumes spread persists (conservative estimate).
        """
        spread = market.spread

        if side == PositionSide.LONG:
            # Long earns positive spread
            return max(0, spread)
        elif side == PositionSide.SHORT:
            # Short earns negative spread (when implied > underlying)
            return max(0, -spread)

        return 0.0

    def evaluate_opportunity(self, market: BorosMarket) -> Optional[Dict]:
        """Evaluate settlement carry opportunity"""

        # Check minimum time to maturity
        if market.days_to_maturity and market.days_to_maturity < self.min_days_to_maturity:
            return None

        spread = market.spread
        abs_spread = abs(spread)

        # Check minimum spread threshold
        if abs_spread < self.min_spread_threshold:
            return None

        # Determine direction
        if spread > 0:
            # Underlying > Implied: Long collects positive settlement
            side = PositionSide.LONG
            action = "ENTER_LONG"
            rationale = f"Carry trade: Collect {spread:.2%} settlement yield (underlying > implied)"
        else:
            # Implied > Underlying: Short collects positive settlement
            side = PositionSide.SHORT
            action = "ENTER_SHORT"
            rationale = f"Carry trade: Collect {abs_spread:.2%} settlement yield (implied > underlying)"

        settlement_apy = self.calculate_expected_settlement_return(market, side)

        # Lower risk for carry trades (more predictable)
        risk_score = 0.2

        # Conservative position sizing
        max_position = min(market.open_interest * 0.02, 100000) if market.open_interest > 0 else 100000

        positions = self.load_positions()
        key = f"SETTLEMENT_CARRY:{market.symbol}"
        current_position = positions.get(key, "NONE")

        # Only enter if no existing position
        if current_position != "NONE":
            return None

        opp = TradingOpportunity(
            strategy_type="settlement_carry",
            action=action,
            position_type=side.value.lower(),
            market=market,
            current_spread=spread,
            implied_apr=market.implied_apr,
            underlying_apr=market.underlying_apr,
            expected_settlement_apy=settlement_apy,
            expected_capital_apy=0.0,  # Not betting on APR movement
            expected_total_apy=settlement_apy,
            risk_score=risk_score,
            max_position_size=max_position,
            recommended_leverage=1.0,
            rationale=rationale,
            position_key=key,
            new_position_state=side.value
        )

        return opp.to_dict()


# =============================================================================
# STRATEGY MANAGER
# =============================================================================

class StrategyManager:
    """Manages multiple trading strategies with proper Boros mechanics"""

    def __init__(self, config: Optional[Dict] = None):
        self.config = config or {}

        self.strategies = {
            StrategyType.SIMPLE_DIRECTIONAL: SimpleDirectionalStrategy(),
            StrategyType.IMPLIED_APR_BANDS: ImpliedAPRBandStrategy(),
            StrategyType.SETTLEMENT_CARRY: SettlementCarryStrategy(),
        }

        # Apply config overrides for APR bands if provided
        self._apply_band_config()

        self.max_total_exposure = 5000000
        self.max_positions_per_strategy = 3

    def _apply_band_config(self):
        """Apply configuration overrides for APR band strategy"""
        try:
            bands_cfg = self.config.get("implied_apr_bands")
            if bands_cfg and isinstance(bands_cfg, dict):
                bands_strategy = self.strategies[StrategyType.IMPLIED_APR_BANDS]
                for symbol, band in bands_cfg.items():
                    if isinstance(band, dict):
                        merged = {**bands_strategy.default_bands, **band}
                        bands_strategy.bands_by_symbol[symbol] = merged
        except Exception:
            pass  # Keep defaults on error

    async def evaluate_all_strategies(self, market: BorosMarket) -> List[Dict]:
        """Evaluate all strategies for given market"""
        opportunities = []

        # Simple Directional
        directional_opp = self.strategies[StrategyType.SIMPLE_DIRECTIONAL].evaluate_opportunity(market)
        if directional_opp:
            directional_opp["strategy"] = StrategyType.SIMPLE_DIRECTIONAL
            opportunities.append(directional_opp)

        # Implied APR Bands
        bands_opp = self.strategies[StrategyType.IMPLIED_APR_BANDS].evaluate_opportunity(market)
        if bands_opp:
            bands_opp["strategy"] = StrategyType.IMPLIED_APR_BANDS
            opportunities.append(bands_opp)

        # Settlement Carry (optional - enable via config)
        if self.config.get("enable_settlement_carry", False):
            carry_opp = self.strategies[StrategyType.SETTLEMENT_CARRY].evaluate_opportunity(market)
            if carry_opp:
                carry_opp["strategy"] = StrategyType.SETTLEMENT_CARRY
                opportunities.append(carry_opp)

        return opportunities

    def should_execute_strategy(self, opportunity: Dict) -> bool:
        """Determine if strategy should be executed based on risk management"""

        strategy_type = opportunity.get("strategy")

        # Minimum return thresholds by strategy
        min_returns = {
            StrategyType.SIMPLE_DIRECTIONAL: 0.005,
            StrategyType.IMPLIED_APR_BANDS: 0.01,
            StrategyType.SETTLEMENT_CARRY: 0.02,
        }

        min_return = min_returns.get(strategy_type, 0.01)
        if opportunity.get("expected_apy", 0) < min_return:
            return False

        # Max risk thresholds
        max_risks = {
            StrategyType.SIMPLE_DIRECTIONAL: 0.5,
            StrategyType.IMPLIED_APR_BANDS: 0.7,
            StrategyType.SETTLEMENT_CARRY: 0.4,
        }

        max_risk = max_risks.get(strategy_type, 0.6)
        if opportunity.get("risk_score", 1.0) > max_risk:
            return False

        return True


# =============================================================================
# HELPER: Convert rates.json to BorosMarket
# =============================================================================

def create_boros_market(market_data: Dict) -> BorosMarket:
    """
    Convert rates.json market data to BorosMarket object.

    rates.json format:
    {
        "market": "BTCUSDT",
        "implied": 7.51,        # Percentage
        "underlying": 6.58,     # Percentage
        "spread": -0.93,        # implied - underlying (we need to reverse)
        "exchange": "Binance",
        "maturity": "26 Sept 2025",
        "unique_id": "BTCUSDT_BINANCE_SEP_2025"
    }
    """
    # Convert percentages to decimals
    implied_apr = market_data.get("implied", 0) / 100
    underlying_apr = market_data.get("underlying", 0) / 100

    # Parse maturity date if possible
    maturity_str = market_data.get("maturity", "")
    maturity_date = None
    try:
        # Try common formats
        for fmt in ["%d %b %Y", "%d %B %Y", "%Y-%m-%d"]:
            try:
                maturity_date = datetime.strptime(maturity_str, fmt)
                break
            except ValueError:
                continue
    except Exception:
        pass

    # Parse open interest and volume from raw text if available
    open_interest = 0.0
    volume_24h = 0.0
    raw_text = market_data.get("raw", "")
    if "Open Interest:" in raw_text:
        try:
            oi_part = raw_text.split("Open Interest:")[1].split("\n")[0]
            oi_value = ''.join(c for c in oi_part if c.isdigit() or c == '.')
            open_interest = float(oi_value) if oi_value else 0.0
        except Exception:
            pass
    if "24h Volume:" in raw_text:
        try:
            vol_part = raw_text.split("24h Volume:")[1].split("\n")[0]
            vol_value = ''.join(c for c in vol_part if c.isdigit() or c == '.')
            volume_24h = float(vol_value) if vol_value else 0.0
        except Exception:
            pass

    return BorosMarket(
        symbol=market_data.get("unique_id", market_data.get("market", "UNKNOWN")),
        base_asset=market_data.get("market", "UNKNOWN"),
        exchange=market_data.get("exchange", "Unknown"),
        maturity=maturity_str,
        maturity_date=maturity_date,
        implied_apr=implied_apr,
        underlying_apr=underlying_apr,
        open_interest=open_interest,
        volume_24h=volume_24h
    )


# =============================================================================
# BACKWARD COMPATIBILITY: MarketCondition wrapper
# =============================================================================

@dataclass
class MarketCondition:
    """
    Legacy compatibility wrapper - maps to BorosMarket.

    DEPRECATED: Use BorosMarket directly for new code.
    """
    symbol: str
    cex_funding_rate: float      # Actually underlying_apr
    boros_implied_apr: float     # implied_apr
    spread: float
    volatility: float = 0.3
    liquidity: float = 1000000
    time_to_next_funding: timedelta = field(default_factory=lambda: timedelta(hours=4))

    def to_boros_market(self, exchange: str = "Binance", maturity: str = "Unknown") -> BorosMarket:
        """Convert to BorosMarket"""
        return BorosMarket(
            symbol=self.symbol,
            base_asset=self.symbol.replace("_", "")[:7] if "_" in self.symbol else self.symbol,
            exchange=exchange,
            maturity=maturity,
            implied_apr=self.boros_implied_apr,
            underlying_apr=self.cex_funding_rate,
            open_interest=self.liquidity / 50000,  # Rough estimate
            volume_24h=self.liquidity / 100000
        )


# =============================================================================
# TEST
# =============================================================================

async def test_strategies():
    """Test strategy evaluation with sample data"""

    manager = StrategyManager({"enable_settlement_carry": True})

    # Create test market from typical rates.json data
    test_data = {
        "market": "ETHUSDT",
        "implied": 6.10,
        "underlying": 2.96,
        "spread": -3.14,
        "exchange": "Binance",
        "maturity": "26 Sept 2025",
        "unique_id": "ETHUSDT_BINANCE_SEP_2025",
        "raw": "Open Interest: 6539.08 ETH\n24h Volume: 4143.80 ETH"
    }

    market = create_boros_market(test_data)

    print("=" * 60)
    print("BOROS STRATEGY TEST")
    print("=" * 60)
    print(f"\nMarket: {market.symbol}")
    print(f"Exchange: {market.exchange}")
    print(f"Maturity: {market.maturity}")
    print(f"\nBoros Metrics:")
    print(f"  Implied APR:    {market.implied_apr:.2%} (the 'price' of YU)")
    print(f"  Underlying APR: {market.underlying_apr:.2%} (actual funding rate)")
    print(f"  Spread:         {market.spread:.2%} (underlying - implied)")
    print(f"  Open Interest:  {market.open_interest:.2f} ETH")

    print("\n" + "=" * 60)
    print("STRATEGY EVALUATION")
    print("=" * 60)

    opportunities = await manager.evaluate_all_strategies(market)

    for opp in opportunities:
        strategy = opp.get("strategy", "unknown")
        print(f"\n--- {strategy.value if hasattr(strategy, 'value') else strategy} ---")
        print(f"Action: {opp.get('action')}")
        print(f"Rationale: {opp.get('rationale')}")
        print(f"\nExpected Returns:")
        print(f"  Settlement APY: {opp.get('expected_settlement_apy', 0):.2%}")
        print(f"  Capital APY:    {opp.get('expected_capital_apy', 0):.2%}")
        print(f"  Total APY:      {opp.get('expected_apy', 0):.2%}")
        print(f"\nRisk: {opp.get('risk_score', 0):.2f}/1.0")
        print(f"Max Position: ${opp.get('max_position_size', 0):,.0f}")


if __name__ == "__main__":
    asyncio.run(test_strategies())
