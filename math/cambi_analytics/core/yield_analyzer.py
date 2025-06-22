"""
Yield Analyzer - Core yield analysis functionality for CCYOE

Provides comprehensive analysis of yield data including:
- Historical yield trends and patterns
- Volatility and correlation analysis  
- Statistical analysis and outlier detection
- Seasonal pattern identification
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, Union
from datetime import datetime, timedelta
import warnings
from scipy import stats
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA

from ..utils.metrics import PerformanceMetrics, RiskMetrics
from ..utils.helpers import calculate_business_days, validate_data
from ..utils.constants import ASSET_IDS


class YieldAnalyzer:
    """
    Advanced yield analysis for Brazilian RWA and synthetic assets
    
    Attributes:
        data (pd.DataFrame): Historical yield data
        assets (List[str]): List of asset identifiers
        date_column (str): Name of date column
        performance_metrics (PerformanceMetrics): Performance calculation instance
        risk_metrics (RiskMetrics): Risk calculation instance
    """
    
    def __init__(
        self, 
        data: pd.DataFrame, 
        date_column: str = 'date',
        assets: Optional[List[str]] = None
    ):
        """
        Initialize the YieldAnalyzer
        
        Args:
            data: DataFrame with yield data (columns: date, asset yields)
            date_column: Name of the date column
            assets: List of asset names to analyze (if None, infer from data)
        """
        self.data = self._validate_and_prepare_data(data, date_column)
        self.date_column = date_column
        self.assets = assets or self._infer_assets(data)
        
        # Initialize metrics calculators
        self.performance_metrics = PerformanceMetrics()
        self.risk_metrics = RiskMetrics()
        
        # Cache for expensive calculations
        self._correlation_cache = {}
        self._volatility_cache = {}
        
    def _validate_and_prepare_data(self, data: pd.DataFrame, date_column: str) -> pd.DataFrame:
        """Validate and prepare input data"""
        if data.empty:
            raise ValueError("Input data cannot be empty")
            
        if date_column not in data.columns:
            raise ValueError(f"Date column '{date_column}' not found in data")
            
        # Ensure date column is datetime
        data = data.copy()
        data[date_column] = pd.to_datetime(data[date_column])
        
        # Sort by date
        data = data.sort_values(date_column).reset_index(drop=True)
        
        # Validate yield data (should be numeric and reasonable)
        numeric_columns = data.select_dtypes(include=[np.number]).columns
        for col in numeric_columns:
            if col == date_column:
                continue
            
            # Check for reasonable yield values (0-50% annual)
            if (data[col] < 0).any() or (data[col] > 5000).any():  # 5000 basis points = 50%
                warnings.warn(f"Unusual yield values detected in {col}")
        
        return data
    
    def _infer_assets(self, data: pd.DataFrame) -> List[str]:
        """Infer asset names from data columns"""
        excluded_columns = {self.date_column, 'timestamp', 'date', 'time'}
        return [col for col in data.columns if col not in excluded_columns]
    
    def calculate_correlation_matrix(
        self, 
        method: str = 'pearson',
        min_periods: int = 30
    ) -> pd.DataFrame:
        """
        Calculate correlation matrix between asset yields
        
        Args:
            method: Correlation method ('pearson', 'spearman', 'kendall')
            min_periods: Minimum number of observations for correlation
            
        Returns:
            Correlation matrix DataFrame
        """
        cache_key = f"{method}_{min_periods}"
        if cache_key in self._correlation_cache:
            return self._correlation_cache[cache_key]
        
        # Extract yield data for assets
        yield_data = self.data[self.assets]
        
        # Calculate correlation matrix
        correlation_matrix = yield_data.corr(method=method, min_periods=min_periods)
        
        # Cache result
        self._correlation_cache[cache_key] = correlation_matrix
        
        return correlation_matrix
    
    def calculate_volatility_metrics(
        self, 
        window: int = 30,
        annualize: bool = True
    ) -> Dict[str, Dict[str, float]]:
        """
        Calculate comprehensive volatility metrics for each asset
        
        Args:
            window: Rolling window for volatility calculation
            annualize: Whether to annualize the volatility
            
        Returns:
            Dictionary with volatility metrics for each asset
        """
        cache_key = f"volatility_{window}_{annualize}"
        if cache_key in self._volatility_cache:
            return self._volatility_cache[cache_key]
        
        volatility_metrics = {}
        
        for asset in self.assets:
            asset_data = self.data[asset].dropna()
            
            if len(asset_data) < window:
                continue
                
            # Calculate daily changes
            daily_changes = asset_data.diff().dropna()
            
            # Basic volatility (standard deviation)
            volatility = daily_changes.std()
            if annualize:
                volatility *= np.sqrt(252)  # Annualize assuming 252 trading days
            
            # Rolling volatility
            rolling_vol = daily_changes.rolling(window=window).std()
            if annualize:
                rolling_vol *= np.sqrt(252)
            
            # Additional metrics
            metrics = {
                'volatility': volatility,
                'avg_rolling_volatility': rolling_vol.mean(),
                'max_rolling_volatility': rolling_vol.max(),
                'min_rolling_volatility': rolling_vol.min(),
                'volatility_of_volatility': rolling_vol.std(),
                'skewness': stats.skew(daily_changes),
                'kurtosis': stats.kurtosis(daily_changes),
                'jarque_bera_stat': stats.jarque_bera(daily_changes)[0],
                'jarque_bera_pvalue': stats.jarque_bera(daily_changes)[1]
            }
            
            volatility_metrics[asset] = metrics
        
        # Cache result
        self._volatility_cache[cache_key] = volatility_metrics
        
        return volatility_metrics
    
    def get_average_yield(
        self, 
        asset: str, 
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> float:
        """
        Calculate average yield for an asset over specified period
        
        Args:
            asset: Asset identifier
            start_date: Start date for calculation (if None, use all data)
            end_date: End date for calculation (if None, use all data)
            
        Returns:
            Average yield in basis points
        """
        if asset not in self.assets:
            raise ValueError(f"Asset {asset} not found in data")
        
        # Filter data by date range
        data_subset = self.data.copy()
        if start_date:
            data_subset = data_subset[data_subset[self.date_column] >= start_date]
        if end_date:
            data_subset = data_subset[data_subset[self.date_column] <= end_date]
        
        return data_subset[asset].mean()
    
    def get_yield_volatility(
        self, 
        asset: str,
        annualize: bool = True
    ) -> float:
        """
        Calculate yield volatility for an asset
        
        Args:
            asset: Asset identifier
            annualize: Whether to annualize the volatility
            
        Returns:
            Yield volatility in basis points
        """
        if asset not in self.assets:
            raise ValueError(f"Asset {asset} not found in data")
        
        daily_changes = self.data[asset].diff().dropna()
        volatility = daily_changes.std()
        
        if annualize:
            volatility *= np.sqrt(252)
            
        return volatility
    
    def detect_outliers(
        self, 
        method: str = 'iqr',
        threshold: float = 2.5
    ) -> pd.DataFrame:
        """
        Detect outliers in yield data
        
        Args:
            method: Outlier detection method ('iqr', 'zscore', 'modified_zscore')
            threshold: Threshold for outlier detection
            
        Returns:
            DataFrame with outlier flags for each asset
        """
        outlier_data = self.data.copy()
        
        for asset in self.assets:
            asset_data = self.data[asset].dropna()
            
            if method == 'iqr':
                Q1 = asset_data.quantile(0.25)
                Q3 = asset_data.quantile(0.75)
                IQR = Q3 - Q1
                lower_bound = Q1 - threshold * IQR
                upper_bound = Q3 + threshold * IQR
                outliers = (asset_data < lower_bound) | (asset_data > upper_bound)
                
            elif method == 'zscore':
                z_scores = np.abs(stats.zscore(asset_data))
                outliers = z_scores > threshold
                
            elif method == 'modified_zscore':
                median = np.median(asset_data)
                mad = np.median(np.abs(asset_data - median))
                modified_z_scores = 0.6745 * (asset_data - median) / mad
                outliers = np.abs(modified_z_scores) > threshold
                
            else:
                raise ValueError(f"Unknown outlier detection method: {method}")
            
            # Add outlier flags to data
            outlier_column = f"{asset}_outlier"
            outlier_data[outlier_column] = False
            outlier_data.loc[outliers.index[outliers], outlier_column] = True
        
        return outlier_data
    
    def detect_seasonal_patterns(
        self, 
        asset: str,
        frequency: str = 'monthly'
    ) -> Dict[str, float]:
        """
        Detect seasonal patterns in yield data
        
        Args:
            asset: Asset identifier
            frequency: Seasonality frequency ('monthly', 'quarterly', 'weekly')
            
        Returns:
            Dictionary with seasonal statistics
        """
        if asset not in self.assets:
            raise ValueError(f"Asset {asset} not found in data")
        
        asset_data = self.data[[self.date_column, asset]].copy()
        asset_data = asset_data.dropna()
        
        # Add time-based features
        asset_data['month'] = asset_data[self.date_column].dt.month
        asset_data['quarter'] = asset_data[self.date_column].dt.quarter
        asset_data['week'] = asset_data[self.date_column].dt.isocalendar().week
        asset_data['day_of_week'] = asset_data[self.date_column].dt.dayofweek
        
        seasonal_stats = {}
        
        if frequency == 'monthly':
            monthly_stats = asset_data.groupby('month')[asset].agg(['mean', 'std', 'count'])
            seasonal_stats['monthly_means'] = monthly_stats['mean'].to_dict()
            seasonal_stats['monthly_volatility'] = monthly_stats['std'].to_dict()
            seasonal_stats['monthly_variance'] = monthly_stats['mean'].var()
            
        elif frequency == 'quarterly':
            quarterly_stats = asset_data.groupby('quarter')[asset].agg(['mean', 'std', 'count'])
            seasonal_stats['quarterly_means'] = quarterly_stats['mean'].to_dict()
            seasonal_stats['quarterly_volatility'] = quarterly_stats['std'].to_dict()
            seasonal_stats['quarterly_variance'] = quarterly_stats['mean'].var()
            
        elif frequency == 'weekly':
            weekly_stats = asset_data.groupby('day_of_week')[asset].agg(['mean', 'std', 'count'])
            seasonal_stats['weekly_means'] = weekly_stats['mean'].to_dict()
            seasonal_stats['weekly_volatility'] = weekly_stats['std'].to_dict()
            seasonal_stats['weekly_variance'] = weekly_stats['mean'].var()
        
        return seasonal_stats
    
    def calculate_stability_metrics(self) -> Dict[str, Dict[str, float]]:
        """
        Calculate yield stability metrics for all assets
        
        Returns:
            Dictionary with stability metrics for each asset
        """
        stability_metrics = {}
        
        for asset in self.assets:
            asset_data = self.data[asset].dropna()
            
            if len(asset_data) < 30:  # Need sufficient data
                continue
            
            # Calculate various stability measures
            daily_changes = asset_data.diff().dropna()
            
            metrics = {
                'coefficient_of_variation': asset_data.std() / asset_data.mean(),
                'range_ratio': (asset_data.max() - asset_data.min()) / asset_data.mean(),
                'stability_ratio': len(daily_changes[np.abs(daily_changes) < asset_data.std()]) / len(daily_changes),
                'trend_stability': self._calculate_trend_stability(asset_data),
                'autocorrelation_1day': asset_data.autocorr(lag=1),
                'autocorrelation_7day': asset_data.autocorr(lag=7) if len(asset_data) > 7 else np.nan,
                'autocorrelation_30day': asset_data.autocorr(lag=30) if len(asset_data) > 30 else np.nan,
            }
            
            stability_metrics[asset] = metrics
        
        return stability_metrics
    
    def _calculate_trend_stability(self, data: pd.Series) -> float:
        """Calculate trend stability using linear regression R-squared"""
        if len(data) < 10:
            return np.nan
        
        x = np.arange(len(data))
        slope, intercept, r_value, p_value, std_err = stats.linregress(x, data)
        return r_value ** 2
    
    def calculate_cross_asset_analysis(self) -> Dict[str, Union[float, Dict]]:
        """
        Perform cross-asset analysis including diversification benefits
        
        Returns:
            Dictionary with cross-asset metrics
        """
        if len(self.assets) < 2:
            return {}
        
        # Get correlation matrix
        corr_matrix = self.calculate_correlation_matrix()
        
        # Calculate diversification ratio
        individual_volatilities = []
        for asset in self.assets:
            vol = self.get_yield_volatility(asset, annualize=False)
            individual_volatilities.append(vol)
        
        # Portfolio volatility (equal weights)
        weights = np.array([1/len(self.assets)] * len(self.assets))
        cov_matrix = self.data[self.assets].cov()
        portfolio_variance = np.dot(weights.T, np.dot(cov_matrix, weights))
        portfolio_volatility = np.sqrt(portfolio_variance)
        
        weighted_avg_volatility = np.dot(weights, individual_volatilities)
        diversification_ratio = weighted_avg_volatility / portfolio_volatility
        
        # Principal component analysis for dimensionality
        try:
            yield_data_scaled = StandardScaler().fit_transform(self.data[self.assets].fillna(method='ffill'))
            pca = PCA()
            pca.fit(yield_data_scaled)
            explained_variance_ratio = pca.explained_variance_ratio_
        except Exception:
            explained_variance_ratio = np.array([np.nan])
        
        return {
            'diversification_ratio': diversification_ratio,
            'average_correlation': corr_matrix.values[np.triu_indices_from(corr_matrix.values, k=1)].mean(),
            'max_correlation': corr_matrix.values[np.triu_indices_from(corr_matrix.values, k=1)].max(),
            'min_correlation': corr_matrix.values[np.triu_indices_from(corr_matrix.values, k=1)].min(),
            'portfolio_volatility': portfolio_volatility,
            'individual_volatilities': dict(zip(self.assets, individual_volatilities)),
            'first_pc_variance': explained_variance_ratio[0] if len(explained_variance_ratio) > 0 else np.nan,
            'effective_number_of_assets': 1 / np.sum(weights**2)  # Herfindahl index
        }
    
    def generate_summary_report(self) -> Dict[str, Union[str, float, Dict]]:
        """
        Generate comprehensive summary report
        
        Returns:
            Dictionary with summary statistics and insights
        """
        report = {
            'analysis_period': {
                'start_date': self.data[self.date_column].min().strftime('%Y-%m-%d'),
                'end_date': self.data[self.date_column].max().strftime('%Y-%m-%d'),
                'total_days': (self.data[self.date_column].max() - self.data[self.date_column].min()).days,
                'observations': len(self.data)
            },
            'assets_analyzed': len(self.assets),
            'asset_list': self.assets,
        }
        
        # Add asset-specific metrics
        asset_summary = {}
        for asset in self.assets:
            asset_data = self.data[asset].dropna()
            if len(asset_data) == 0:
                continue
                
            asset_summary[asset] = {
                'average_yield': self.get_average_yield(asset),
                'volatility': self.get_yield_volatility(asset),
                'min_yield': asset_data.min(),
                'max_yield': asset_data.max(),
                'observations': len(asset_data),
                'missing_data_pct': (len(self.data) - len(asset_data)) / len(self.data) * 100
            }
        
        report['asset_summary'] = asset_summary
        
        # Add cross-asset analysis
        report['cross_asset_analysis'] = self.calculate_cross_asset_analysis()
        
        # Add correlation insights
        corr_matrix = self.calculate_correlation_matrix()
        report['correlation_insights'] = {
            'highest_correlation_pair': self._find_highest_correlation_pair(corr_matrix),
            'lowest_correlation_pair': self._find_lowest_correlation_pair(corr_matrix),
            'average_correlation': corr_matrix.values[np.triu_indices_from(corr_matrix.values, k=1)].mean()
        }
        
        return report
    
    def _find_highest_correlation_pair(self, corr_matrix: pd.DataFrame) -> Tuple[str, str, float]:
        """Find the pair of assets with highest correlation"""
        mask = np.triu(np.ones_like(corr_matrix, dtype=bool), k=1)
        corr_values = corr_matrix.where(mask).stack()
        max_corr_idx = corr_values.idxmax()
        return (max_corr_idx[0], max_corr_idx[1], corr_values.max())
    
    def _find_lowest_correlation_pair(self, corr_matrix: pd.DataFrame) -> Tuple[str, str, float]:
        """Find the pair of assets with lowest correlation"""
        mask = np.triu(np.ones_like(corr_matrix, dtype=bool), k=1)
        corr_values = corr_matrix.where(mask).stack()
        min_corr_idx = corr_values.idxmin()
        return (min_corr_idx[0], min_corr_idx[1], corr_values.min())
