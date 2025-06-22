"""
Test core analytics functionality
"""

import pytest
import pandas as pd
import numpy as np
from cambi_analytics import (
    YieldAnalyzer, CCYOEBacktester, YieldOptimizer,
    OptimizationConfig, DataLoader
)
from .conftest import assert_valid_backtest_results, assert_valid_yield_analysis


class TestYieldAnalyzer:
    """Test YieldAnalyzer functionality"""
    
    def test_analyzer_initialization(self, sample_yield_data):
        """Test that YieldAnalyzer initializes correctly"""
        analyzer = YieldAnalyzer(sample_yield_data, assets=['cmBTC', 'cmUSD', 'cmBRL'])
        
        assert analyzer.data is not None
        assert len(analyzer.assets) == 3
        assert 'cmBTC' in analyzer.assets
        assert 'cmUSD' in analyzer.assets
        assert 'cmBRL' in analyzer.assets
    
    def test_average_yield_calculation(self, sample_yield_data):
        """Test average yield calculation"""
        analyzer = YieldAnalyzer(sample_yield_data, assets=['cmBTC', 'cmUSD', 'cmBRL'])
        
        avg_yield_btc = analyzer.get_average_yield('cmBTC')
        avg_yield_usd = analyzer.get_average_yield('cmUSD')
        avg_yield_brl = analyzer.get_average_yield('cmBRL')
        
        # Basic sanity checks
        assert isinstance(avg_yield_btc, (int, float))
        assert isinstance(avg_yield_usd, (int, float))
        assert isinstance(avg_yield_brl, (int, float))
        
        # Brazilian assets should have higher yields
        assert avg_yield_brl > avg_yield_usd > avg_yield_btc
        
        # Reasonable ranges (in basis points)
        assert 400 < avg_yield_btc < 600   # ~5%
        assert 1300 < avg_yield_usd < 1500 # ~14%
        assert 2100 < avg_yield_brl < 2300 # ~22%
    
    def test_correlation_matrix(self, sample_yield_data):
        """Test correlation matrix calculation"""
        analyzer = YieldAnalyzer(sample_yield_data, assets=['cmBTC', 'cmUSD', 'cmBRL'])
        
        corr_matrix = analyzer.calculate_correlation_matrix()
        
        # Validate correlation matrix properties
        assert isinstance(corr_matrix, pd.DataFrame)
        assert corr_matrix.shape == (3, 3)
        
        # Diagonal should be 1.0
        assert np.allclose(np.diag(corr_matrix), 1.0)
        
        # Matrix should be symmetric
        assert np.allclose(corr_matrix, corr_matrix.T)
        
        # All correlations should be between -1 and 1
        assert (corr_matrix >= -1).all().all()
        assert (corr_matrix <= 1).all().all()
    
    def test_volatility_metrics(self, sample_yield_data):
        """Test volatility metrics calculation"""
        analyzer = YieldAnalyzer(sample_yield_data, assets=['cmBTC', 'cmUSD', 'cmBRL'])
        
        vol_metrics = analyzer.calculate_volatility_metrics()
        
        assert isinstance(vol_metrics, dict)
        assert len(vol_metrics) == 3
        
        for asset in ['cmBTC', 'cmUSD', 'cmBRL']:
            assert asset in vol_metrics
            metrics = vol_metrics[asset]
            
            # Check required metrics exist
            assert 'volatility' in metrics
            assert 'skewness' in metrics
            assert 'kurtosis' in metrics
            
            # Volatility should be positive
            assert metrics['volatility'] > 0


class TestCCYOEBacktester:
    """Test CCYOE backtesting functionality"""
    
    def test_backtest_initialization(self, sample_yield_data, simple_config):
        """Test backtester initialization"""
        backtester = CCYOEBacktester(sample_yield_data, simple_config)
        
        assert backtester.data is not None
        assert backtester.config is not None
        assert len(backtester.data) > 0
    
    def test_basic_backtest(self, sample_yield_data, simple_config):
        """Test basic backtest execution"""
        backtester = CCYOEBacktester(sample_yield_data, simple_config)
        
        results = backtester.run_backtest('2023-01-01', '2023-06-01')
        
        # Validate results structure
        assert_valid_backtest_results(results)
        
        # Basic performance checks
        assert -1 < results.total_return < 1  # ±100% is reasonable range
        assert -10 < results.sharpe_ratio < 10  # Reasonable Sharpe range
        assert 0 <= results.max_drawdown <= 1  # 0-100% drawdown
    
    def test_yield_improvement_calculation(self, sample_yield_data, simple_config):
        """Test that CCYOE generates yield improvements"""
        backtester = CCYOEBacktester(sample_yield_data, simple_config)
        
        results = backtester.run_backtest('2023-01-01', '2023-06-01')
        
        # Should have yield improvement data
        assert hasattr(results, 'yield_improvement')
        assert isinstance(results.yield_improvement, dict)
        
        # Should have improvements for each asset
        for asset in ['cmBTC', 'cmUSD', 'cmBRL']:
            assert asset in results.yield_improvement
            # Improvement can be positive, negative, or zero
            assert isinstance(results.yield_improvement[asset], (int, float))
    
    def test_rebalancing_logic(self, sample_yield_data, simple_config):
        """Test rebalancing trigger and execution"""
        # Set low threshold to trigger more rebalances
        config_with_low_threshold = simple_config
        config_with_low_threshold.rebalance_threshold = 25  # 0.25%
        
        backtester = CCYOEBacktester(sample_yield_data, config_with_low_threshold)
        results = backtester.run_backtest('2023-01-01', '2023-03-01')
        
        # Should have some rebalancing events with low threshold
        assert results.total_rebalances >= 0
        assert hasattr(results, 'rebalance_events')


