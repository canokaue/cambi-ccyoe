"""
Performance and Risk Metrics - Core metric calculation classes

Provides comprehensive performance and risk metrics for CCYOE analytics including:
- Return metrics (total, annualized, risk-adjusted)
- Risk metrics (volatility, VaR, expected shortfall, drawdown)
- Portfolio metrics (Sharpe ratio, Sortino ratio, Calmar ratio)
- Brazilian market specific metrics
"""

import numpy as np
import pandas as pd
from scipy import stats
from typing import Dict, List, Optional, Union, Tuple
import warnings

from .helpers import calculate_business_days, safe_divide
from .constants import BUSINESS_DAYS_PER_YEAR


class PerformanceMetrics:
    """
    Calculate comprehensive performance metrics for financial time series
    """
    
    def __init__(self, risk_free_rate: float = 0.0):
        """
        Initialize performance metrics calculator
        
        Args:
            risk_free_rate: Risk-free rate for Sharpe ratio calculation (annualized)
        """
        self.risk_free_rate = risk_free_rate
    
    def total_return(self, returns: pd.Series) -> float:
        """Calculate total return from a series of period returns"""
        if len(returns) == 0:
            return 0.0
        return (1 + returns).prod() - 1
    
    def annualized_return(
        self, 
        returns: pd.Series, 
        periods_per_year: int = BUSINESS_DAYS_PER_YEAR
    ) -> float:
        """Calculate annualized return"""
        total_ret = self.total_return(returns)
        periods = len(returns)
        if periods == 0:
            return 0.0
        return (1 + total_ret) ** (periods_per_year / periods) - 1
    
    def volatility(
        self, 
        returns: pd.Series, 
        periods_per_year: int = BUSINESS_DAYS_PER_YEAR
    ) -> float:
        """Calculate annualized volatility"""
        if len(returns) <= 1:
            return 0.0
        return returns.std() * np.sqrt(periods_per_year)
    
    def sharpe_ratio(
        self, 
        returns: pd.Series, 
        risk_free_rate: Optional[float] = None,
        periods_per_year: int = BUSINESS_DAYS_PER_YEAR
    ) -> float:
        """Calculate Sharpe ratio"""
        if risk_free_rate is None:
            risk_free_rate = self.risk_free_rate
        
        if len(returns) == 0:
            return 0.0
        
        vol = self.volatility(returns, periods_per_year)
        if vol == 0:
            return 0.0
        
        ann_return = self.annualized_return(returns, periods_per_year)
        return (ann_return - risk_free_rate) / vol
    
    def sortino_ratio(
        self, 
        returns: pd.Series, 
        risk_free_rate: Optional[float] = None,
        periods_per_year: int = BUSINESS_DAYS_PER_YEAR
    ) -> float:
        """Calculate Sortino ratio (using downside deviation)"""
        if risk_free_rate is None:
            risk_free_rate = self.risk_free_rate
        
        if len(returns) == 0:
            return 0.0
        
        ann_return = self.annualized_return(returns, periods_per_year)
        downside_deviation = self.downside_deviation(returns, periods_per_year)
        
        if downside_deviation == 0:
            return 0.0
        
        return (ann_return - risk_free_rate) / downside_deviation
    
    def calmar_ratio(self, returns: pd.Series) -> float:
        """Calculate Calmar ratio (annual return / max drawdown)"""
        if len(returns) == 0:
            return 0.0
        
        ann_return = self.annualized_return(returns)
        max_dd = self.max_drawdown(returns)
        
        if max_dd == 0:
            return 0.0
        
        return ann_return / max_dd
    
    def max_drawdown(self, returns: pd.Series) -> float:
        """Calculate maximum drawdown"""
        if len(returns) == 0:
            return 0.0
        
        cumulative = (1 + returns).cumprod()
        running_max = cumulative.expanding().max()
        drawdown = (cumulative - running_max) / running_max
        return abs(drawdown.min())
    
    def downside_deviation(
        self, 
        returns: pd.Series, 
        periods_per_year: int = BUSINESS_DAYS_PER_YEAR,
        mar: float = 0.0
    ) -> float:
        """Calculate downside deviation below a minimum acceptable return (MAR)"""
        if len(returns) == 0:
            return 0.0
        
        # Convert MAR to period return
        period_mar = mar / periods_per_year
        
        # Calculate downside returns
        downside_returns = returns[returns < period_mar] - period_mar
        
        if len(downside_returns) == 0:
            return 0.0
        
        return np.sqrt((downside_returns ** 2).mean()) * np.sqrt(periods_per_year)
    
    def information_ratio(
        self, 
        portfolio_returns: pd.Series, 
        benchmark_returns: pd.Series
    ) -> float:
        """Calculate information ratio vs benchmark"""
        if len(portfolio_returns) != len(benchmark_returns) or len(portfolio_returns) == 0:
            return 0.0
        
        excess_returns = portfolio_returns - benchmark_returns
        tracking_error = excess_returns.std()
        
        if tracking_error == 0:
            return 0.0
        
        return excess_returns.mean() / tracking_error
    
    def capture_ratios(
        self, 
        portfolio_returns: pd.Series, 
        benchmark_returns: pd.Series
    ) -> Tuple[float, float]:
        """Calculate upside and downside capture ratios"""
        if len(portfolio_returns) != len(benchmark_returns) or len(portfolio_returns) == 0:
            return 0.0, 0.0
        
        # Upside capture
        up_market = benchmark_returns > 0
        if up_market.sum() == 0:
            upside_capture = 0.0
        else:
            portfolio_up = portfolio_returns[up_market].mean()
            benchmark_up = benchmark_returns[up_market].mean()
            upside_capture = safe_divide(portfolio_up, benchmark_up, 0.0)
        
        # Downside capture
        down_market = benchmark_returns < 0
        if down_market.sum() == 0:
            downside_capture = 0.0
        else:
            portfolio_down = portfolio_returns[down_market].mean()
            benchmark_down = benchmark_returns[down_market].mean()
            downside_capture = safe_divide(portfolio_down, benchmark_down, 0.0)
        
        return upside_capture, downside_capture
    
    def win_rate(self, returns: pd.Series) -> float:
        """Calculate percentage of positive returns"""
        if len(returns) == 0:
            return 0.0
        return (returns > 0).mean()
    
    def gain_to_pain_ratio(self, returns: pd.Series) -> float:
        """Calculate gain-to-pain ratio"""
        if len(returns) == 0:
            return 0.0
        
        total_gain = returns[returns > 0].sum()
        total_pain = abs(returns[returns < 0].sum())
        
        return safe_divide(total_gain, total_pain, 0.0)
    
    def calculate_all_metrics(
        self, 
        returns: pd.Series,
        benchmark_returns: Optional[pd.Series] = None,
        periods_per_year: int = BUSINESS_DAYS_PER_YEAR
    ) -> Dict[str, float]:
        """Calculate all performance metrics"""
        metrics = {
            'total_return': self.total_return(returns),
            'annualized_return': self.annualized_return(returns, periods_per_year),
            'volatility': self.volatility(returns, periods_per_year),
            'sharpe_ratio': self.sharpe_ratio(returns, periods_per_year=periods_per_year),
            'sortino_ratio': self.sortino_ratio(returns, periods_per_year=periods_per_year),
            'calmar_ratio': self.calmar_ratio(returns),
            'max_drawdown': self.max_drawdown(returns),
            'downside_deviation': self.downside_deviation(returns, periods_per_year),
            'win_rate': self.win_rate(returns),
            'gain_to_pain_ratio': self.gain_to_pain_ratio(returns)
        }
        
        # Add benchmark-relative metrics if benchmark provided
        if benchmark_returns is not None:
            metrics['information_ratio'] = self.information_ratio(returns, benchmark_returns)
            upside_cap, downside_cap = self.capture_ratios(returns, benchmark_returns)
            metrics['upside_capture'] = upside_cap
            metrics['downside_capture'] = downside_cap
        
        return metrics


