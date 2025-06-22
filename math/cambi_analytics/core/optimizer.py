"""
Yield Optimizer - Advanced optimization engine for CCYOE parameters

Provides sophisticated optimization capabilities for:
- Distribution weight optimization
- Parameter sensitivity analysis
- Multi-objective optimization
- Constraint-based optimization
- Brazilian market specific optimizations
"""

import numpy as np
import pandas as pd
from scipy.optimize import minimize, differential_evolution, basinhopping
from typing import Dict, List, Optional, Tuple, Callable, Union
import warnings
from dataclasses import dataclass
from copy import deepcopy

try:
    import cvxpy as cp
    CVXPY_AVAILABLE = True
except ImportError:
    CVXPY_AVAILABLE = False
    warnings.warn("CVXPY not available. Some optimization methods will be disabled.")

# Import only what we need to avoid circular dependencies
from ..utils.helpers import validate_asset_weights
from ..utils.constants import OPTIMIZATION_CONSTRAINTS


@dataclass
class OptimizationResult:
    """Container for optimization results"""
    optimal_params: Dict[str, float]
    optimal_value: float
    optimization_method: str
    convergence_status: str
    iterations: int
    function_evaluations: int
    backtest_results: Optional[object] = None  # Use object to avoid circular import
    sensitivity_analysis: Optional[Dict] = None