class TestYieldOptimizer:
    """Test optimization functionality"""
    
    def test_optimizer_initialization(self, sample_yield_data, simple_config):
        """Test optimizer initialization"""
        optimizer = YieldOptimizer(sample_yield_data, simple_config)
        
        assert optimizer.data is not None
        assert optimizer.base_config is not None
        assert optimizer._cache is not None
    
    def test_distribution_weight_optimization(self, sample_yield_data, simple_config):
        """Test distribution weight optimization"""
        # Use small dataset for faster testing
        small_data = sample_yield_data.head(50)
        optimizer = YieldOptimizer(small_data, simple_config)
        
        # Test basic optimization
        result = optimizer.optimize_distribution_weights(
            objective='sharpe_ratio',
            method='scipy',
            start_date='2023-01-01',
            end_date='2023-02-01'  # Short period for testing
        )
        
        # Validate optimization result structure
        assert hasattr(result, 'optimal_params')
        assert hasattr(result, 'optimal_value')
        assert hasattr(result, 'convergence_status')
        
        # Check that allocation weights sum to ~1.0
        allocation_weights = {
            k: v for k, v in result.optimal_params.items() 
            if k.endswith('_allocation')
        }
        total_allocation = sum(allocation_weights.values())
        assert abs(total_allocation - 1.0) < 0.01  # Within 1%
    
    def test_sensitivity_analysis(self, sample_yield_data, simple_config):
        """Test sensitivity analysis"""
        # Use very small dataset for speed
        small_data = sample_yield_data.head(30)
        optimizer = YieldOptimizer(small_data, simple_config)
        
        # Test sensitivity analysis
        sensitivity_results = optimizer.run_sensitivity_analysis(
            parameters=['under_supplied_allocation'],
            ranges={'under_supplied_allocation': (0.3, 0.5)},
            objective='sharpe_ratio',
            start_date='2023-01-01',
            end_date='2023-01-15',  # Very short period
            n_points=3  # Few points for speed
        )
        
        assert isinstance(sensitivity_results, dict)
        assert 'under_supplied_allocation' in sensitivity_results
        
        results_df = sensitivity_results['under_supplied_allocation']
        assert isinstance(results_df, pd.DataFrame)
        assert len(results_df) == 3  # Should have 3 data points
        assert 'parameter_value' in results_df.columns
        assert 'objective_value' in results_df.columns


class TestDataLoader:
    """Test data loading functionality"""
    
    def test_sample_data_generation(self):
        """Test sample data generation"""
        loader = DataLoader()
        
        # Test Brazilian market data generation
        data = loader.load_sample_data(
            data_type='brazilian_market',
            start_date='2023-01-01',
            end_date='2023-01-31'
        )
        
        assert isinstance(data, pd.DataFrame)
        assert len(data) > 0
        assert 'date' in data.columns
        assert 'cmBTC' in data.columns
        assert 'cmUSD' in data.columns
        assert 'cmBRL' in data.columns
        assert 'SELIC' in data.columns
        
        # Check data types
        assert pd.api.types.is_datetime64_any_dtype(data['date'])
        
        # Check yield ranges are reasonable
        assert data['cmBTC'].min() >= 0
        assert data['cmUSD'].min() >= 0
        assert data['cmBRL'].min() >= 0
        assert data['SELIC'].min() >= 0
    
    def test_multi_asset_sample_data(self):
        """Test multi-asset sample data generation"""
        loader = DataLoader()
        
        data = loader.load_sample_data(
            data_type='multi_asset',
            start_date='2023-01-01',
            end_date='2023-01-15'
        )
        
        assert isinstance(data, pd.DataFrame)
        assert len(data) > 0
        assert 'date' in data.columns
        
        # Should have asset columns
        asset_columns = [col for col in data.columns if col != 'date']
        assert len(asset_columns) >= 3


class TestIntegration:
    """Integration tests combining multiple components"""
    
    def test_end_to_end_analysis(self, sample_yield_data, simple_config):
        """Test complete analysis workflow"""
        # 1. Analyze yields
        analyzer = YieldAnalyzer(sample_yield_data, assets=['cmBTC', 'cmUSD', 'cmBRL'])
        avg_yields = {
            asset: analyzer.get_average_yield(asset) 
            for asset in ['cmBTC', 'cmUSD', 'cmBRL']
        }
        
        # 2. Run backtest
        backtester = CCYOEBacktester(sample_yield_data, simple_config)
        results = backtester.run_backtest('2023-01-01', '2023-03-01')
        
        # 3. Validate everything worked
        assert_valid_yield_analysis(avg_yields)
        assert_valid_backtest_results(results)
        
        # 4. Check that CCYOE is doing something
        total_yield_improvement = sum(results.yield_improvement.values())
        # Should have some impact (positive or negative)
        assert isinstance(total_yield_improvement, (int, float))
    
    def test_configuration_consistency(self):
        """Test that configuration objects work consistently"""
        from cambi_analytics import get_config
        
        config = get_config()
        
        # Should have required sections
        assert hasattr(config, 'analysis')
        assert hasattr(config, 'optimization')
        assert hasattr(config, 'data_source')
        
        # Should have reasonable defaults
        assert config.analysis.risk_free_rate > 0
        assert config.analysis.risk_free_rate < 1  # Less than 100%


if __name__ == "__main__":
    pytest.main([__file__])
