#!/usr/bin/env python3
"""
CCYOE Analytics Example Script

Demonstrates key functionality of the CCYOE analytics package including:
- Data loading and processing
- Yield analysis
- CCYOE backtesting
- Optimization
- Performance reporting
"""

import sys
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import warnings

# Add the cambi_analytics package to path
sys.path.append('..')

from cambi_analytics import (
    YieldAnalyzer, CCYOEBacktester, YieldOptimizer, OptimizationConfig,
    DataLoader, BrazilianDataLoader, YieldProcessor,
    PerformanceMetrics, RiskMetrics,
    get_config
)

def main():
    """Run comprehensive CCYOE analytics example"""
    
    print("🚀 CCYOE Analytics Example")
    print("=" * 50)
    
    # 1. Load Configuration
    print("\n📋 Loading Configuration...")
    config = get_config()
    print(f"✅ Configuration loaded successfully")
    print(f"   - Default analysis period: {config.analysis.default_start_date} to {config.analysis.default_end_date}")
    print(f"   - Risk-free rate: {config.analysis.risk_free_rate:.1%}")
    
    # 2. Load Sample Data
    print("\n📊 Loading Sample Data...")
    data_loader = DataLoader()
    
    # Load multi-asset sample data
    sample_data = data_loader.load_sample_data(
        data_type='brazilian_market',
        start_date='2023-01-01',
        end_date='2024-01-01'
    )
    
    print(f"✅ Loaded {len(sample_data)} days of data")
    print(f"   - Assets: {[col for col in sample_data.columns if col != 'date']}")
    print(f"   - Date range: {sample_data['date'].min().date()} to {sample_data['date'].max().date()}")
    
    # 3. Process Data
    print("\n🔧 Processing Data...")
    processor = YieldProcessor()
    
    processed_data = processor.process_yield_data(
        sample_data,
        yield_columns=['cmBTC', 'cmUSD', 'cmBRL', 'SELIC', 'CDI'],
        handle_missing='interpolate',
        handle_outliers='cap'
    )
    
    print(f"✅ Data processed successfully")
    print("   Processing log:")
    for log_entry in processor.get_processing_log()[-3:]:  # Show last 3 entries
        print(f"     {log_entry}")
    
    # 4. Yield Analysis
    print("\n📈 Performing Yield Analysis...")
    analyzer = YieldAnalyzer(processed_data, assets=['cmBTC', 'cmUSD', 'cmBRL'])
    
    # Calculate key metrics
    avg_yields = {asset: analyzer.get_average_yield(asset) for asset in ['cmBTC', 'cmUSD', 'cmBRL']}
    volatility_metrics = analyzer.calculate_volatility_metrics()
    correlation_matrix = analyzer.calculate_correlation_matrix()
    
    print("✅ Yield analysis completed")
    print("   Average yields (basis points):")
    for asset, yield_val in avg_yields.items():
        print(f"     {asset}: {yield_val:.0f} bp ({yield_val/100:.1f}%)")
    
    print("   Volatilities (annualized):")
    for asset in ['cmBTC', 'cmUSD', 'cmBRL']:
        vol = volatility_metrics.get(asset, {}).get('volatility', 0)
        print(f"     {asset}: {vol:.0f} bp ({vol/100:.1f}%)")
    
    # 5. CCYOE Backtesting
    print("\n🎯 Running CCYOE Backtest...")
    
    # Configure CCYOE parameters
    ccyoe_config = OptimizationConfig(
        under_supplied_allocation=0.40,
        strategic_growth_allocation=0.30,
        proportional_allocation=0.20,
        treasury_allocation=0.10,
        rebalance_threshold=100,  # 1%
        target_yields={
            'cmBTC': 500,   # 5%
            'cmUSD': 1400,  # 14%
            'cmBRL': 2000   # 20%
        }
    )
    
    # Run backtest
    backtester = CCYOEBacktester(processed_data, ccyoe_config)
    backtest_results = backtester.run_backtest('2023-01-01', '2024-01-01')
    
    print("✅ Backtest completed")
    print(f"   Total return: {backtest_results.total_return:.1%}")
    print(f"   Annualized return: {backtest_results.annualized_return:.1%}")
    print(f"   Sharpe ratio: {backtest_results.sharpe_ratio:.2f}")
    print(f"   Max drawdown: {backtest_results.max_drawdown:.1%}")
    print(f"   Total rebalances: {backtest_results.total_rebalances}")
    print(f"   Avg excess yield: {backtest_results.avg_excess_yield:.0f} bp")
    
    print("   Yield improvements:")
    for asset, improvement in backtest_results.yield_improvement.items():
        print(f"     {asset}: +{improvement:.0f} bp")
    
    # 6. Optimization
    print("\n⚡ Optimizing CCYOE Parameters...")
    
    optimizer = YieldOptimizer(processed_data, ccyoe_config)
    
    # Optimize distribution weights
    optimization_result = optimizer.optimize_distribution_weights(
        objective='sharpe_ratio',
        method='scipy',
        start_date='2023-01-01',
        end_date='2024-01-01'
    )
    
    print("✅ Optimization completed")
    print(f"   Convergence: {optimization_result.convergence_status}")
    print(f"   Optimal Sharpe ratio: {optimization_result.optimal_value:.2f}")
    print("   Optimal allocation weights:")
    for param, value in optimization_result.optimal_params.items():
        if 'allocation' in param:
            print(f"     {param}: {value:.1%}")
    
    # 7. Risk Analysis
    print("\n⚠️  Performing Risk Analysis...")
    
    # Calculate portfolio returns for risk analysis
    daily_returns = backtest_results.daily_returns
    
    risk_calculator = RiskMetrics()
    risk_metrics = risk_calculator.calculate_all_risk_metrics(daily_returns)
    
    print("✅ Risk analysis completed")
    print(f"   VaR (95%): {risk_metrics['var']['var_95']:.1%}")
    print(f"   Expected Shortfall (95%): {risk_metrics['expected_shortfall']['es_95']:.1%}")
    print(f"   Skewness: {risk_metrics['skewness']:.2f}")
    print(f"   Kurtosis: {risk_metrics['kurtosis']:.2f}")
    
    # 8. Performance Attribution
    print("\n📊 Performance Attribution...")
    
    performance_calculator = PerformanceMetrics(risk_free_rate=config.analysis.risk_free_rate)
    performance_metrics = performance_calculator.calculate_all_metrics(daily_returns)
    
    print("✅ Performance attribution completed")
    print(f"   Sortino ratio: {performance_metrics['sortino_ratio']:.2f}")
    print(f"   Calmar ratio: {performance_metrics['calmar_ratio']:.2f}")
    print(f"   Win rate: {performance_metrics['win_rate']:.1%}")
    print(f"   Gain-to-pain ratio: {performance_metrics['gain_to_pain_ratio']:.2f}")
    
    # 9. Summary Report
    print("\n📋 CCYOE Performance Summary")
    print("=" * 50)
    
    print(f"📈 Returns:")
    print(f"   • Total Return: {backtest_results.total_return:.1%}")
    print(f"   • Annualized Return: {backtest_results.annualized_return:.1%}")
    print(f"   • Benchmark (SELIC): {config.analysis.risk_free_rate:.1%}")
    print(f"   • Excess Return: {backtest_results.annualized_return - config.analysis.risk_free_rate:.1%}")
    
    print(f"\n⚡ CCYOE Efficiency:")
    print(f"   • Avg Excess Yield: {backtest_results.avg_excess_yield:.0f} bp")
    print(f"   • Rebalancing Events: {backtest_results.total_rebalances}")
    print(f"   • Rebalancing Frequency: {backtest_results.rebalance_frequency:.1f}/year")
    print(f"   • Transaction Costs: ${backtest_results.total_transaction_costs:,.0f}")
    
    print(f"\n📊 Risk Metrics:")
    print(f"   • Volatility: {backtest_results.volatility:.1%}")
    print(f"   • Sharpe Ratio: {backtest_results.sharpe_ratio:.2f}")
    print(f"   • Max Drawdown: {backtest_results.max_drawdown:.1%}")
    print(f"   • VaR (95%): {risk_metrics['var']['var_95']:.1%}")
    
    print(f"\n🎯 Yield Enhancement:")
    for asset, improvement in backtest_results.yield_improvement.items():
        original_yield = avg_yields[asset]
        enhanced_yield = original_yield + improvement
        print(f"   • {asset}: {original_yield:.0f} bp → {enhanced_yield:.0f} bp (+{improvement:.0f} bp)")
    
    print(f"\n✅ Analysis completed successfully!")
    print(f"The CCYOE system generated {backtest_results.avg_excess_yield:.0f} bp of excess yield")
    print(f"and achieved a {backtest_results.sharpe_ratio:.2f} Sharpe ratio with optimized distribution.")


if __name__ == "__main__":
    # Suppress minor warnings for cleaner output
    warnings.filterwarnings('ignore', category=RuntimeWarning)
    
    try:
        main()
    except Exception as e:
        print(f"\n❌ Error running analysis: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
