"""
Optimization Models - Advanced mathematical optimization for CCYOE

Provides mathematical optimization capabilities including:
- Portfolio optimization
- Mean-variance optimization
- Risk parity optimization
- Black-Litterman models
- Custom CCYOE optimization models
"""

import numpy as np
import pandas as pd
from scipy.optimize import minimize, Bounds, LinearConstraint
from typing import Dict, List, Optional, Tuple, Union, Callable
import warnings
from dataclasses import dataclass

try:
    import cvxpy as cp
    CVXPY_AVAILABLE = True
except ImportError:
    CVXPY_AVAILABLE = False

from ..utils.helpers import validate_asset_weights
from ..utils.constants import OPTIMIZATION_CONSTRAINTS


@dataclass
class OptimizationProblem:
    """Define an optimization problem"""
    objective: str
    variables: Dict[str, Tuple[float, float]]  # variable bounds
    constraints: List[Dict]
    parameters: Dict[str, float]


class OptimizationEngine:
    """
    Advanced optimization engine for portfolio and CCYOE problems
    
    Supports multiple optimization frameworks and objectives including:
    - Mean-variance optimization
    - Risk parity
    - Maximum diversification
    - Custom CCYOE objectives
    """
    
    def __init__(self):
        self.optimization_history = []
        self.current_solution = None
    
    def mean_variance_optimization(
        self,
        expected_returns: np.ndarray,
        covariance_matrix: np.ndarray,
        risk_aversion: float = 1.0,
        constraints: Optional[Dict] = None,
        bounds: Optional[Tuple[float, float]] = None
    ) -> Dict[str, Union[np.ndarray, float]]:
        """
        Perform mean-variance optimization
        
        Args:
            expected_returns: Expected returns vector
            covariance_matrix: Asset covariance matrix
            risk_aversion: Risk aversion parameter (higher = more risk averse)
            constraints: Additional constraints
            bounds: Weight bounds for each asset
            
        Returns:
            Dict with optimal weights and metrics
        """
        n_assets = len(expected_returns)
        
        if bounds is None:
            bounds = [(0.0, 1.0)] * n_assets
        
        # Objective function: maximize utility = expected return - 0.5 * risk_aversion * variance
        def objective(weights):
            portfolio_return = np.dot(weights, expected_returns)
            portfolio_variance = np.dot(weights.T, np.dot(covariance_matrix, weights))
            utility = portfolio_return - 0.5 * risk_aversion * portfolio_variance
            return -utility  # Minimize negative utility
        
        # Constraints
        constraints_list = []
        
        # Weights sum to 1
        constraints_list.append({
            'type': 'eq',
            'fun': lambda w: np.sum(w) - 1.0
        })
        
        # Add custom constraints
        if constraints:
            for constraint in constraints.get('custom', []):
                constraints_list.append(constraint)
        
        # Initial guess - equal weights
        x0 = np.ones(n_assets) / n_assets
        
        # Solve optimization
        result = minimize(
            objective,
            x0,
            method='SLSQP',
            bounds=bounds,
            constraints=constraints_list,
            options={'maxiter': 1000}
        )
        
        if not result.success:
            warnings.warn(f"Optimization failed: {result.message}")
        
        optimal_weights = result.x
        portfolio_return = np.dot(optimal_weights, expected_returns)
        portfolio_variance = np.dot(optimal_weights.T, np.dot(covariance_matrix, optimal_weights))
        portfolio_volatility = np.sqrt(portfolio_variance)
        
        return {
            'weights': optimal_weights,
            'expected_return': portfolio_return,
            'volatility': portfolio_volatility,
            'sharpe_ratio': portfolio_return / portfolio_volatility if portfolio_volatility > 0 else 0,
            'success': result.success,
            'message': result.message
        }
    
    def risk_parity_optimization(
        self,
        covariance_matrix: np.ndarray,
        target_risk_contributions: Optional[np.ndarray] = None,
        bounds: Optional[Tuple[float, float]] = None
    ) -> Dict[str, Union[np.ndarray, float]]:
        """
        Perform risk parity optimization
        
        Args:
            covariance_matrix: Asset covariance matrix
            target_risk_contributions: Target risk contributions (if None, use equal risk)
            bounds: Weight bounds for each asset
            
        Returns:
            Dict with optimal weights and risk contributions
        """
        n_assets = covariance_matrix.shape[0]
        
        if target_risk_contributions is None:
            target_risk_contributions = np.ones(n_assets) / n_assets
        
        if bounds is None:
            bounds = [(0.001, 1.0)] * n_assets  # Small lower bound to avoid division by zero
        
        def risk_contributions(weights):
            """Calculate risk contributions"""
            portfolio_variance = np.dot(weights.T, np.dot(covariance_matrix, weights))
            marginal_contributions = np.dot(covariance_matrix, weights)
            risk_contribs = weights * marginal_contributions / portfolio_variance
            return risk_contribs
        
        def objective(weights):
            """Minimize sum of squared deviations from target risk contributions"""
            current_risk_contribs = risk_contributions(weights)
            return np.sum((current_risk_contribs - target_risk_contributions) ** 2)
        
        # Constraint: weights sum to 1
        constraints = [{
            'type': 'eq',
            'fun': lambda w: np.sum(w) - 1.0
        }]
        
        # Initial guess
        x0 = np.ones(n_assets) / n_assets
        
        # Solve optimization
        result = minimize(
            objective,
            x0,
            method='SLSQP',
            bounds=bounds,
            constraints=constraints,
            options={'maxiter': 1000}
        )
        
        if not result.success:
            warnings.warn(f"Risk parity optimization failed: {result.message}")
        
        optimal_weights = result.x
        final_risk_contribs = risk_contributions(optimal_weights)
        portfolio_volatility = np.sqrt(np.dot(optimal_weights.T, np.dot(covariance_matrix, optimal_weights)))
        
        return {
            'weights': optimal_weights,
            'risk_contributions': final_risk_contribs,
            'target_risk_contributions': target_risk_contributions,
            'portfolio_volatility': portfolio_volatility,
            'tracking_error': np.sqrt(np.sum((final_risk_contribs - target_risk_contributions) ** 2)),
            'success': result.success,
            'message': result.message
        }
    
    def maximum_diversification_optimization(
        self,
        expected_returns: np.ndarray,
        covariance_matrix: np.ndarray,
        bounds: Optional[Tuple[float, float]] = None
    ) -> Dict[str, Union[np.ndarray, float]]:
        """
        Maximize diversification ratio: weighted average volatility / portfolio volatility
        
        Args:
            expected_returns: Expected returns vector (not used in calculation but kept for consistency)
            covariance_matrix: Asset covariance matrix
            bounds: Weight bounds for each asset
            
        Returns:
            Dict with optimal weights and diversification metrics
        """
        n_assets = covariance_matrix.shape[0]
        asset_volatilities = np.sqrt(np.diag(covariance_matrix))
        
        if bounds is None:
            bounds = [(0.0, 1.0)] * n_assets
        
        def objective(weights):
            """Minimize negative diversification ratio"""
            weighted_avg_vol = np.dot(weights, asset_volatilities)
            portfolio_vol = np.sqrt(np.dot(weights.T, np.dot(covariance_matrix, weights)))
            diversification_ratio = weighted_avg_vol / portfolio_vol if portfolio_vol > 0 else 0
            return -diversification_ratio
        
        # Constraints
        constraints = [{
            'type': 'eq',
            'fun': lambda w: np.sum(w) - 1.0
        }]
        
        # Initial guess
        x0 = np.ones(n_assets) / n_assets
        
        # Solve optimization
        result = minimize(
            objective,
            x0,
            method='SLSQP',
            bounds=bounds,
            constraints=constraints,
            options={'maxiter': 1000}
        )
        
        if not result.success:
            warnings.warn(f"Maximum diversification optimization failed: {result.message}")
        
        optimal_weights = result.x
        weighted_avg_vol = np.dot(optimal_weights, asset_volatilities)
        portfolio_vol = np.sqrt(np.dot(optimal_weights.T, np.dot(covariance_matrix, optimal_weights)))
        diversification_ratio = weighted_avg_vol / portfolio_vol if portfolio_vol > 0 else 0
        
        return {
            'weights': optimal_weights,
            'diversification_ratio': diversification_ratio,
            'portfolio_volatility': portfolio_vol,
            'weighted_average_volatility': weighted_avg_vol,
            'success': result.success,
            'message': result.message
        }
    
    def minimum_variance_optimization(
        self,
        covariance_matrix: np.ndarray,
        bounds: Optional[Tuple[float, float]] = None,
        constraints: Optional[List[Dict]] = None
    ) -> Dict[str, Union[np.ndarray, float]]:
        """
        Minimize portfolio variance (Global Minimum Variance Portfolio)
        
        Args:
            covariance_matrix: Asset covariance matrix
            bounds: Weight bounds for each asset
            constraints: Additional constraints
            
        Returns:
            Dict with optimal weights and risk metrics
        """
        n_assets = covariance_matrix.shape[0]
        
        if bounds is None:
            bounds = [(0.0, 1.0)] * n_assets
        
        def objective(weights):
            """Minimize portfolio variance"""
            return np.dot(weights.T, np.dot(covariance_matrix, weights))
        
        # Default constraints
        constraints_list = [{
            'type': 'eq',
            'fun': lambda w: np.sum(w) - 1.0
        }]
        
        # Add additional constraints
        if constraints:
            constraints_list.extend(constraints)
        
        # Initial guess
        x0 = np.ones(n_assets) / n_assets
        
        # Solve optimization
        result = minimize(
            objective,
            x0,
            method='SLSQP',
            bounds=bounds,
            constraints=constraints_list,
            options={'maxiter': 1000}
        )
        
        if not result.success:
            warnings.warn(f"Minimum variance optimization failed: {result.message}")
        
        optimal_weights = result.x
        portfolio_variance = np.dot(optimal_weights.T, np.dot(covariance_matrix, optimal_weights))
        portfolio_volatility = np.sqrt(portfolio_variance)
        
        return {
            'weights': optimal_weights,
            'portfolio_variance': portfolio_variance,
            'portfolio_volatility': portfolio_volatility,
            'success': result.success,
            'message': result.message
        }
    
    def black_litterman_optimization(
        self,
        market_caps: np.ndarray,
        covariance_matrix: np.ndarray,
        risk_aversion: float = 3.0,
        views: Optional[Dict] = None,
        tau: float = 0.025
    ) -> Dict[str, Union[np.ndarray, float]]:
        """
        Black-Litterman optimization with investor views
        
        Args:
            market_caps: Market capitalizations for equilibrium returns
            covariance_matrix: Asset covariance matrix
            risk_aversion: Market risk aversion parameter
            views: Dict with 'P' (picking matrix), 'Q' (view returns), 'Omega' (uncertainty)
            tau: Scales uncertainty of prior
            
        Returns:
            Dict with optimal weights and expected returns
        """
        n_assets = len(market_caps)
        
        # Market weights (proportional to market cap)
        w_market = market_caps / np.sum(market_caps)
        
        # Implied equilibrium returns
        pi = risk_aversion * np.dot(covariance_matrix, w_market)
        
        if views is None:
            # No views - return market portfolio
            bl_returns = pi
            bl_weights = w_market
        else:
            P = views['P']  # Picking matrix
            Q = views['Q']  # View returns
            Omega = views.get('Omega', np.eye(len(Q)))  # View uncertainty
            
            # Black-Litterman calculations
            tau_sigma = tau * covariance_matrix
            
            # New expected returns
            M1 = np.linalg.inv(tau_sigma)
            M2 = np.dot(P.T, np.dot(np.linalg.inv(Omega), P))
            M3 = np.dot(np.linalg.inv(tau_sigma), pi)
            M4 = np.dot(P.T, np.dot(np.linalg.inv(Omega), Q))
            
            bl_returns = np.dot(np.linalg.inv(M1 + M2), M3 + M4)
            
            # New covariance matrix
            bl_covariance = np.linalg.inv(M1 + M2)
            
            # Optimal weights
            bl_weights = np.dot(np.linalg.inv(risk_aversion * bl_covariance), bl_returns)
            
            # Normalize weights to sum to 1
            bl_weights = bl_weights / np.sum(bl_weights)
        
        portfolio_return = np.dot(bl_weights, bl_returns)
        portfolio_variance = np.dot(bl_weights.T, np.dot(covariance_matrix, bl_weights))
        portfolio_volatility = np.sqrt(portfolio_variance)
        
        return {
            'weights': bl_weights,
            'expected_returns': bl_returns,
            'implied_returns': pi,
            'portfolio_return': portfolio_return,
            'portfolio_volatility': portfolio_volatility,
            'sharpe_ratio': portfolio_return / portfolio_volatility if portfolio_volatility > 0 else 0
        }
    
    def ccyoe_yield_optimization(
        self,
        asset_yields: np.ndarray,
        target_yields: np.ndarray,
        allocation_bounds: Dict[str, Tuple[float, float]],
        rebalance_cost: float = 0.001
    ) -> Dict[str, Union[np.ndarray, float]]:
        """
        CCYOE-specific yield optimization
        
        Args:
            asset_yields: Current asset yields
            target_yields: Target yields for each asset
            allocation_bounds: Bounds for each allocation type
            rebalance_cost: Cost of rebalancing (as fraction)
            
        Returns:
            Dict with optimal allocation weights
        """
        # Calculate excess yields
        excess_yields = np.maximum(0, asset_yields - target_yields)
        total_excess = np.sum(excess_yields)
        
        if total_excess <= 0:
            # No excess yield to redistribute
            return {
                'under_supplied_allocation': 0.0,
                'strategic_growth_allocation': 0.0,
                'proportional_allocation': 0.0,
                'treasury_allocation': 0.0,
                'total_excess_yield': 0.0,
                'optimization_value': 0.0
            }
        
        def objective(allocations):
            """Maximize total utility from yield redistribution"""
            under_supplied, strategic, proportional, treasury = allocations
            
            # Utility from each allocation type (diminishing returns)
            utility = (
                np.sqrt(under_supplied) * 2.0 +  # Higher weight for under-supplied assets
                np.sqrt(strategic) * 1.5 +       # Strategic growth
                np.sqrt(proportional) * 1.0 +    # Proportional distribution
                np.sqrt(treasury) * 0.5          # Treasury (lowest utility)
            )
            
            # Subtract rebalancing cost
            total_allocation = under_supplied + strategic + proportional + treasury
            cost = rebalance_cost * total_allocation * total_excess
            
            return -(utility - cost)  # Minimize negative utility
        
        # Constraints
        constraints = [
            # Allocations sum to 1
            {
                'type': 'eq',
                'fun': lambda x: np.sum(x) - 1.0
            }
        ]
        
        # Bounds
        bounds = [
            allocation_bounds.get('under_supplied', (0.3, 0.5)),
            allocation_bounds.get('strategic', (0.2, 0.4)),
            allocation_bounds.get('proportional', (0.1, 0.3)),
            allocation_bounds.get('treasury', (0.05, 0.2))
        ]
        
        # Initial guess
        x0 = np.array([0.4, 0.3, 0.2, 0.1])
        
        # Solve optimization
        result = minimize(
            objective,
            x0,
            method='SLSQP',
            bounds=bounds,
            constraints=constraints,
            options={'maxiter': 1000}
        )
        
        if not result.success:
            warnings.warn(f"CCYOE optimization failed: {result.message}")
        
        optimal_allocations = result.x
        
        return {
            'under_supplied_allocation': optimal_allocations[0],
            'strategic_growth_allocation': optimal_allocations[1],
            'proportional_allocation': optimal_allocations[2],
            'treasury_allocation': optimal_allocations[3],
            'total_excess_yield': total_excess,
            'optimization_value': -result.fun,
            'success': result.success,
            'message': result.message
        }
    
    def efficient_frontier(
        self,
        expected_returns: np.ndarray,
        covariance_matrix: np.ndarray,
        num_points: int = 50,
        bounds: Optional[Tuple[float, float]] = None
    ) -> Dict[str, np.ndarray]:
        """
        Calculate efficient frontier
        
        Args:
            expected_returns: Expected returns vector
            covariance_matrix: Asset covariance matrix
            num_points: Number of points on frontier
            bounds: Weight bounds for each asset
            
        Returns:
            Dict with frontier returns, volatilities, and weights
        """
        n_assets = len(expected_returns)
        
        if bounds is None:
            bounds = [(0.0, 1.0)] * n_assets
        
        # Find minimum and maximum return portfolios
        min_vol_result = self.minimum_variance_optimization(covariance_matrix, bounds)
        min_return = np.dot(min_vol_result['weights'], expected_returns)
        
        # Maximum return portfolio (usually just the highest returning asset)
        max_return = np.max(expected_returns)
        
        # Target returns along the frontier
        target_returns = np.linspace(min_return, max_return * 0.95, num_points)
        
        frontier_volatilities = []
        frontier_weights = []
        frontier_sharpe_ratios = []
        
        for target_return in target_returns:
            # Minimize variance subject to target return constraint
            def objective(weights):
                return np.dot(weights.T, np.dot(covariance_matrix, weights))
            
            constraints = [
                {'type': 'eq', 'fun': lambda w: np.sum(w) - 1.0},
                {'type': 'eq', 'fun': lambda w: np.dot(w, expected_returns) - target_return}
            ]
            
            x0 = np.ones(n_assets) / n_assets
            
            result = minimize(
                objective,
                x0,
                method='SLSQP',
                bounds=bounds,
                constraints=constraints,
                options={'maxiter': 1000}
            )
            
            if result.success:
                weights = result.x
                volatility = np.sqrt(objective(weights))
                sharpe_ratio = target_return / volatility if volatility > 0 else 0
                
                frontier_volatilities.append(volatility)
                frontier_weights.append(weights)
                frontier_sharpe_ratios.append(sharpe_ratio)
            else:
                # If optimization fails, skip this point
                continue
        
        return {
            'returns': target_returns[:len(frontier_volatilities)],
            'volatilities': np.array(frontier_volatilities),
            'weights': np.array(frontier_weights),
            'sharpe_ratios': np.array(frontier_sharpe_ratios)
        }
    
    def solve_custom_problem(self, problem: OptimizationProblem) -> Dict:
        """
        Solve a custom optimization problem
        
        Args:
            problem: OptimizationProblem instance
            
        Returns:
            Dict with solution
        """
        # This is a framework for custom problems
        # Implementation would depend on the specific problem structure
        raise NotImplementedError("Custom problem solving not yet implemented")
