"""
Data Processors - Process and validate financial data for CCYOE analytics

Provides data processing capabilities for:
- Yield data cleaning and preprocessing
- Data validation and quality checks
- Time series alignment and resampling
- Missing data handling
- Outlier detection and treatment
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, Union
import warnings
from datetime import datetime, timedelta
from scipy import stats

from ..utils.helpers import clean_numeric_column, validate_data, resample_data
from ..utils.constants import ASSET_CONFIG, BRAZILIAN_HOLIDAYS


class YieldProcessor:
    """
    Process yield data for CCYOE analytics
    
    Handles cleaning, transformation, and preparation of yield data
    for analysis and backtesting.
    """
    
    def __init__(self):
        self.processing_log = []
    
    def process_yield_data(
        self,
        data: pd.DataFrame,
        date_column: str = 'date',
        yield_columns: Optional[List[str]] = None,
        target_frequency: str = 'D',
        handle_missing: str = 'interpolate',
        handle_outliers: str = 'cap',
        outlier_threshold: float = 3.0
    ) -> pd.DataFrame:
        """
        Comprehensive yield data processing
        
        Args:
            data: Raw yield data DataFrame
            date_column: Name of date column
            yield_columns: List of yield column names (if None, infer)
            target_frequency: Target frequency ('D', 'B', 'W', 'M')
            handle_missing: Missing data strategy ('interpolate', 'forward_fill', 'drop')
            handle_outliers: Outlier handling ('cap', 'remove', 'none')
            outlier_threshold: Z-score threshold for outlier detection
            
        Returns:
            Processed DataFrame
        """
        processed_data = data.copy()
        self.processing_log = []
        
        # 1. Validate input data
        self._log("Starting yield data processing")
        is_valid, errors = validate_data(processed_data, [date_column], date_column)
        if not is_valid:
            raise ValueError(f"Data validation failed: {errors}")
        
        # 2. Ensure date column is datetime and sorted
        processed_data[date_column] = pd.to_datetime(processed_data[date_column])
        processed_data = processed_data.sort_values(date_column).reset_index(drop=True)
        self._log(f"Sorted data by {date_column}")
        
        # 3. Infer yield columns if not provided
        if yield_columns is None:
            yield_columns = [col for col in processed_data.columns 
                           if col != date_column and processed_data[col].dtype in ['int64', 'float64']]
        
        self._log(f"Processing yield columns: {yield_columns}")
        
        # 4. Convert yields to basis points if needed
        processed_data = self._standardize_yield_units(processed_data, yield_columns)
        
        # 5. Handle missing values
        if handle_missing != 'none':
            processed_data = self._handle_missing_values(
                processed_data, yield_columns, handle_missing
            )
        
        # 6. Handle outliers
        if handle_outliers != 'none':
            processed_data = self._handle_outliers(
                processed_data, yield_columns, handle_outliers, outlier_threshold
            )
        
        # 7. Resample to target frequency
        if target_frequency != 'raw':
            processed_data = self._resample_data(
                processed_data, date_column, target_frequency, yield_columns
            )
        
        # 8. Final validation
        processed_data = self._final_validation(processed_data, yield_columns)
        
        self._log("Yield data processing completed")
        return processed_data
    
    def align_time_series(
        self,
        dataframes: List[pd.DataFrame],
        date_column: str = 'date',
        how: str = 'outer'
    ) -> pd.DataFrame:
        """
        Align multiple time series on common dates
        
        Args:
            dataframes: List of DataFrames to align
            date_column: Name of date column
            how: Join method ('inner', 'outer', 'left', 'right')
            
        Returns:
            Aligned DataFrame
        """
        if not dataframes:
            return pd.DataFrame()
        
        if len(dataframes) == 1:
            return dataframes[0].copy()
        
        # Start with first DataFrame
        result = dataframes[0].copy()
        
        # Merge with remaining DataFrames
        for df in dataframes[1:]:
            result = pd.merge(result, df, on=date_column, how=how, suffixes=('', '_dup'))
            
            # Remove duplicate columns
            dup_cols = [col for col in result.columns if col.endswith('_dup')]
            result = result.drop(columns=dup_cols)
        
        return result.sort_values(date_column).reset_index(drop=True)
    
    def calculate_yield_spreads(
        self,
        data: pd.DataFrame,
        base_rate_column: str,
        asset_columns: List[str]
    ) -> pd.DataFrame:
        """
        Calculate yield spreads over base rate
        
        Args:
            data: DataFrame with yield data
            base_rate_column: Column name for base rate (e.g., 'SELIC')
            asset_columns: List of asset yield columns
            
        Returns:
            DataFrame with spread columns added
        """
        result = data.copy()
        
        if base_rate_column not in data.columns:
            warnings.warn(f"Base rate column {base_rate_column} not found")
            return result
        
        for asset in asset_columns:
            if asset in data.columns:
                spread_column = f"{asset}_spread"
                result[spread_column] = result[asset] - result[base_rate_column]
                self._log(f"Calculated spread for {asset}")
        
        return result
    
    def calculate_excess_yields(
        self,
        data: pd.DataFrame,
        target_yields: Optional[Dict[str, float]] = None
    ) -> pd.DataFrame:
        """
        Calculate excess yields above targets
        
        Args:
            data: DataFrame with yield data
            target_yields: Dict mapping assets to target yields
            
        Returns:
            DataFrame with excess yield columns
        """
        result = data.copy()
        
        if target_yields is None:
            target_yields = {asset: config['target_yield'] 
                           for asset, config in ASSET_CONFIG.items()}
        
        for asset, target in target_yields.items():
            if asset in data.columns:
                excess_column = f"{asset}_excess"
                result[excess_column] = np.maximum(0, result[asset] - target)
                self._log(f"Calculated excess yield for {asset}")
        
        return result
    
    def smooth_yield_series(
        self,
        data: pd.DataFrame,
        yield_columns: List[str],
        method: str = 'rolling',
        window: int = 5,
        **kwargs
    ) -> pd.DataFrame:
        """
        Smooth yield time series to reduce noise
        
        Args:
            data: DataFrame with yield data
            yield_columns: List of yield columns to smooth
            method: Smoothing method ('rolling', 'ewm', 'lowess')
            window: Window size for smoothing
            **kwargs: Additional arguments for smoothing method
            
        Returns:
            DataFrame with smoothed yields
        """
        result = data.copy()
        
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            original_col = f"{col}_original"
            result[original_col] = result[col]
            
            if method == 'rolling':
                result[col] = result[col].rolling(window=window, **kwargs).mean()
            elif method == 'ewm':
                result[col] = result[col].ewm(span=window, **kwargs).mean()
            elif method == 'lowess':
                try:
                    from statsmodels.nonparametric.smoothers_lowess import lowess
                    smoothed = lowess(result[col].dropna(), range(len(result[col].dropna())), 
                                    frac=window/len(result), **kwargs)
                    result[col] = pd.Series(smoothed[:, 1], index=result[col].dropna().index)
                except ImportError:
                    warnings.warn("LOWESS smoothing requires statsmodels")
                    continue
            
            self._log(f"Smoothed {col} using {method}")
        
        return result
    
    def _standardize_yield_units(self, data: pd.DataFrame, yield_columns: List[str]) -> pd.DataFrame:
        """Convert yields to basis points if needed"""
        result = data.copy()
        
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            # Check if yields are in decimal form (values between 0 and 1)
            max_val = result[col].max()
            if max_val <= 1.0:
                result[col] = result[col] * 10000  # Convert to basis points
                self._log(f"Converted {col} from decimal to basis points")
            elif max_val <= 100:
                result[col] = result[col] * 100  # Convert from percentage to basis points
                self._log(f"Converted {col} from percentage to basis points")
        
        return result
    
    def _handle_missing_values(
        self, 
        data: pd.DataFrame, 
        yield_columns: List[str], 
        method: str
    ) -> pd.DataFrame:
        """Handle missing values in yield data"""
        result = data.copy()
        
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            missing_count = result[col].isna().sum()
            if missing_count == 0:
                continue
            
            if method == 'interpolate':
                result[col] = result[col].interpolate(method='linear')
            elif method == 'forward_fill':
                result[col] = result[col].fillna(method='ffill')
            elif method == 'backward_fill':
                result[col] = result[col].fillna(method='bfill')
            elif method == 'drop':
                result = result.dropna(subset=[col])
            
            self._log(f"Handled {missing_count} missing values in {col} using {method}")
        
        return result
    
    def _handle_outliers(
        self, 
        data: pd.DataFrame, 
        yield_columns: List[str], 
        method: str, 
        threshold: float
    ) -> pd.DataFrame:
        """Handle outliers in yield data"""
        result = data.copy()
        
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            # Detect outliers using z-score
            z_scores = np.abs(stats.zscore(result[col].dropna()))
            outlier_mask = z_scores > threshold
            outlier_count = outlier_mask.sum()
            
            if outlier_count == 0:
                continue
            
            if method == 'cap':
                # Cap outliers at threshold percentiles
                lower_bound = result[col].quantile(0.01)
                upper_bound = result[col].quantile(0.99)
                result[col] = result[col].clip(lower_bound, upper_bound)
            elif method == 'remove':
                # Remove outlier rows
                outlier_indices = result[col].dropna().index[outlier_mask]
                result = result.drop(outlier_indices)
            elif method == 'winsorize':
                # Winsorize at 1st and 99th percentiles
                from scipy.stats import mstats
                result[col] = mstats.winsorize(result[col], limits=[0.01, 0.01])
            
            self._log(f"Handled {outlier_count} outliers in {col} using {method}")
        
        return result
    
    def _resample_data(
        self, 
        data: pd.DataFrame, 
        date_column: str, 
        frequency: str, 
        yield_columns: List[str]
    ) -> pd.DataFrame:
        """Resample data to target frequency"""
        aggregation = {col: 'mean' for col in yield_columns}
        resampled = resample_data(data, date_column, frequency, aggregation)
        self._log(f"Resampled data to {frequency} frequency")
        return resampled
    
    def _final_validation(self, data: pd.DataFrame, yield_columns: List[str]) -> pd.DataFrame:
        """Final validation and cleanup"""
        result = data.copy()
        
        # Remove any remaining infinite values
        result = result.replace([np.inf, -np.inf], np.nan)
        
        # Ensure yields are non-negative
        for col in yield_columns:
            if col in result.columns:
                negative_count = (result[col] < 0).sum()
                if negative_count > 0:
                    result[col] = result[col].clip(lower=0)
                    self._log(f"Clipped {negative_count} negative values in {col}")
        
        return result
    
    def _log(self, message: str):
        """Add message to processing log"""
        self.processing_log.append(f"{datetime.now().strftime('%H:%M:%S')}: {message}")
    
    def get_processing_log(self) -> List[str]:
        """Get processing log"""
        return self.processing_log.copy()


class DataValidator:
    """
    Validate financial data quality and integrity
    
    Provides comprehensive validation checks for yield data including:
    - Data completeness checks
    - Range validation
    - Consistency checks
    - Outlier detection
    - Time series validation
    """
    
    def __init__(self):
        self.validation_results = {}
    
    def validate_yield_data(
        self,
        data: pd.DataFrame,
        date_column: str = 'date',
        yield_columns: Optional[List[str]] = None,
        expected_frequency: str = 'D',
        yield_ranges: Optional[Dict[str, Tuple[float, float]]] = None
    ) -> Dict[str, Union[bool, List[str], Dict]]:
        """
        Comprehensive yield data validation
        
        Args:
            data: DataFrame to validate
            date_column: Name of date column
            yield_columns: List of yield columns (if None, infer)
            expected_frequency: Expected data frequency
            yield_ranges: Expected ranges for each yield column
            
        Returns:
            Dict with validation results
        """
        self.validation_results = {
            'is_valid': True,
            'errors': [],
            'warnings': [],
            'statistics': {}
        }
        
        # Basic data validation
        self._validate_basic_structure(data, date_column, yield_columns)
        
        # Infer yield columns if not provided
        if yield_columns is None:
            yield_columns = [col for col in data.columns 
                           if col != date_column and data[col].dtype in ['int64', 'float64']]
        
        # Date validation
        self._validate_dates(data, date_column, expected_frequency)
        
        # Yield data validation
        self._validate_yields(data, yield_columns, yield_ranges)
        
        # Time series validation
        self._validate_time_series(data, date_column, yield_columns)
        
        # Calculate summary statistics
        self._calculate_validation_statistics(data, yield_columns)
        
        return self.validation_results
    
    def validate_data_completeness(
        self,
        data: pd.DataFrame,
        required_columns: List[str],
        min_observations: int = 100
    ) -> Dict[str, Union[bool, str]]:
        """
        Validate data completeness
        
        Args:
            data: DataFrame to validate
            required_columns: List of required columns
            min_observations: Minimum number of observations required
            
        Returns:
            Dict with completeness validation results
        """
        results = {'is_complete': True, 'issues': []}
        
        # Check required columns
        missing_columns = set(required_columns) - set(data.columns)
        if missing_columns:
            results['is_complete'] = False
            results['issues'].append(f"Missing columns: {list(missing_columns)}")
        
        # Check minimum observations
        if len(data) < min_observations:
            results['is_complete'] = False
            results['issues'].append(f"Insufficient data: {len(data)} < {min_observations}")
        
        # Check missing values percentage
        for col in required_columns:
            if col in data.columns:
                missing_pct = data[col].isna().mean() * 100
                if missing_pct > 20:  # More than 20% missing
                    results['is_complete'] = False
                    results['issues'].append(f"High missing values in {col}: {missing_pct:.1f}%")
        
        return results
    
    def validate_yield_ranges(
        self,
        data: pd.DataFrame,
        yield_columns: List[str],
        expected_ranges: Optional[Dict[str, Tuple[float, float]]] = None
    ) -> Dict[str, Dict]:
        """
        Validate yield values are within expected ranges
        
        Args:
            data: DataFrame with yield data
            yield_columns: List of yield columns
            expected_ranges: Dict mapping columns to (min, max) ranges
            
        Returns:
            Dict with range validation results
        """
        results = {}
        
        if expected_ranges is None:
            # Use default ranges from asset config
            expected_ranges = {}
            for asset in yield_columns:
                if asset in ASSET_CONFIG:
                    target = ASSET_CONFIG[asset]['target_yield']
                    expected_ranges[asset] = (target * 0.3, target * 3.0)  # 70% below to 200% above target
                else:
                    expected_ranges[asset] = (0, 5000)  # 0% to 50% default range
        
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            col_results = {'is_valid': True, 'issues': []}
            
            if col in expected_ranges:
                min_val, max_val = expected_ranges[col]
                
                # Check for values outside range
                below_min = data[col] < min_val
                above_max = data[col] > max_val
                
                if below_min.any():
                    count = below_min.sum()
                    col_results['is_valid'] = False
                    col_results['issues'].append(f"{count} values below minimum {min_val}")
                
                if above_max.any():
                    count = above_max.sum()
                    col_results['is_valid'] = False
                    col_results['issues'].append(f"{count} values above maximum {max_val}")
            
            results[col] = col_results
        
        return results
    
    def detect_data_anomalies(
        self,
        data: pd.DataFrame,
        yield_columns: List[str],
        detection_methods: List[str] = ['zscore', 'iqr', 'isolation_forest']
    ) -> Dict[str, Dict]:
        """
        Detect anomalies in yield data using multiple methods
        
        Args:
            data: DataFrame with yield data
            yield_columns: List of yield columns
            detection_methods: List of anomaly detection methods
            
        Returns:
            Dict with anomaly detection results
        """
        results = {}
        
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            col_data = data[col].dropna()
            if len(col_data) < 10:
                continue
            
            col_results = {'anomalies': {}, 'total_anomalies': 0}
            
            # Z-score method
            if 'zscore' in detection_methods:
                z_scores = np.abs(stats.zscore(col_data))
                anomalies = z_scores > 3
                col_results['anomalies']['zscore'] = anomalies.sum()
            
            # IQR method
            if 'iqr' in detection_methods:
                Q1 = col_data.quantile(0.25)
                Q3 = col_data.quantile(0.75)
                IQR = Q3 - Q1
                lower_bound = Q1 - 1.5 * IQR
                upper_bound = Q3 + 1.5 * IQR
                anomalies = (col_data < lower_bound) | (col_data > upper_bound)
                col_results['anomalies']['iqr'] = anomalies.sum()
            
            # Isolation Forest method
            if 'isolation_forest' in detection_methods:
                try:
                    from sklearn.ensemble import IsolationForest
                    isolation_forest = IsolationForest(contamination=0.1, random_state=42)
                    anomalies = isolation_forest.fit_predict(col_data.values.reshape(-1, 1)) == -1
                    col_results['anomalies']['isolation_forest'] = anomalies.sum()
                except ImportError:
                    warnings.warn("Isolation Forest requires scikit-learn")
            
            col_results['total_anomalies'] = sum(col_results['anomalies'].values())
            results[col] = col_results
        
        return results
    
    def _validate_basic_structure(self, data: pd.DataFrame, date_column: str, yield_columns: Optional[List[str]]):
        """Validate basic data structure"""
        if data.empty:
            self._add_error("Data is empty")
            return
        
        if date_column not in data.columns:
            self._add_error(f"Date column '{date_column}' not found")
        
        if yield_columns:
            missing_yield_cols = set(yield_columns) - set(data.columns)
            if missing_yield_cols:
                self._add_error(f"Missing yield columns: {list(missing_yield_cols)}")
    
    def _validate_dates(self, data: pd.DataFrame, date_column: str, expected_frequency: str):
        """Validate date column and frequency"""
        if date_column not in data.columns:
            return
        
        try:
            dates = pd.to_datetime(data[date_column])
        except Exception as e:
            self._add_error(f"Invalid date format: {e}")
            return
        
        # Check for duplicates
        if dates.duplicated().any():
            self._add_warning(f"Found {dates.duplicated().sum()} duplicate dates")
        
        # Check date ordering
        if not dates.is_monotonic_increasing:
            self._add_warning("Dates are not in chronological order")
        
        # Check frequency consistency
        if len(dates) > 1:
            date_diffs = dates.diff().dropna()
            if expected_frequency == 'D':
                expected_diff = pd.Timedelta(days=1)
            elif expected_frequency == 'B':
                expected_diff = pd.Timedelta(days=1)  # Business days vary
            elif expected_frequency == 'W':
                expected_diff = pd.Timedelta(weeks=1)
            elif expected_frequency == 'M':
                expected_diff = pd.Timedelta(days=30)  # Approximate
            else:
                return
            
            # Allow some tolerance for business days and holidays
            tolerance = pd.Timedelta(days=3)
            irregular_gaps = date_diffs[np.abs(date_diffs - expected_diff) > tolerance]
            
            if len(irregular_gaps) > len(dates) * 0.1:  # More than 10% irregular
                self._add_warning(f"Irregular date frequency detected: {len(irregular_gaps)} gaps")
    
    def _validate_yields(self, data: pd.DataFrame, yield_columns: List[str], yield_ranges: Optional[Dict]):
        """Validate yield values"""
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            col_data = data[col]
            
            # Check for negative yields
            if (col_data < 0).any():
                negative_count = (col_data < 0).sum()
                self._add_warning(f"Found {negative_count} negative yields in {col}")
            
            # Check for extreme values
            if col_data.max() > 10000:  # More than 100%
                self._add_warning(f"Extremely high yields detected in {col}: max = {col_data.max()}")
            
            # Check yield ranges if provided
            if yield_ranges and col in yield_ranges:
                min_yield, max_yield = yield_ranges[col]
                out_of_range = (col_data < min_yield) | (col_data > max_yield)
                if out_of_range.any():
                    self._add_warning(f"Values outside expected range in {col}: {out_of_range.sum()} observations")
    
    def _validate_time_series(self, data: pd.DataFrame, date_column: str, yield_columns: List[str]):
        """Validate time series properties"""
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            col_data = data[col].dropna()
            
            # Check for constant values
            if col_data.nunique() == 1:
                self._add_warning(f"Column {col} has constant values")
            
            # Check for high autocorrelation (might indicate stale data)
            if len(col_data) > 10:
                autocorr = col_data.autocorr()
                if autocorr > 0.95:
                    self._add_warning(f"Very high autocorrelation in {col}: {autocorr:.3f}")
    
    def _calculate_validation_statistics(self, data: pd.DataFrame, yield_columns: List[str]):
        """Calculate summary statistics for validation"""
        stats = {}
        
        for col in yield_columns:
            if col not in data.columns:
                continue
            
            col_data = data[col].dropna()
            
            stats[col] = {
                'count': len(col_data),
                'missing': data[col].isna().sum(),
                'mean': col_data.mean(),
                'std': col_data.std(),
                'min': col_data.min(),
                'max': col_data.max(),
                'median': col_data.median(),
                'skewness': stats.skew(col_data) if len(col_data) > 2 else np.nan,
                'kurtosis': stats.kurtosis(col_data) if len(col_data) > 3 else np.nan
            }
        
        self.validation_results['statistics'] = stats
    
    def _add_error(self, message: str):
        """Add error to validation results"""
        self.validation_results['is_valid'] = False
        self.validation_results['errors'].append(message)
    
    def _add_warning(self, message: str):
        """Add warning to validation results"""
        self.validation_results['warnings'].append(message)
