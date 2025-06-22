"""
Helper Functions - Utility functions for CCYOE analytics

Contains commonly used helper functions for data validation, 
business day calculations, formatting, and other utilities.
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Union, List, Optional, Dict, Any
import warnings
import re

from .constants import BRAZILIAN_HOLIDAYS, BUSINESS_DAYS_PER_YEAR


def calculate_business_days(
    start_date: Union[str, datetime], 
    end_date: Union[str, datetime],
    country: str = 'brazil'
) -> int:
    """
    Calculate number of business days between two dates
    
    Args:
        start_date: Start date (string or datetime)
        end_date: End date (string or datetime)
        country: Country for holiday calendar (default: 'brazil')
        
    Returns:
        Number of business days
    """
    # Convert to datetime if strings
    if isinstance(start_date, str):
        start_date = pd.to_datetime(start_date)
    if isinstance(end_date, str):
        end_date = pd.to_datetime(end_date)
    
    # Get business day range
    business_days = pd.bdate_range(start=start_date, end=end_date)
    
    # Remove country-specific holidays
    if country.lower() == 'brazil':
        holidays = [pd.to_datetime(date) for date in BRAZILIAN_HOLIDAYS]
        business_days = business_days.difference(holidays)
    
    return len(business_days)


def format_percentage(
    value: float, 
    decimals: int = 2,
    basis_points: bool = False
) -> str:
    """
    Format a decimal value as percentage
    
    Args:
        value: Decimal value to format
        decimals: Number of decimal places
        basis_points: If True, treat input as basis points
        
    Returns:
        Formatted percentage string
    """
    if pd.isna(value) or value is None:
        return 'N/A'
    
    if basis_points:
        percentage = value / 100  # Convert basis points to percentage
    else:
        percentage = value * 100  # Convert decimal to percentage
    
    return f"{percentage:.{decimals}f}%"


def format_currency(
    value: float,
    currency: str = 'USD',
    decimals: int = 2
) -> str:
    """
    Format a value as currency
    
    Args:
        value: Numeric value to format
        currency: Currency code ('USD', 'BRL', 'BTC')
        decimals: Number of decimal places
        
    Returns:
        Formatted currency string
    """
    if pd.isna(value) or value is None:
        return 'N/A'
    
    if currency == 'USD':
        return f"${value:,.{decimals}f}"
    elif currency == 'BRL':
        return f"R${value:,.{decimals}f}"
    elif currency == 'BTC':
        return f"₿{value:.{max(decimals, 6)}f}"
    else:
        return f"{value:,.{decimals}f} {currency}"


def validate_data(
    data: pd.DataFrame,
    required_columns: List[str],
    date_column: str = 'date',
    allow_missing: bool = True
) -> tuple[bool, List[str]]:
    """
    Validate input data for analytics functions
    
    Args:
        data: DataFrame to validate
        required_columns: List of required column names
        date_column: Name of date column to validate
        allow_missing: Whether to allow missing values
        
    Returns:
        Tuple of (is_valid, list_of_errors)
    """
    errors = []
    
    # Check if data is empty
    if data.empty:
        errors.append("Data is empty")
        return False, errors
    
    # Check required columns
    missing_columns = set(required_columns) - set(data.columns)
    if missing_columns:
        errors.append(f"Missing required columns: {list(missing_columns)}")
    
    # Validate date column
    if date_column in data.columns:
        try:
            pd.to_datetime(data[date_column])
        except Exception as e:
            errors.append(f"Invalid date format in column '{date_column}': {str(e)}")
    
    # Check for missing values if not allowed
    if not allow_missing:
        for col in required_columns:
            if col in data.columns and data[col].isna().any():
                errors.append(f"Missing values found in column '{col}'")
    
    # Check for reasonable yield values (0-100%)
    numeric_columns = data.select_dtypes(include=[np.number]).columns
    for col in numeric_columns:
        if col != date_column and col in required_columns:
            if (data[col] < 0).any():
                errors.append(f"Negative values found in column '{col}'")
            if (data[col] > 10000).any():  # 100% in basis points
                errors.append(f"Unreasonably high values found in column '{col}' (>100%)")
    
    return len(errors) == 0, errors


def annualize_return(
    return_value: float,
    periods: int,
    frequency: str = 'daily'
) -> float:
    """
    Annualize a return value
    
    Args:
        return_value: Return value to annualize
        periods: Number of periods in the return
        frequency: Frequency of the return ('daily', 'monthly', 'quarterly')
        
    Returns:
        Annualized return
    """
    if frequency == 'daily':
        periods_per_year = BUSINESS_DAYS_PER_YEAR
    elif frequency == 'monthly':
        periods_per_year = 12
    elif frequency == 'quarterly':
        periods_per_year = 4
    elif frequency == 'weekly':
        periods_per_year = 52
    else:
        raise ValueError(f"Unsupported frequency: {frequency}")
    
    scaling_factor = periods_per_year / periods
    return (1 + return_value) ** scaling_factor - 1


def deannualize_return(
    annual_return: float,
    periods: int,
    frequency: str = 'daily'
) -> float:
    """
    Convert annualized return to period return
    
    Args:
        annual_return: Annualized return
        periods: Number of periods to convert to
        frequency: Frequency of target periods
        
    Returns:
        Period return
    """
    if frequency == 'daily':
        periods_per_year = BUSINESS_DAYS_PER_YEAR
    elif frequency == 'monthly':
        periods_per_year = 12
    elif frequency == 'quarterly':
        periods_per_year = 4
    elif frequency == 'weekly':
        periods_per_year = 52
    else:
        raise ValueError(f"Unsupported frequency: {frequency}")
    
    scaling_factor = periods / periods_per_year
    return (1 + annual_return) ** scaling_factor - 1


def clean_numeric_column(
    series: pd.Series,
    method: str = 'forward_fill',
    outlier_threshold: float = 3.0
) -> pd.Series:
    """
    Clean numeric data by handling missing values and outliers
    
    Args:
        series: Pandas series to clean
        method: Method for handling missing values ('forward_fill', 'interpolate', 'drop')
        outlier_threshold: Z-score threshold for outlier detection
        
    Returns:
        Cleaned pandas series
    """
    cleaned_series = series.copy()
    
    # Handle missing values
    if method == 'forward_fill':
        cleaned_series = cleaned_series.fillna(method='ffill')
    elif method == 'interpolate':
        cleaned_series = cleaned_series.interpolate(method='linear')
    elif method == 'drop':
        cleaned_series = cleaned_series.dropna()
    
    # Handle outliers using z-score
    if outlier_threshold > 0:
        z_scores = np.abs((cleaned_series - cleaned_series.mean()) / cleaned_series.std())
        outlier_mask = z_scores > outlier_threshold
        
        if outlier_mask.any():
            warnings.warn(f"Found {outlier_mask.sum()} outliers in data")
            # Replace outliers with median
            cleaned_series.loc[outlier_mask] = cleaned_series.median()
    
    return cleaned_series


def calculate_rolling_correlation(
    series1: pd.Series,
    series2: pd.Series,
    window: int = 30,
    min_periods: int = 20
) -> pd.Series:
    """
    Calculate rolling correlation between two series
    
    Args:
        series1: First time series
        series2: Second time series
        window: Rolling window size
        min_periods: Minimum periods required for calculation
        
    Returns:
        Rolling correlation series
    """
    return series1.rolling(window=window, min_periods=min_periods).corr(series2)


def resample_data(
    data: pd.DataFrame,
    date_column: str = 'date',
    frequency: str = 'D',
    aggregation: Dict[str, str] = None
) -> pd.DataFrame:
    """
    Resample time series data to different frequency
    
    Args:
        data: DataFrame with time series data
        date_column: Name of date column
        frequency: Target frequency ('D', 'W', 'M', 'Q', 'Y')
        aggregation: Dictionary mapping columns to aggregation methods
        
    Returns:
        Resampled DataFrame
    """
    data = data.copy()
    data[date_column] = pd.to_datetime(data[date_column])
    data = data.set_index(date_column)
    
    if aggregation is None:
        # Default aggregation for numeric columns
        aggregation = {col: 'mean' for col in data.select_dtypes(include=[np.number]).columns}
    
    return data.resample(frequency).agg(aggregation).reset_index()


def calculate_compound_return(
    returns: pd.Series,
    frequency: str = 'daily'
) -> float:
    """
    Calculate compound return from a series of period returns
    
    Args:
        returns: Series of period returns
        frequency: Frequency of returns
        
    Returns:
        Compound return
    """
    return (1 + returns).prod() - 1


def basis_points_to_decimal(bp: float) -> float:
    """Convert basis points to decimal"""
    return bp / 10000


def decimal_to_basis_points(decimal: float) -> float:
    """Convert decimal to basis points"""
    return decimal * 10000


def validate_asset_weights(weights: Dict[str, float], tolerance: float = 1e-6) -> bool:
    """
    Validate that asset weights sum to 1.0
    
    Args:
        weights: Dictionary of asset weights
        tolerance: Tolerance for sum check
        
    Returns:
        True if weights are valid
    """
    total_weight = sum(weights.values())
    return abs(total_weight - 1.0) <= tolerance


def generate_date_range(
    start_date: Union[str, datetime],
    end_date: Union[str, datetime],
    frequency: str = 'D',
    business_days_only: bool = True
) -> pd.DatetimeIndex:
    """
    Generate date range with specified frequency
    
    Args:
        start_date: Start date
        end_date: End date
        frequency: Date frequency ('D', 'B', 'W', 'M')
        business_days_only: Whether to include only business days
        
    Returns:
        DatetimeIndex with date range
    """
    if business_days_only and frequency == 'D':
        return pd.bdate_range(start=start_date, end=end_date)
    else:
        return pd.date_range(start=start_date, end=end_date, freq=frequency)


def safe_divide(numerator: float, denominator: float, default: float = 0.0) -> float:
    """
    Safely divide two numbers, returning default if denominator is zero
    
    Args:
        numerator: Numerator value
        denominator: Denominator value
        default: Default value if division by zero
        
    Returns:
        Division result or default value
    """
    if denominator == 0 or pd.isna(denominator):
        return default
    return numerator / denominator


def normalize_column_names(columns: List[str]) -> List[str]:
    """
    Normalize column names by removing special characters and converting to lowercase
    
    Args:
        columns: List of column names to normalize
        
    Returns:
        List of normalized column names
    """
    normalized = []
    for col in columns:
        # Convert to lowercase and replace special characters with underscores
        normalized_col = re.sub(r'[^a-zA-Z0-9]', '_', col.lower())
        # Remove multiple underscores
        normalized_col = re.sub(r'_+', '_', normalized_col)
        # Remove leading/trailing underscores
        normalized_col = normalized_col.strip('_')
        normalized.append(normalized_col)
    return normalized


def calculate_sharpe_ratio(
    returns: pd.Series,
    risk_free_rate: float = 0.0,
    periods_per_year: int = 252
) -> float:
    """
    Calculate Sharpe ratio for a return series
    
    Args:
        returns: Series of period returns
        risk_free_rate: Risk-free rate (annualized)
        periods_per_year: Number of periods per year for annualization
        
    Returns:
        Sharpe ratio
    """
    if len(returns) == 0 or returns.std() == 0:
        return 0.0
    
    # Calculate excess returns
    period_risk_free_rate = risk_free_rate / periods_per_year
    excess_returns = returns - period_risk_free_rate
    
    # Calculate annualized Sharpe ratio
    return (excess_returns.mean() * periods_per_year) / (excess_returns.std() * np.sqrt(periods_per_year))


def calculate_max_drawdown(returns: pd.Series) -> float:
    """
    Calculate maximum drawdown from a return series
    
    Args:
        returns: Series of period returns
        
    Returns:
        Maximum drawdown (positive value)
    """
    if len(returns) == 0:
        return 0.0
    
    # Calculate cumulative returns
    cumulative = (1 + returns).cumprod()
    
    # Calculate running maximum
    running_max = cumulative.expanding().max()
    
    # Calculate drawdown
    drawdown = (cumulative - running_max) / running_max
    
    return abs(drawdown.min())


def load_sample_data(
    asset: str = 'cmBRL',
    start_date: str = '2023-01-01',
    end_date: str = '2024-01-01'
) -> pd.DataFrame:
    """
    Generate sample yield data for testing and demonstration
    
    Args:
        asset: Asset to generate data for
        start_date: Start date for data generation
        end_date: End date for data generation
        
    Returns:
        DataFrame with sample yield data
    """
    # Generate date range
    dates = pd.date_range(start=start_date, end=end_date, freq='D')
    
    # Generate realistic yield data based on asset type
    if asset == 'cmBRL':
        base_yield = 2200  # 22% base yield
        volatility = 200   # 2% daily volatility
    elif asset == 'cmUSD':
        base_yield = 1400  # 14% base yield
        volatility = 100   # 1% daily volatility
    elif asset == 'cmBTC':
        base_yield = 500   # 5% base yield
        volatility = 300   # 3% daily volatility
    else:
        base_yield = 1000  # 10% default
        volatility = 150   # 1.5% default volatility
    
    # Generate random walk with mean reversion
    np.random.seed(42)  # For reproducible results
    yields = []
    current_yield = base_yield
    
    for _ in dates:
        # Mean reversion factor
        mean_reversion = 0.05 * (base_yield - current_yield)
        # Random shock
        shock = np.random.normal(0, volatility)
        # Update yield
        current_yield += mean_reversion + shock
        yields.append(max(0, current_yield))  # Ensure non-negative yields
    
    return pd.DataFrame({
        'date': dates,
        asset: yields
    })


def create_multi_asset_sample_data(
    start_date: str = '2023-01-01',
    end_date: str = '2024-01-01',
    correlation_matrix: Optional[np.ndarray] = None
) -> pd.DataFrame:
    """
    Create correlated sample data for multiple assets
    
    Args:
        start_date: Start date for data generation
        end_date: End date for data generation
        correlation_matrix: 3x3 correlation matrix for assets
        
    Returns:
        DataFrame with multi-asset yield data
    """
    if correlation_matrix is None:
        # Default correlation matrix
        correlation_matrix = np.array([
            [1.0, 0.3, 0.1],   # cmBTC correlations
            [0.3, 1.0, 0.4],   # cmUSD correlations
            [0.1, 0.4, 1.0]    # cmBRL correlations
        ])
    
    # Generate date range
    dates = pd.date_range(start=start_date, end=end_date, freq='D')
    n_days = len(dates)
    
    # Asset parameters
    base_yields = {'cmBTC': 500, 'cmUSD': 1400, 'cmBRL': 2200}
    volatilities = {'cmBTC': 300, 'cmUSD': 100, 'cmBRL': 200}
    
    # Generate correlated random shocks
    np.random.seed(42)
    
    # Generate independent normal variables
    independent_shocks = np.random.multivariate_normal(
        mean=[0, 0, 0],
        cov=correlation_matrix,
        size=n_days
    )
    
    # Scale shocks by asset volatilities
    assets = ['cmBTC', 'cmUSD', 'cmBRL']
    data = {'date': dates}
    
    for i, asset in enumerate(assets):
        yields = []
        current_yield = base_yields[asset]
        
        for day in range(n_days):
            # Mean reversion
            mean_reversion = 0.05 * (base_yields[asset] - current_yield)
            # Correlated shock
            shock = independent_shocks[day, i] * volatilities[asset]
            # Update yield
            current_yield += mean_reversion + shock
            yields.append(max(0, current_yield))
        
        data[asset] = yields
    
    return pd.DataFrame(data)
