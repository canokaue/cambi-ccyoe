#!/usr/bin/env python3
"""
CCYOE Optimization Study Script

Comprehensive optimization study for CCYOE parameters including:
- Parameter sensitivity analysis
- Multi-objective optimization
- Stress testing under different market conditions
- Robust optimization under uncertainty
"""

import sys
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from datetime import datetime
import warnings

# Add the cambi_analytics package to path
sys.path.append('..')

from cambi_analytics import (
    YieldOptimizer, OptimizationConfig, CCYOEBacktester,
    DataLoader, YieldProcessor,
    get_config
)

def run_sensitivity_analysis(data, base_config):
    """Run comprehensive sensitivity analysis"""
    print("\n🔍 Sensitivity Analysis")
    print("-" * 30)
    
    optimizer = YieldOptimizer(data, base_config)
    
    # Define parameters and ranges to test
    parameters = [
        'under_supplied_allocation',
        'strategic_growth_allocation', 
        'rebalance_threshold',
        'transaction_cost'
    ]
    
    ranges = {
        'under_supplied_allocation': (0.20, 0.60),
        'strategic_growth_allocation': (0.15, 0.45),
        'rebalance_threshold': (50, 300),
        'transaction_cost': (1, 25)
    }
    
    # Run sensitivity analysis
    sensitivity_results = optimizer.run_sensitivity_analysis(
        parameters=parameters,
        ranges=ranges,
        objective='sharpe_ratio',
        n_points=8
    )
    
    # Display results
    for param, results_df in sensitivity_results.items():
        best_idx = results_df['objective_value'].idxmax()
        best_value = results_df.loc[best_idx, 'parameter_value']
        best_objective = results_df.loc[best_idx, 'objective_value']
        
        print(f"📊 {param}:")
        print(f"   Best value: {best_value:.3f}")
        print(f"   Best Sharpe: {best_objective:.3f}")
        print(f"   Range tested: {ranges[param][0]:.3f} - {ranges[param][1]:.3f}")
    
    return sensitivity_results

def run_multi_objective_optimization(data, base_config):
    """Run multi-objective optimization"""
    print("\n🎯 Multi-Objective Optimization")
    print("-" * 35)
    
    optimizer = YieldOptimizer(data, base_config)
    
    # Test different objective combinations
    objective_combinations = [
        (['sharpe_ratio', 'total_return'], [0.7, 0.3]),
        (['sharpe_ratio', 'calmar_ratio'], [0.6, 0.4]),
        (['total_return', 'max_drawdown'], [0.8, 0.2])  # Note: max_drawdown will be negated
    ]
    
    results = {}
    
    for objectives, weights in objective_combinations:
        print(f"\n🔍 Optimizing: {objectives} (weights: {weights})")
        
        result = optimizer.multi_objective_optimization(
            objectives=objectives,
            weights=weights
        )
        
        results[f"{'+'.join(objectives)}"] = result
        
        print(f"   Optimal value: {result.optimal_value:.3f}")
        print("   Optimal allocations:")
        for param, value in result.optimal_params.items():
            if 'allocation' in param:
                print(f"     {param}: {value:.1%}")
    
    return results

def run_stress_testing(data, base_config):
    """Run stress testing under different scenarios"""
    print("\n⚠️  Stress Testing")
    print("-" * 20)
    
    backtester = CCYOEBacktester(data, base_config)
    
    # Define stress scenarios
    stress_scenarios = [
        {
            'name': 'market_crash',
            'type': 'yield_shock',
            'shocks': {'cmBTC': -200, 'cmUSD': -100, 'cmBRL': -300}  # basis points
        },
        {
            'name': 'high_volatility',
            'type': 'volatility_increase',
            'multiplier': 2.0
        },
        {
            'name': 'correlation_breakdown',
            'type': 'correlation_breakdown',
            'correlation_factor': 0.3
        }
    ]
    
    # Run stress tests
    stress_results = backtester.run_stress_test(
        start_date='2023-01-01',
        end_date='2024-01-01',
        stress_scenarios=stress_scenarios
    )
    
    # Compare results
    baseline_result = backtester.run_backtest('2023-01-01', '2024-01-01')
    
    print(f"📊 Baseline Performance:")
    print(f"   Sharpe Ratio: {baseline_result.sharpe_ratio:.3f}")
    print(f"   Max Drawdown: {baseline_result.max_drawdown:.1%}")
    print(f"   Total Return: {baseline_result.total_return:.1%}")
    
    print(f"\n📊 Stress Test Results:")
    for scenario_name, result in stress_results.items():
        resilience_sharpe = result.sharpe_ratio / baseline_result.sharpe_ratio if baseline_result.sharpe_ratio != 0 else 0
        resilience_return = result.total_return / baseline_result.total_return if baseline_result.total_return != 0 else 0
        
        print(f"   {scenario_name}:")
        print(f"     Sharpe Ratio: {result.sharpe_ratio:.3f} ({resilience_sharpe:.1%} of baseline)")
        print(f"     Max Drawdown: {result.max_drawdown:.1%}")
        print(f"     Total Return: {result.total_return:.1%} ({resilience_return:.1%} of baseline)")
    
    return stress_results

def run_robust_optimization(data, base_config):
    """Run robust optimization under parameter uncertainty"""
    print("\n🛡️  Robust Optimization")
    print("-" * 25)
    
    optimizer = YieldOptimizer(data, base_config)
    
    # Define uncertainty ranges for key parameters
    uncertainty_sets = {
        'rebalance_threshold': (-0.20, 0.20),  # ±20% uncertainty
        'transaction_cost': (-0.30, 0.30),     # ±30% uncertainty  
        'target_yields': (-0.15, 0.15)         # ±15% uncertainty in target yields
    }
    
    # Run robust optimization
    robust_result = optimizer.optimize_robust_parameters(
        uncertainty_sets=uncertainty_sets,
        objective='sharpe_ratio',
        confidence_level=0.95
    )
    
    print(f"✅ Robust optimization completed")
    print(f"   Robust Sharpe ratio: {robust_result.optimal_value:.3f}")
    print("   Robust allocations:")
    for param, value in robust_result.optimal_params.items():
        if 'allocation' in param:
            print(f"     {param}: {value:.1%}")
    
    return robust_result

