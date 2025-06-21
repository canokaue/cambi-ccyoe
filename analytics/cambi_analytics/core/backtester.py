"""
CCYOE Backtester - Comprehensive backtesting framework for CCYOE strategies

Simulates the Cross-Collateral Yield Optimization Engine with:
- Historical yield data simulation
- Rebalancing trigger modeling
- Performance attribution analysis
- Risk assessment and stress testing
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, NamedTuple
from datetime import datetime, timedelta
from dataclasses import dataclass
import logging
from copy import deepcopy

from ..utils.metrics import PerformanceMetrics, RiskMetrics
from ..utils.helpers import calculate_business_days


@dataclass
class OptimizationConfig:
    """Configuration for CCYOE optimization parameters"""
    
    # Distribution weights (must sum to 1.0)
    under_supplied_allocation: float = 0.40  # 40%
    strategic_growth_allocation: float = 0.30  # 30%
    proportional_allocation: float = 0.20     # 20%
    treasury_allocation: float = 0.10         # 10%
    
    # Rebalancing parameters
    rebalance_threshold: float = 100          # 1% in basis points
    min_rebalance_interval: int = 1           # Minimum days between rebalances
    max_rebalance_frequency: int = 7          # Maximum rebalances per week
    
    # Asset target yields (in basis points)
    target_yields: Dict[str, float] = None
    
    # Supply caps (in millions USD)
    supply_caps: Dict[str, float] = None
    
    # Transaction costs (in basis points)
    transaction_cost: float = 5               # 0.05%
    gas_cost_usd: float = 50                  # $50 per transaction
    
    def __post_init__(self):
        if self.target_yields is None:
            self.target_yields = {
                'cmBTC': 500,   # 5%
                'cmUSD': 1400,  # 14%
                'cmBRL': 2000   # 20%
            }
            
        if self.supply_caps is None:
            self.supply_caps = {
                'cmBTC': 20,    # $20M
                'cmUSD': 50,    # $50M
                'cmBRL': 1000   # Unlimited (high number)
            }
        
        # Validate allocations sum to 1.0
        total_allocation = (
            self.under_supplied_allocation + 
            self.strategic_growth_allocation + 
            self.proportional_allocation + 
            self.treasury_allocation
        )
        
        if not np.isclose(total_allocation, 1.0):
            raise ValueError(f"Allocations must sum to 1.0, got {total_allocation}")


class BacktestResults(NamedTuple):
    """Container for backtest results"""
    
    # Performance metrics
    total_return: float
    annualized_return: float
    volatility: float
    sharpe_ratio: float
    max_drawdown: float
    calmar_ratio: float
    
    # CCYOE specific metrics
    total_rebalances: int
    rebalance_frequency: float
    avg_excess_yield: float
    yield_improvement: Dict[str, float]
    
    # Cost analysis
    total_transaction_costs: float
    total_gas_costs: float
    net_yield_after_costs: float
    
    # Time series data
    daily_returns: pd.Series
    cumulative_returns: pd.Series
    yield_series: pd.DataFrame
    rebalance_events: pd.DataFrame
    
    # Risk metrics
    var_95: float
    var_99: float
    expected_shortfall: float
    
    # Additional analytics
    correlation_analysis: Dict


class CCYOEBacktester:
    """
    Comprehensive backtesting engine for CCYOE strategies
    
    Simulates the CCYOE protocol behavior over historical data to evaluate:
    - Yield optimization effectiveness
    - Rebalancing frequency and timing
    - Risk-adjusted returns
    - Transaction costs impact
    - Stress test scenarios
    """
    
    def __init__(self, data: pd.DataFrame, config: OptimizationConfig):
        """
        Initialize the backtester
        
        Args:
            data: Historical yield data with columns [date, cmBTC, cmUSD, cmBRL]
            config: CCYOE optimization configuration
        """
        self.data = self._prepare_data(data)
        self.config = config
        self.logger = logging.getLogger(__name__)
        
        # Initialize metrics calculators
        self.performance_metrics = PerformanceMetrics()
        self.risk_metrics = RiskMetrics()
        
        # State tracking
        self.portfolio_state = {}
        self.rebalance_history = []
        self.cost_tracking = []
        
    def _prepare_data(self, data: pd.DataFrame) -> pd.DataFrame:
        """Prepare and validate input data"""
        data = data.copy()
        
        # Ensure date column is datetime
        if 'date' in data.columns:
            data['date'] = pd.to_datetime(data['date'])
            data = data.sort_values('date').reset_index(drop=True)
        
        # Fill missing values with forward fill
        data = data.fillna(method='ffill').fillna(method='bfill')
        
        return data
    
    def run_backtest(
        self, 
        start_date: str, 
        end_date: str,
        initial_portfolio: Optional[Dict[str, float]] = None
    ) -> BacktestResults:
        """
        Run comprehensive backtest
        
        Args:
            start_date: Start date for backtest (YYYY-MM-DD)
            end_date: End date for backtest (YYYY-MM-DD)
            initial_portfolio: Initial portfolio allocation in USD millions
            
        Returns:
            BacktestResults with comprehensive performance metrics
        """
        self.logger.info(f"Starting backtest from {start_date} to {end_date}")
        
        # Filter data for backtest period
        backtest_data = self._filter_data(start_date, end_date)
        
        if len(backtest_data) == 0:
            raise ValueError("No data available for specified date range")
        
        # Initialize portfolio
        if initial_portfolio is None:
            initial_portfolio = {
                'cmBTC': 10.0,   # $10M
                'cmUSD': 25.0,   # $25M
                'cmBRL': 40.0    # $40M
            }
        
        # Run simulation
        simulation_results = self._run_simulation(backtest_data, initial_portfolio)
        
        # Calculate comprehensive results
        results = self._calculate_results(simulation_results, backtest_data)
        
        self.logger.info(f"Backtest completed. Total return: {results.total_return:.2%}")
        
        return results
    
    def _filter_data(self, start_date: str, end_date: str) -> pd.DataFrame:
        """Filter data for backtest period"""
        start = pd.to_datetime(start_date)
        end = pd.to_datetime(end_date)
        
        mask = (self.data['date'] >= start) & (self.data['date'] <= end)
        return self.data[mask].reset_index(drop=True)
    
    def _run_simulation(self, data: pd.DataFrame, initial_portfolio: Dict[str, float]) -> Dict:
        """Run the main simulation loop"""
        
        # Initialize simulation state
        current_portfolio = deepcopy(initial_portfolio)
        daily_values = []
        rebalance_events = []
        daily_yields = []
        last_rebalance_date = None
        
        assets = ['cmBTC', 'cmUSD', 'cmBRL']
        
        for idx, row in data.iterrows():
            current_date = row['date']
            
            # Get current yields for each asset
            current_yields = {asset: row[asset] for asset in assets}
            daily_yields.append({
                'date': current_date,
                **current_yields
            })
            
            # Check if rebalancing is needed
            rebalance_needed, excess_yields = self._check_rebalance_conditions(
                current_yields, current_portfolio, last_rebalance_date, current_date
            )
            
            # Execute rebalancing if needed
            if rebalance_needed:
                rebalance_result = self._execute_rebalancing(
                    current_portfolio, excess_yields, current_yields, current_date
                )
                rebalance_events.append(rebalance_result)
                last_rebalance_date = current_date
            
            # Calculate daily portfolio value
            daily_value = self._calculate_portfolio_value(current_portfolio, current_yields)
            daily_values.append({
                'date': current_date,
                'portfolio_value': daily_value,
                'cmBTC_value': current_portfolio['cmBTC'],
                'cmUSD_value': current_portfolio['cmUSD'],
                'cmBRL_value': current_portfolio['cmBRL']
            })
            
            # Update portfolio values based on yields (compound daily)
            for asset in assets:
                daily_yield_rate = current_yields[asset] / 10000 / 365  # Convert bp to daily rate
                current_portfolio[asset] *= (1 + daily_yield_rate)
        
        return {
            'daily_values': pd.DataFrame(daily_values),
            'rebalance_events': pd.DataFrame(rebalance_events),
            'daily_yields': pd.DataFrame(daily_yields),
            'final_portfolio': current_portfolio
        }
    
    def _check_rebalance_conditions(
        self, 
        current_yields: Dict[str, float],
        current_portfolio: Dict[str, float],
        last_rebalance_date: Optional[datetime],
        current_date: datetime
    ) -> Tuple[bool, Dict[str, float]]:
        """Check if rebalancing conditions are met"""
        
        # Calculate excess yields above target
        excess_yields = {}
        total_excess = 0
        
        for asset, yield_value in current_yields.items():
            target_yield = self.config.target_yields.get(asset, 0)
            excess = max(0, yield_value - target_yield)
            excess_yields[asset] = excess
            total_excess += excess
        
        # Check threshold condition
        threshold_met = total_excess >= self.config.rebalance_threshold
        
        # Check time interval condition
        time_interval_ok = True
        if last_rebalance_date:
            days_since_rebalance = (current_date - last_rebalance_date).days
            time_interval_ok = days_since_rebalance >= self.config.min_rebalance_interval
        
        return threshold_met and time_interval_ok, excess_yields
    
    def _execute_rebalancing(
        self,
        portfolio: Dict[str, float],
        excess_yields: Dict[str, float],
        current_yields: Dict[str, float],
        date: datetime
    ) -> Dict:
        """Execute CCYOE rebalancing logic"""
        
        # Calculate total excess yield available for redistribution
        total_excess = sum(excess_yields.values())
        
        if total_excess <= 0:
            return {}
        
        # Apply CCYOE distribution logic
        redistribution = self._calculate_yield_redistribution(
            portfolio, excess_yields, total_excess
        )
        
        # Apply redistributed yields to portfolio
        rebalance_impact = {}
        total_transaction_cost = 0
        
        for asset, boost in redistribution.items():
            if boost > 0:
                # Convert yield boost to portfolio value increase
                boost_rate = boost / 10000  # Convert bp to decimal
                value_increase = portfolio[asset] * boost_rate
                portfolio[asset] += value_increase
                rebalance_impact[asset] = value_increase
                
                # Add transaction costs
                transaction_cost = value_increase * self.config.transaction_cost / 10000
                portfolio[asset] -= transaction_cost
                total_transaction_cost += transaction_cost
        
        return {
            'date': date,
            'total_excess_yield': total_excess,
            'redistribution': redistribution,
            'portfolio_impact': rebalance_impact,
            'transaction_cost': total_transaction_cost,
            'gas_cost': self.config.gas_cost_usd
        }
    
    def _calculate_yield_redistribution(
        self,
        portfolio: Dict[str, float],
        excess_yields: Dict[str, float],
        total_excess: float
    ) -> Dict[str, float]:
        """Calculate yield redistribution based on CCYOE logic"""
        
        # Calculate allocation amounts
        under_supplied_amount = total_excess * self.config.under_supplied_allocation
        strategic_amount = total_excess * self.config.strategic_growth_allocation
        proportional_amount = total_excess * self.config.proportional_allocation
        treasury_amount = total_excess * self.config.treasury_allocation
        
        redistribution = {'cmBTC': 0, 'cmUSD': 0, 'cmBRL': 0}
        
        # 1. Under-supplied allocation (prioritize cmBTC and cmUSD)
        under_supplied_assets = ['cmBTC', 'cmUSD']
        for asset in under_supplied_assets:
            if under_supplied_amount > 0:
                allocation = under_supplied_amount / len(under_supplied_assets)
                redistribution[asset] += allocation
        
        # 2. Strategic growth allocation (assets with high utilization)
        total_portfolio_value = sum(portfolio.values())
        for asset, value in portfolio.items():
            utilization = value / self.config.supply_caps.get(asset, float('inf')) / 1e6  # Convert to ratio
            if utilization > 0.8:  # High utilization threshold
                allocation = strategic_amount / 3  # Distribute among eligible assets
                redistribution[asset] += allocation
        
        # 3. Proportional allocation (based on portfolio weights)
        for asset, value in portfolio.items():
            weight = value / total_portfolio_value
            allocation = proportional_amount * weight
            redistribution[asset] += allocation
        
        # 4. Treasury allocation (not redistributed to assets)
        # This would go to protocol treasury in real implementation
        
        return redistribution
    
    def _calculate_portfolio_value(
        self, 
        portfolio: Dict[str, float], 
        current_yields: Dict[str, float]
    ) -> float:
        """Calculate total portfolio value"""
        return sum(portfolio.values())
    
    def _calculate_results(self, simulation_results: Dict, data: pd.DataFrame) -> BacktestResults:
        """Calculate comprehensive backtest results"""
        
        daily_values = simulation_results['daily_values']
        rebalance_events = simulation_results['rebalance_events']
        daily_yields = simulation_results['daily_yields']
        
        # Calculate returns
        daily_values['returns'] = daily_values['portfolio_value'].pct_change()
        daily_returns = daily_values['returns'].dropna()
        
        # Calculate cumulative returns
        cumulative_returns = (1 + daily_returns).cumprod() - 1
        
        # Basic performance metrics
        total_return = cumulative_returns.iloc[-1]
        annualized_return = (1 + total_return) ** (252 / len(daily_returns)) - 1
        volatility = daily_returns.std() * np.sqrt(252)
        sharpe_ratio = annualized_return / volatility if volatility > 0 else 0
        
        # Drawdown analysis
        cumulative_wealth = (1 + daily_returns).cumprod()
        running_max = cumulative_wealth.expanding().max()
        drawdown = (cumulative_wealth - running_max) / running_max
        max_drawdown = drawdown.min()
        calmar_ratio = annualized_return / abs(max_drawdown) if max_drawdown != 0 else 0
        
        # CCYOE specific metrics
        total_rebalances = len(rebalance_events)
        days_total = len(daily_values)
        rebalance_frequency = total_rebalances / (days_total / 252) if days_total > 0 else 0  # Per year
        
        # Calculate yield improvements
        baseline_yields = {asset: self.config.target_yields[asset] for asset in self.config.target_yields}
        actual_avg_yields = daily_yields[['cmBTC', 'cmUSD', 'cmBRL']].mean()
        yield_improvement = {
            asset: actual_avg_yields[asset] - baseline_yields[asset] 
            for asset in baseline_yields
        }
        
        avg_excess_yield = sum([
            max(0, actual_avg_yields[asset] - baseline_yields[asset]) 
            for asset in baseline_yields
        ]) / len(baseline_yields)
        
        # Cost analysis
        total_transaction_costs = rebalance_events['transaction_cost'].sum() if len(rebalance_events) > 0 else 0
        total_gas_costs = rebalance_events['gas_cost'].sum() if len(rebalance_events) > 0 else 0
        net_yield_after_costs = total_return - (total_transaction_costs + total_gas_costs) / daily_values['portfolio_value'].iloc[0]
        
        # Risk metrics
        var_95 = self.risk_metrics.calculate_var(daily_returns, confidence=0.95)
        var_99 = self.risk_metrics.calculate_var(daily_returns, confidence=0.99)
        expected_shortfall = self.risk_metrics.calculate_expected_shortfall(daily_returns, confidence=0.95)
        
        # Correlation analysis
        correlation_analysis = self._analyze_correlations(daily_yields)
        
        return BacktestResults(
            total_return=total_return,
            annualized_return=annualized_return,
            volatility=volatility,
            sharpe_ratio=sharpe_ratio,
            max_drawdown=max_drawdown,
            calmar_ratio=calmar_ratio,
            total_rebalances=total_rebalances,
            rebalance_frequency=rebalance_frequency,
            avg_excess_yield=avg_excess_yield,
            yield_improvement=yield_improvement,
            total_transaction_costs=total_transaction_costs,
            total_gas_costs=total_gas_costs,
            net_yield_after_costs=net_yield_after_costs,
            daily_returns=daily_returns,
            cumulative_returns=cumulative_returns,
            yield_series=daily_yields,
            rebalance_events=rebalance_events,
            var_95=var_95,
            var_99=var_99,
            expected_shortfall=expected_shortfall,
            correlation_analysis=correlation_analysis
        )
    
    def _analyze_correlations(self, daily_yields: pd.DataFrame) -> Dict:
        """Analyze yield correlations"""
        assets = ['cmBTC', 'cmUSD', 'cmBRL']
        corr_matrix = daily_yields[assets].corr()
        
        return {
            'correlation_matrix': corr_matrix.to_dict(),
            'average_correlation': corr_matrix.values[np.triu_indices_from(corr_matrix.values, k=1)].mean(),
            'max_correlation': corr_matrix.values[np.triu_indices_from(corr_matrix.values, k=1)].max(),
            'min_correlation': corr_matrix.values[np.triu_indices_from(corr_matrix.values, k=1)].min()
        }
    
    def run_stress_test(
        self, 
        start_date: str, 
        end_date: str,
        stress_scenarios: List[Dict]
    ) -> Dict[str, BacktestResults]:
        """
        Run stress tests under various scenarios
        
        Args:
            start_date: Start date for stress test
            end_date: End date for stress test
            stress_scenarios: List of stress scenario configurations
            
        Returns:
            Dictionary mapping scenario names to backtest results
        """
        stress_results = {}
        
        for scenario in stress_scenarios:
            scenario_name = scenario.get('name', 'unnamed_scenario')
            
            # Apply stress scenario to data
            stressed_data = self._apply_stress_scenario(scenario)
            
            # Create temporary backtester with stressed data
            temp_backtester = CCYOEBacktester(stressed_data, self.config)
            
            # Run backtest
            results = temp_backtester.run_backtest(start_date, end_date)
            stress_results[scenario_name] = results
        
        return stress_results
    
    def _apply_stress_scenario(self, scenario: Dict) -> pd.DataFrame:
        """Apply stress scenario to historical data"""
        stressed_data = self.data.copy()
        
        scenario_type = scenario.get('type', 'yield_shock')
        
        if scenario_type == 'yield_shock':
            # Apply yield shock to specific assets
            for asset, shock in scenario.get('shocks', {}).items():
                if asset in stressed_data.columns:
                    stressed_data[asset] += shock
        
        elif scenario_type == 'volatility_increase':
            # Increase volatility by scaling daily changes
            volatility_multiplier = scenario.get('multiplier', 1.5)
            for asset in ['cmBTC', 'cmUSD', 'cmBRL']:
                if asset in stressed_data.columns:
                    mean_yield = stressed_data[asset].mean()
                    deviations = stressed_data[asset] - mean_yield
                    stressed_data[asset] = mean_yield + deviations * volatility_multiplier
        
        elif scenario_type == 'correlation_breakdown':
            # Randomize yields to simulate correlation breakdown
            correlation_factor = scenario.get('correlation_factor', 0.1)
            for asset in ['cmBTC', 'cmUSD', 'cmBRL']:
                if asset in stressed_data.columns:
                    noise = np.random.normal(0, stressed_data[asset].std() * correlation_factor, len(stressed_data))
                    stressed_data[asset] += noise
        
        return stressed_data
    
    def optimize_parameters(
        self, 
        start_date: str, 
        end_date: str,
        parameter_ranges: Dict,
        optimization_metric: str = 'sharpe_ratio'
    ) -> Tuple[OptimizationConfig, BacktestResults]:
        """
        Optimize CCYOE parameters using grid search
        
        Args:
            start_date: Start date for optimization
            end_date: End date for optimization
            parameter_ranges: Dictionary of parameter ranges to test
            optimization_metric: Metric to optimize ('sharpe_ratio', 'total_return', etc.)
            
        Returns:
            Tuple of (optimal_config, best_results)
        """
        best_config = None
        best_results = None
        best_metric_value = float('-inf')
        
        # Generate parameter combinations
        param_combinations = self._generate_parameter_combinations(parameter_ranges)
        
        for params in param_combinations:
            # Create config with new parameters
            test_config = deepcopy(self.config)
            for param_name, param_value in params.items():
                setattr(test_config, param_name, param_value)
            
            # Run backtest with test configuration
            temp_backtester = CCYOEBacktester(self.data, test_config)
            try:
                results = temp_backtester.run_backtest(start_date, end_date)
                metric_value = getattr(results, optimization_metric)
                
                if metric_value > best_metric_value:
                    best_metric_value = metric_value
                    best_config = test_config
                    best_results = results
                    
            except Exception as e:
                self.logger.warning(f"Failed to test parameters {params}: {e}")
                continue
        
        return best_config, best_results
    
    def _generate_parameter_combinations(self, parameter_ranges: Dict) -> List[Dict]:
        """Generate all combinations of parameters for grid search"""
        # Simple implementation - in practice would use itertools.product
        combinations = []
        
        # This is a simplified version - full implementation would handle
        # multi-dimensional parameter grid search
        for param_name, param_range in parameter_ranges.items():
            if isinstance(param_range, list):
                for value in param_range:
                    combinations.append({param_name: value})
        
        return combinations