class RiskMetrics:
    """
    Calculate comprehensive risk metrics for financial time series
    """
    
    def __init__(self):
        pass
    
    def calculate_var(
        self, 
        returns: pd.Series, 
        confidence: float = 0.95,
        method: str = 'historical'
    ) -> float:
        """
        Calculate Value at Risk (VaR)
        
        Args:
            returns: Series of returns
            confidence: Confidence level (0.95 = 95%)
            method: Method ('historical', 'parametric', 'monte_carlo')
            
        Returns:
            VaR value (positive number representing potential loss)
        """
        if len(returns) == 0:
            return 0.0
        
        if method == 'historical':
            return abs(np.percentile(returns, (1 - confidence) * 100))
        
        elif method == 'parametric':
            mean = returns.mean()
            std = returns.std()
            z_score = stats.norm.ppf(1 - confidence)
            return abs(mean + z_score * std)
        
        elif method == 'monte_carlo':
            # Simple Monte Carlo implementation
            n_simulations = 10000
            simulated_returns = np.random.normal(
                returns.mean(), 
                returns.std(), 
                n_simulations
            )
            return abs(np.percentile(simulated_returns, (1 - confidence) * 100))
        
        else:
            raise ValueError(f"Unknown VaR method: {method}")
    
    def calculate_expected_shortfall(
        self, 
        returns: pd.Series, 
        confidence: float = 0.95
    ) -> float:
        """Calculate Expected Shortfall (Conditional VaR)"""
        if len(returns) == 0:
            return 0.0
        
        var_threshold = self.calculate_var(returns, confidence, 'historical')
        tail_returns = returns[returns <= -var_threshold]
        
        if len(tail_returns) == 0:
            return var_threshold
        
        return abs(tail_returns.mean())
    
    def calculate_beta(
        self, 
        portfolio_returns: pd.Series, 
        market_returns: pd.Series
    ) -> float:
        """Calculate beta vs market"""
        if len(portfolio_returns) != len(market_returns) or len(portfolio_returns) < 2:
            return 0.0
        
        market_var = market_returns.var()
        if market_var == 0:
            return 0.0
        
        covariance = portfolio_returns.cov(market_returns)
        return covariance / market_var
    
    def calculate_tracking_error(
        self, 
        portfolio_returns: pd.Series, 
        benchmark_returns: pd.Series,
        periods_per_year: int = BUSINESS_DAYS_PER_YEAR
    ) -> float:
        """Calculate tracking error vs benchmark"""
        if len(portfolio_returns) != len(benchmark_returns) or len(portfolio_returns) == 0:
            return 0.0
        
        excess_returns = portfolio_returns - benchmark_returns
        return excess_returns.std() * np.sqrt(periods_per_year)
    
    def calculate_skewness(self, returns: pd.Series) -> float:
        """Calculate skewness of returns"""
        if len(returns) < 3:
            return 0.0
        return stats.skew(returns)
    
    def calculate_kurtosis(self, returns: pd.Series) -> float:
        """Calculate excess kurtosis of returns"""
        if len(returns) < 4:
            return 0.0
        return stats.kurtosis(returns)
    
    def jarque_bera_test(self, returns: pd.Series) -> Tuple[float, float]:
        """Perform Jarque-Bera test for normality"""
        if len(returns) < 8:
            return 0.0, 1.0
        
        statistic, p_value = stats.jarque_bera(returns)
        return statistic, p_value
    
    def calculate_tail_ratio(self, returns: pd.Series, percentile: float = 0.05) -> float:
        """Calculate tail ratio (95th percentile / 5th percentile)"""
        if len(returns) == 0:
            return 0.0
        
        upper_tail = np.percentile(returns, (1 - percentile) * 100)
        lower_tail = np.percentile(returns, percentile * 100)
        
        return safe_divide(upper_tail, abs(lower_tail), 0.0)
    
    def calculate_stress_metrics(
        self, 
        returns: pd.Series,
        stress_scenarios: Dict[str, float]
    ) -> Dict[str, float]:
        """
        Calculate metrics under stress scenarios
        
        Args:
            returns: Historical returns
            stress_scenarios: Dict of scenario names to shock magnitudes
            
        Returns:
            Dict of stressed metrics
        """
        stress_results = {}
        
        for scenario_name, shock in stress_scenarios.items():
            # Apply shock to returns
            stressed_returns = returns + shock
            
            # Calculate metrics under stress
            stress_results[f"{scenario_name}_var_95"] = self.calculate_var(stressed_returns, 0.95)
            stress_results[f"{scenario_name}_expected_shortfall"] = self.calculate_expected_shortfall(stressed_returns, 0.95)
            stress_results[f"{scenario_name}_max_drawdown"] = PerformanceMetrics().max_drawdown(stressed_returns)
        
        return stress_results
    
    def calculate_risk_decomposition(
        self, 
        asset_returns: pd.DataFrame,
        weights: pd.Series
    ) -> Dict[str, float]:
        """
        Calculate risk decomposition for a portfolio
        
        Args:
            asset_returns: DataFrame with asset returns
            weights: Series with portfolio weights
            
        Returns:
            Dict with risk decomposition metrics
        """
        if len(asset_returns) == 0 or len(weights) == 0:
            return {}
        
        # Calculate covariance matrix
        cov_matrix = asset_returns.cov()
        
        # Portfolio variance
        portfolio_var = np.dot(weights.T, np.dot(cov_matrix, weights))
        portfolio_vol = np.sqrt(portfolio_var)
        
        # Marginal contributions to risk
        marginal_contrib = np.dot(cov_matrix, weights) / portfolio_vol
        
        # Component contributions to risk
        component_contrib = weights * marginal_contrib
        
        # Percentage contributions
        pct_contrib = component_contrib / portfolio_vol
        
        return {
            'portfolio_volatility': portfolio_vol,
            'marginal_contributions': marginal_contrib.to_dict(),
            'component_contributions': component_contrib.to_dict(),
            'percentage_contributions': pct_contrib.to_dict()
        }
    
    def calculate_concentration_metrics(self, weights: pd.Series) -> Dict[str, float]:
        """Calculate portfolio concentration metrics"""
        if len(weights) == 0:
            return {}
        
        # Herfindahl-Hirschman Index
        hhi = (weights ** 2).sum()
        
        # Effective number of assets
        effective_assets = 1 / hhi
        
        # Maximum weight
        max_weight = weights.max()
        
        # Gini coefficient (measure of inequality)
        sorted_weights = np.sort(weights)
        n = len(weights)
        index = np.arange(1, n + 1)
        gini = (2 * index - n - 1) @ sorted_weights / (n * sorted_weights.sum())
        
        return {
            'herfindahl_index': hhi,
            'effective_number_assets': effective_assets,
            'maximum_weight': max_weight,
            'gini_coefficient': gini
        }
    
    def calculate_rolling_risk_metrics(
        self, 
        returns: pd.Series,
        window: int = 30,
        confidence: float = 0.95
    ) -> pd.DataFrame:
        """Calculate rolling risk metrics"""
        if len(returns) < window:
            return pd.DataFrame()
        
        rolling_metrics = pd.DataFrame(index=returns.index[window-1:])
        
        # Rolling VaR
        rolling_metrics['var'] = returns.rolling(window).apply(
            lambda x: self.calculate_var(x, confidence), raw=False
        )
        
        # Rolling volatility
        rolling_metrics['volatility'] = returns.rolling(window).std() * np.sqrt(252)
        
        # Rolling max drawdown
        rolling_metrics['max_drawdown'] = returns.rolling(window).apply(
            lambda x: PerformanceMetrics().max_drawdown(x), raw=False
        )
        
        # Rolling skewness
        rolling_metrics['skewness'] = returns.rolling(window).skew()
        
        # Rolling kurtosis
        rolling_metrics['kurtosis'] = returns.rolling(window).kurt()
        
        return rolling_metrics.dropna()
    
    def calculate_all_risk_metrics(
        self, 
        returns: pd.Series,
        market_returns: Optional[pd.Series] = None,
        confidence_levels: List[float] = [0.90, 0.95, 0.99]
    ) -> Dict[str, Union[float, Dict]]:
        """Calculate all risk metrics"""
        metrics = {
            'volatility': returns.std() * np.sqrt(252),
            'skewness': self.calculate_skewness(returns),
            'kurtosis': self.calculate_kurtosis(returns),
            'tail_ratio': self.calculate_tail_ratio(returns)
        }
        
        # VaR at different confidence levels
        var_metrics = {}
        es_metrics = {}
        for conf in confidence_levels:
            var_metrics[f'var_{int(conf*100)}'] = self.calculate_var(returns, conf)
            es_metrics[f'es_{int(conf*100)}'] = self.calculate_expected_shortfall(returns, conf)
        
        metrics['var'] = var_metrics
        metrics['expected_shortfall'] = es_metrics
        
        # Jarque-Bera test
        jb_stat, jb_pvalue = self.jarque_bera_test(returns)
        metrics['jarque_bera_statistic'] = jb_stat
        metrics['jarque_bera_pvalue'] = jb_pvalue
        
        # Market-relative metrics
        if market_returns is not None:
            metrics['beta'] = self.calculate_beta(returns, market_returns)
            metrics['tracking_error'] = self.calculate_tracking_error(returns, market_returns)
        
        return metrics