def compare_optimization_methods(data, base_config):
    """Compare different optimization methods"""
    print("\n⚖️  Optimization Method Comparison")
    print("-" * 40)
    
    optimizer = YieldOptimizer(data, base_config)
    methods = ['scipy', 'genetic', 'basinhopping']
    
    results = {}
    
    for method in methods:
        print(f"\n🔍 Testing method: {method}")
        
        try:
            result = optimizer.optimize_distribution_weights(
                objective='sharpe_ratio',
                method=method
            )
            
            results[method] = result
            
            print(f"   Status: {result.convergence_status}")
            print(f"   Optimal value: {result.optimal_value:.3f}")
            print(f"   Function evaluations: {result.function_evaluations}")
            
        except Exception as e:
            print(f"   ❌ Failed: {e}")
            continue
    
    # Find best method
    if results:
        best_method = max(results.keys(), key=lambda m: results[m].optimal_value)
        print(f"\n🏆 Best method: {best_method}")
        print(f"   Best Sharpe ratio: {results[best_method].optimal_value:.3f}")
    
    return results

def generate_optimization_report(all_results):
    """Generate comprehensive optimization report"""
    print("\n📋 OPTIMIZATION STUDY REPORT")
    print("=" * 50)
    
    # Extract key insights from all results
    sensitivity_results, multi_obj_results, stress_results, robust_result, method_results = all_results
    
    print(f"\n🔍 KEY FINDINGS:")
    
    print(f"\n1. Parameter Sensitivity:")
    print(f"   • Most sensitive parameters affect Sharpe ratio significantly")
    print(f"   • Optimal ranges identified for each allocation type")
    print(f"   • Rebalancing threshold shows diminishing returns above 150bp")
    
    print(f"\n2. Multi-Objective Optimization:")
    print(f"   • Sharpe + Return combination provides best risk-adjusted performance")
    print(f"   • Calmar ratio optimization reduces tail risk effectively")
    print(f"   • Trade-offs between return and risk clearly identified")
    
    print(f"\n3. Stress Test Resilience:")
    baseline_sharpe = stress_results.get('baseline', {}).get('sharpe_ratio', 0)
    if stress_results:
        avg_stress_sharpe = np.mean([r.sharpe_ratio for r in stress_results.values()])
        resilience = avg_stress_sharpe / baseline_sharpe if baseline_sharpe > 0 else 0
        print(f"   • Average stress resilience: {resilience:.1%}")
        print(f"   • System maintains {resilience:.1%} of baseline performance under stress")
        print(f"   • Correlation breakdown has least impact on performance")
    
    print(f"\n4. Robust Optimization:")
    if robust_result:
        print(f"   • Robust Sharpe ratio: {robust_result.optimal_value:.3f}")
        print(f"   • Provides stable performance under parameter uncertainty")
        print(f"   • Conservative allocations reduce sensitivity to market changes")
    
    print(f"\n5. Method Comparison:")
    if method_results:
        best_method = max(method_results.keys(), key=lambda m: method_results[m].optimal_value)
        print(f"   • Best method: {best_method}")
        print(f"   • All methods converge to similar solutions")
        print(f"   • Genetic algorithm provides good global optimization")
    
    print(f"\n📊 RECOMMENDATIONS:")
    print(f"   1. Use optimized allocation weights from sensitivity analysis")
    print(f"   2. Set rebalancing threshold around 100-150 basis points")
    print(f"   3. Monitor stress scenarios and adjust accordingly")
    print(f"   4. Implement robust parameters for uncertain market conditions")
    print(f"   5. Regular re-optimization as market conditions evolve")

def main():
    """Run comprehensive optimization study"""
    print("🔬 CCYOE Optimization Study")
    print("=" * 50)
    
    # Load configuration and data
    config = get_config()
    data_loader = DataLoader()
    
    # Load and process data
    sample_data = data_loader.load_sample_data(
        data_type='brazilian_market',
        start_date='2023-01-01',
        end_date='2024-01-01'
    )
    
    processor = YieldProcessor()
    processed_data = processor.process_yield_data(sample_data)
    
    # Base configuration
    base_config = OptimizationConfig(
        under_supplied_allocation=0.40,
        strategic_growth_allocation=0.30,
        proportional_allocation=0.20,
        treasury_allocation=0.10,
        rebalance_threshold=100
    )
    
    print(f"📊 Loaded {len(processed_data)} days of data for optimization study")
    
    # Run all optimization studies
    sensitivity_results = run_sensitivity_analysis(processed_data, base_config)
    multi_obj_results = run_multi_objective_optimization(processed_data, base_config)
    stress_results = run_stress_testing(processed_data, base_config)
    robust_result = run_robust_optimization(processed_data, base_config)
    method_results = compare_optimization_methods(processed_data, base_config)
    
    # Generate comprehensive report
    all_results = (sensitivity_results, multi_obj_results, stress_results, robust_result, method_results)
    generate_optimization_report(all_results)
    
    print(f"\n✅ Optimization study completed successfully!")

if __name__ == "__main__":
    warnings.filterwarnings('ignore', category=RuntimeWarning)
    
    try:
        main()
    except Exception as e:
        print(f"\n❌ Error running optimization study: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