class YieldOptimizer:
    """
    Advanced optimization engine for CCYOE parameters
    
    Supports multiple optimization algorithms and objectives:
    - Scipy optimizers (L-BFGS-B, SLSQP, differential evolution)
    - CVXPY for convex optimization
    - Custom genetic algorithms
    - Multi-objective optimization
    """
    
    def __init__(self, data: pd.DataFrame, base_config: Optional[object] = None):
        """
        Initialize the optimizer
        
        Args:
            data: Historical yield data for backtesting
            base_config: Base configuration for optimization
        """
        self.data = data
        self.base_config = base_config
        
        # Initialize metrics calculators (import locally to avoid circular dependency)
        from ..utils.metrics import PerformanceMetrics, RiskMetrics
        self.performance_metrics = PerformanceMetrics()
        self.risk_metrics = RiskMetrics()
        
        # Optimization cache
        self._cache = {}
        self._evaluation_count = 0
    
    def optimize_distribution_weights(
        self, 
        objective: str = 'sharpe_ratio',
        constraints: Optional[Dict] = None,
        bounds: Optional[Dict] = None,
        method: str = 'scipy',
        start_date: str = '2023-01-01',
        end_date: str = '2024-01-01'
    ) -> OptimizationResult:
        """
        Optimize CCYOE distribution weights
        
        Args:
            objective: Optimization objective ('sharpe_ratio', 'total_return', 'calmar_ratio', etc.)
            constraints: Additional constraints beyond default ones
            bounds: Parameter bounds override
            method: Optimization method ('scipy', 'cvxpy', 'genetic', 'basinhopping')
            start_date: Backtest start date
            end_date: Backtest end date
            
        Returns:
            OptimizationResult with optimal parameters and performance
        """
        # Set up constraints and bounds
        optimization_constraints = self._setup_constraints(constraints)
        optimization_bounds = self._setup_bounds(bounds)
        
        # Define objective function
        objective_func = self._create_objective_function(objective, start_date, end_date)
        
        # Reset evaluation counter
        self._evaluation_count = 0
        
        # Choose optimization method
        if method == 'scipy':
            result = self._optimize_scipy(objective_func, optimization_constraints, optimization_bounds)
        elif method == 'cvxpy' and CVXPY_AVAILABLE:
            result = self._optimize_cvxpy(objective_func, optimization_constraints, optimization_bounds)
        elif method == 'genetic':
            result = self._optimize_genetic(objective_func, optimization_constraints, optimization_bounds)
        elif method == 'basinhopping':
            result = self._optimize_basinhopping(objective_func, optimization_constraints, optimization_bounds)
        else:
            raise ValueError(f"Unknown optimization method: {method}")
        
        # Run final backtest with optimal parameters if possible
        if hasattr(self, '_run_backtest_with_params'):
            optimal_config = self._params_to_config(result.optimal_params)
            backtest_results = self._run_backtest_with_params(optimal_config, start_date, end_date)
            result.backtest_results = backtest_results
        
        return result
    
    def run_sensitivity_analysis(
        self, 
        parameters: List[str],
        ranges: Dict[str, Tuple[float, float]],
        objective: str = 'sharpe_ratio',
        start_date: str = '2023-01-01',
        end_date: str = '2024-01-01',
        n_points: int = 10
    ) -> Dict[str, pd.DataFrame]:
        """
        Run sensitivity analysis on specified parameters
        
        Args:
            parameters: List of parameters to analyze
            ranges: Dict mapping parameters to (min, max) ranges
            objective: Objective function to evaluate
            start_date: Backtest start date
            end_date: Backtest end date
            n_points: Number of points to evaluate for each parameter
            
        Returns:
            Dict mapping parameters to sensitivity DataFrames
        """
        # Import locally to avoid circular dependency
        from ..core.backtester import CCYOEBacktester
        
        sensitivity_results = {}
        
        for param in parameters:
            if param not in ranges:
                continue
            
            min_val, max_val = ranges[param]
            param_values = np.linspace(min_val, max_val, n_points)
            
            results = []
            for value in param_values:
                # Create modified config
                config = deepcopy(self.base_config)
                setattr(config, param, value)
                
                # Run backtest
                backtester = CCYOEBacktester(self.data, config)
                backtest_result = backtester.run_backtest(start_date, end_date)
                
                # Extract objective value
                objective_value = getattr(backtest_result, objective)
                
                results.append({
                    'parameter_value': value,
                    'objective_value': objective_value,
                    'total_return': backtest_result.total_return,
                    'volatility': backtest_result.volatility,
                    'sharpe_ratio': backtest_result.sharpe_ratio,
                    'max_drawdown': backtest_result.max_drawdown
                })
            
            sensitivity_results[param] = pd.DataFrame(results)
        
        return sensitivity_results
    
    def multi_objective_optimization(
        self, 
        objectives: List[str],
        weights: Optional[List[float]] = None,
        start_date: str = '2023-01-01',
        end_date: str = '2024-01-01'
    ) -> OptimizationResult:
        """
        Multi-objective optimization using weighted sum approach
        
        Args:
            objectives: List of objective functions to optimize
            weights: Weights for each objective (if None, equal weights)
            start_date: Backtest start date
            end_date: Backtest end date
            
        Returns:
            OptimizationResult with Pareto-optimal solution
        """
        if weights is None:
            weights = [1.0 / len(objectives)] * len(objectives)
        
        if len(weights) != len(objectives):
            raise ValueError("Number of weights must match number of objectives")
        
        # Create combined objective function
        def combined_objective(params):
            config = self._params_to_config(params)
            
            # Import locally to avoid circular dependency
            from ..core.backtester import CCYOEBacktester
            backtester = CCYOEBacktester(self.data, config)
            
            try:
                results = backtester.run_backtest(start_date, end_date)
                
                # Calculate weighted combination of objectives
                total_score = 0.0
                for obj, weight in zip(objectives, weights):
                    obj_value = getattr(results, obj, 0.0)
                    # Handle negative objectives (like max drawdown) by negating
                    if obj in ['max_drawdown', 'volatility']:
                        obj_value = -obj_value
                    total_score += weight * obj_value
                
                return -total_score  # Minimize negative of score
                
            except Exception:
                return float('inf')
        
        # Run optimization
        constraints = self._setup_constraints()
        bounds = self._setup_bounds()
        
        result = self._optimize_scipy(combined_objective, constraints, bounds)
        result.optimization_method = f"multi_objective_{result.optimization_method}"
        
        return result
    
    def _setup_constraints(self, additional_constraints: Optional[Dict] = None) -> List[Dict]:
        """Set up optimization constraints"""
        constraints = []
        
        # Distribution weights must sum to 1
        def weight_sum_constraint(params):
            return (params[0] + params[1] + params[2] + params[3]) - 1.0
        
        constraints.append({
            'type': 'eq',
            'fun': weight_sum_constraint
        })
        
        # Minimum allocations
        for i in range(4):  # 4 allocation parameters
            def min_constraint(params, idx=i):
                return params[idx] - OPTIMIZATION_CONSTRAINTS['min_allocation']
            constraints.append({
                'type': 'ineq',
                'fun': min_constraint
            })
        
        # Maximum allocations
        for i in range(4):
            def max_constraint(params, idx=i):
                return OPTIMIZATION_CONSTRAINTS['max_allocation'] - params[idx]
            constraints.append({
                'type': 'ineq',
                'fun': max_constraint
            })
        
        # Add additional constraints if provided
        if additional_constraints:
            for constraint_name, constraint_func in additional_constraints.items():
                constraints.append({
                    'type': 'ineq',
                    'fun': constraint_func
                })
        
        return constraints
    
    def _setup_bounds(self, bounds_override: Optional[Dict] = None) -> List[Tuple[float, float]]:
        """Set up parameter bounds"""
        default_bounds = [
            (OPTIMIZATION_CONSTRAINTS['min_allocation'], OPTIMIZATION_CONSTRAINTS['max_allocation']),  # under_supplied
            (OPTIMIZATION_CONSTRAINTS['min_allocation'], OPTIMIZATION_CONSTRAINTS['max_allocation']),  # strategic_growth
            (OPTIMIZATION_CONSTRAINTS['min_allocation'], OPTIMIZATION_CONSTRAINTS['max_allocation']),  # proportional
            (OPTIMIZATION_CONSTRAINTS['min_treasury_allocation'], OPTIMIZATION_CONSTRAINTS['max_treasury_allocation']),  # treasury
            (OPTIMIZATION_CONSTRAINTS['rebalance_threshold_min'], OPTIMIZATION_CONSTRAINTS['rebalance_threshold_max']),  # rebalance_threshold
            (OPTIMIZATION_CONSTRAINTS['transaction_cost_min'], OPTIMIZATION_CONSTRAINTS['transaction_cost_max'])  # transaction_cost
        ]
        
        if bounds_override:
            # Apply overrides
            param_names = [
                'under_supplied_allocation', 'strategic_growth_allocation', 
                'proportional_allocation', 'treasury_allocation',
                'rebalance_threshold', 'transaction_cost'
            ]
            
            for i, param_name in enumerate(param_names):
                if param_name in bounds_override:
                    default_bounds[i] = bounds_override[param_name]
        
        return default_bounds
    
    def _create_objective_function(self, objective: str, start_date: str, end_date: str) -> Callable:
        """Create objective function for optimization"""
        def objective_function(params):
            # Convert parameters to config
            config = self._params_to_config(params)
            
            # Create cache key
            cache_key = str(params)
            if cache_key in self._cache:
                return self._cache[cache_key]
            
            # Import locally to avoid circular dependency
            from ..core.backtester import CCYOEBacktester
            backtester = CCYOEBacktester(self.data, config)
            
            try:
                results = backtester.run_backtest(start_date, end_date)
                
                # Extract objective value
                if hasattr(results, objective):
                    value = getattr(results, objective)
                    
                    # For minimization, negate maximization objectives
                    if objective in ['total_return', 'annualized_return', 'sharpe_ratio', 'calmar_ratio']:
                        value = -value
                    
                    # Cache result
                    self._cache[cache_key] = value
                    self._evaluation_count += 1
                    
                    return value
                else:
                    return float('inf')
                    
            except Exception as e:
                warnings.warn(f"Backtest failed with parameters {params}: {e}")
                return float('inf')
        
        return objective_function
    
    def _params_to_config(self, params: Union[List, np.ndarray]) -> object:
        """Convert parameter array to OptimizationConfig"""
        # Import locally to avoid circular dependency
        from ..core.backtester import OptimizationConfig
        
        config = deepcopy(self.base_config) if self.base_config else OptimizationConfig()
        
        # Ensure we have at least 4 parameters for allocation weights
        if len(params) >= 4:
            config.under_supplied_allocation = params[0]
            config.strategic_growth_allocation = params[1]
            config.proportional_allocation = params[2]
            config.treasury_allocation = params[3]
        
        # Optional additional parameters
        if len(params) >= 5:
            config.rebalance_threshold = params[4]
        
        if len(params) >= 6:
            config.transaction_cost = params[5]
        
        return config
    
    def _config_to_params(self, config: object) -> np.ndarray:
        """Convert OptimizationConfig to parameter array"""
        return np.array([
            config.under_supplied_allocation,
            config.strategic_growth_allocation,
            config.proportional_allocation,
            config.treasury_allocation,
            config.rebalance_threshold,
            config.transaction_cost
        ])
    
    def _optimize_scipy(
        self, 
        objective_func: Callable, 
        constraints: List[Dict], 
        bounds: List[Tuple]
    ) -> OptimizationResult:
        """Optimize using scipy methods"""
        # Initial guess - start with base config
        if self.base_config:
            x0 = self._config_to_params(self.base_config)
        else:
            x0 = np.array([0.4, 0.3, 0.2, 0.1, 100, 5])  # Default values
        
        # Try multiple methods and choose best result
        methods = ['SLSQP', 'L-BFGS-B']
        best_result = None
        best_value = float('inf')
        
        for method in methods:
            try:
                if method == 'SLSQP':
                    result = minimize(
                        objective_func, 
                        x0, 
                        method=method,
                        bounds=bounds,
                        constraints=constraints,
                        options={'maxiter': 1000, 'disp': False}
                    )
                else:  # L-BFGS-B doesn't support constraints, so skip if we have them
                    if constraints:
                        continue
                    result = minimize(
                        objective_func, 
                        x0, 
                        method=method,
                        bounds=bounds,
                        options={'maxiter': 1000, 'disp': False}
                    )
                
                if result.fun < best_value:
                    best_result = result
                    best_value = result.fun
                    
            except Exception as e:
                warnings.warn(f"Optimization with {method} failed: {e}")
                continue
        
        if best_result is None:
            raise RuntimeError("All optimization methods failed")
        
        # Convert result to our format
        param_names = [
            'under_supplied_allocation', 'strategic_growth_allocation',
            'proportional_allocation', 'treasury_allocation',
            'rebalance_threshold', 'transaction_cost'
        ]
        
        optimal_params = {}
        for i, param_name in enumerate(param_names):
            if i < len(best_result.x):
                optimal_params[param_name] = best_result.x[i]
        
        return OptimizationResult(
            optimal_params=optimal_params,
            optimal_value=-best_result.fun if best_result.fun != float('inf') else best_result.fun,
            optimization_method='scipy',
            convergence_status='success' if best_result.success else 'failed',
            iterations=best_result.nit if hasattr(best_result, 'nit') else 0,
            function_evaluations=best_result.nfev if hasattr(best_result, 'nfev') else self._evaluation_count
        )
    
    def _optimize_genetic(
        self, 
        objective_func: Callable, 
        constraints: List[Dict], 
        bounds: List[Tuple]
    ) -> OptimizationResult:
        """Optimize using differential evolution (genetic algorithm)"""
        
        # Wrapper to handle constraints via penalty method
        def penalized_objective(params):
            penalty = 0.0
            
            # Check constraints
            for constraint in constraints:
                if constraint['type'] == 'eq':
                    violation = abs(constraint['fun'](params))
                    penalty += 1000 * violation ** 2
                elif constraint['type'] == 'ineq':
                    violation = max(0, -constraint['fun'](params))
                    penalty += 1000 * violation ** 2
            
            return objective_func(params) + penalty
        
        result = differential_evolution(
            penalized_objective,
            bounds,
            seed=42,
            maxiter=300,
            popsize=15,
            atol=1e-6,
            disp=False
        )
        
        param_names = [
            'under_supplied_allocation', 'strategic_growth_allocation',
            'proportional_allocation', 'treasury_allocation',
            'rebalance_threshold', 'transaction_cost'
        ]
        
        optimal_params = {}
        for i, param_name in enumerate(param_names):
            if i < len(result.x):
                optimal_params[param_name] = result.x[i]
        
        return OptimizationResult(
            optimal_params=optimal_params,
            optimal_value=-result.fun if result.fun != float('inf') else result.fun,
            optimization_method='genetic',
            convergence_status='success' if result.success else 'failed',
            iterations=result.nit,
            function_evaluations=result.nfev
        )
    
    def _optimize_basinhopping(
        self, 
        objective_func: Callable, 
        constraints: List[Dict], 
        bounds: List[Tuple]
    ) -> OptimizationResult:
        """Optimize using basin hopping for global optimization"""
        if self.base_config:
            x0 = self._config_to_params(self.base_config)
        else:
            x0 = np.array([0.4, 0.3, 0.2, 0.1, 100, 5])
        
        minimizer_kwargs = {
            "method": "SLSQP",
            "bounds": bounds,
            "constraints": constraints
        }
        
        result = basinhopping(
            objective_func,
            x0,
            niter=100,
            minimizer_kwargs=minimizer_kwargs,
            seed=42,
            disp=False
        )
        
        param_names = [
            'under_supplied_allocation', 'strategic_growth_allocation',
            'proportional_allocation', 'treasury_allocation',
            'rebalance_threshold', 'transaction_cost'
        ]
        
        optimal_params = {}
        for i, param_name in enumerate(param_names):
            if i < len(result.x):
                optimal_params[param_name] = result.x[i]
        
        return OptimizationResult(
            optimal_params=optimal_params,
            optimal_value=-result.fun if result.fun != float('inf') else result.fun,
            optimization_method='basinhopping',
            convergence_status='success' if result.minimization_failures == 0 else 'failed',
            iterations=result.nit,
            function_evaluations=result.nfev
        )
    
    def _optimize_cvxpy(
        self, 
        objective_func: Callable, 
        constraints: List[Dict], 
        bounds: List[Tuple]
    ) -> OptimizationResult:
        """Optimize using CVXPY for convex problems"""
        if not CVXPY_AVAILABLE:
            raise RuntimeError("CVXPY not available")
        
        # For now, fall back to scipy since CVXPY requires reformulating 
        # the backtesting objective as a convex problem
        return self._optimize_scipy(objective_func, constraints, bounds)
    
    def validate_optimization_results(self, result: OptimizationResult) -> bool:
        """
        Validate optimization results
        
        Args:
            result: OptimizationResult to validate
            
        Returns:
            True if results are valid
        """
        # Check if weights sum to 1
        allocation_weights = {
            k: v for k, v in result.optimal_params.items() 
            if k.endswith('_allocation')
        }
        
        if not validate_asset_weights(allocation_weights):
            return False
        
        # Check if parameters are within bounds
        bounds = self._setup_bounds()
        param_names = [
            'under_supplied_allocation', 'strategic_growth_allocation',
            'proportional_allocation', 'treasury_allocation',
            'rebalance_threshold', 'transaction_cost'
        ]
        
        for i, param_name in enumerate(param_names):
            if param_name in result.optimal_params:
                value = result.optimal_params[param_name]
                min_bound, max_bound = bounds[i]
                if value < min_bound or value > max_bound:
                    return False
        
        return True
