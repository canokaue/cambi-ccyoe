"""
Basic test configuration and utilities for CCYOE Analytics
"""

import pytest
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import warnings

# Suppress warnings during tests
warnings.filterwarnings('ignore')

@pytest.fixture
def sample_yield_data():
    """Generate sample yield data for testing"""
    dates = pd.date_range('2023-01-01', '2023-12-31', freq='D')
    
    # Generate realistic Brazilian yield data
    np.random.seed(42)  # For reproducible tests
    
    data = {
        'date': dates,
        'cmBTC': np.random.normal(500, 50, len(dates)),    # 5% ± 0.5%
        'cmUSD': np.random.normal(1400, 100, len(dates)),  # 14% ± 1%
        'cmBRL': np.random.normal(2200, 150, len(dates)),  # 22% ± 1.5%
        'SELIC': np.random.normal(1350, 30, len(dates)),   # 13.5% ± 0.3%
        'CDI': np.random.normal(1320, 25, len(dates))      # 13.2% ± 0.25%
    }
    
    # Ensure non-negative yields
    for col in ['cmBTC', 'cmUSD', 'cmBRL', 'SELIC', 'CDI']:
        data[col] = np.maximum(data[col], 50)  # Minimum 0.5% yield
    
    return pd.DataFrame(data)

@pytest.fixture
def simple_config():
    """Generate simple CCYOE configuration for testing"""
    from cambi_analytics import OptimizationConfig
    
    return OptimizationConfig(
        under_supplied_allocation=0.40,
        strategic_growth_allocation=0.30,
        proportional_allocation=0.20,
        treasury_allocation=0.10,
        rebalance_threshold=100,
        transaction_cost=5,
        target_yields={
            'cmBTC': 500,
            'cmUSD': 1400,
            'cmBRL': 2000
        }
    )

def assert_valid_backtest_results(results):
    """Helper function to validate backtest results"""
    assert hasattr(results, 'total_return')
    assert hasattr(results, 'sharpe_ratio')
    assert hasattr(results, 'max_drawdown')
    assert hasattr(results, 'total_rebalances')
    
    # Basic sanity checks
    assert isinstance(results.total_return, (int, float))
    assert isinstance(results.sharpe_ratio, (int, float))
    assert results.max_drawdown >= 0
    assert results.total_rebalances >= 0

def assert_valid_yield_analysis(analysis_results):
    """Helper function to validate yield analysis results"""
    assert isinstance(analysis_results, dict)
    assert len(analysis_results) > 0
    
    for key, value in analysis_results.items():
        assert isinstance(value, (int, float, dict, pd.DataFrame))

class TestDataGenerator:
    """Utility class for generating test data"""
    
    @staticmethod
    def create_correlated_yields(n_days=365, correlation=0.5):
        """Create correlated yield data for testing"""
        np.random.seed(42)
        
        # Generate correlated random walks
        base_yields = {'cmBTC': 500, 'cmUSD': 1400, 'cmBRL': 2200}
        volatilities = {'cmBTC': 100, 'cmUSD': 80, 'cmBRL': 120}
        
        # Create correlation matrix
        assets = list(base_yields.keys())
        n_assets = len(assets)
        corr_matrix = np.full((n_assets, n_assets), correlation)
        np.fill_diagonal(corr_matrix, 1.0)
        
        # Generate correlated shocks
        shocks = np.random.multivariate_normal(
            mean=[0] * n_assets,
            cov=corr_matrix,
            size=n_days
        )
        
        # Create yield series
        dates = pd.date_range('2023-01-01', periods=n_days, freq='D')
        data = {'date': dates}
        
        for i, asset in enumerate(assets):
            yields = []
            current_yield = base_yields[asset]
            
            for day in range(n_days):
                # Mean reversion + shock
                mean_reversion = 0.05 * (base_yields[asset] - current_yield)
                shock = shocks[day, i] * volatilities[asset]
                current_yield += mean_reversion + shock
                yields.append(max(50, current_yield))  # Minimum 0.5%
            
            data[asset] = yields
        
        return pd.DataFrame(data)