class VaRCalculator:
    """
    Specialized Value at Risk calculator with multiple methodologies
    """
    
    def __init__(self):
        pass
    
    def historical_var(
        self, 
        returns: pd.Series, 
        confidence: float = 0.95,
        window: Optional[int] = None
    ) -> float:
        """Historical simulation VaR"""
        if window:
            returns = returns.tail(window)
        
        if len(returns) == 0:
            return 0.0
        
        return abs(np.percentile(returns, (1 - confidence) * 100))
    
    def parametric_var(
        self, 
        returns: pd.Series, 
        confidence: float = 0.95,
        distribution: str = 'normal'
    ) -> float:
        """Parametric VaR assuming a distribution"""
        if len(returns) == 0:
            return 0.0
        
        mean = returns.mean()
        std = returns.std()
        
        if distribution == 'normal':
            z_score = stats.norm.ppf(1 - confidence)
            return abs(mean + z_score * std)
        
        elif distribution == 't':
            # Estimate degrees of freedom
            df = 6 / stats.kurtosis(returns) + 4 if stats.kurtosis(returns) > 0 else 30
            t_score = stats.t.ppf(1 - confidence, df)
            return abs(mean + t_score * std)
        
        else:
            raise ValueError(f"Unsupported distribution: {distribution}")
    
    def monte_carlo_var(
        self, 
        returns: pd.Series, 
        confidence: float = 0.95,
        n_simulations: int = 10000,
        distribution: str = 'normal'
    ) -> float:
        """Monte Carlo VaR simulation"""
        if len(returns) == 0:
            return 0.0
        
        mean = returns.mean()
        std = returns.std()
        
        np.random.seed(42)  # For reproducible results
        
        if distribution == 'normal':
            simulated_returns = np.random.normal(mean, std, n_simulations)
        elif distribution == 't':
            df = 6 / stats.kurtosis(returns) + 4 if stats.kurtosis(returns) > 0 else 30
            simulated_returns = stats.t.rvs(df, loc=mean, scale=std, size=n_simulations)
        else:
            raise ValueError(f"Unsupported distribution: {distribution}")
        
        return abs(np.percentile(simulated_returns, (1 - confidence) * 100))
    
    def cornish_fisher_var(
        self, 
        returns: pd.Series, 
        confidence: float = 0.95
    ) -> float:
        """Cornish-Fisher VaR (accounts for skewness and kurtosis)"""
        if len(returns) < 4:
            return self.parametric_var(returns, confidence)
        
        mean = returns.mean()
        std = returns.std()
        skew = stats.skew(returns)
        kurt = stats.kurtosis(returns)
        
        # Standard normal quantile
        z = stats.norm.ppf(1 - confidence)
        
        # Cornish-Fisher expansion
        cf_z = (z + 
                (z**2 - 1) * skew / 6 + 
                (z**3 - 3*z) * kurt / 24 - 
                (2*z**3 - 5*z) * skew**2 / 36)
        
        return abs(mean + cf_z * std)
