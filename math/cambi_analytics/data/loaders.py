"""
Data Loaders - Load data from various Brazilian financial data sources

Provides data loading capabilities for:
- Brazilian Central Bank (BACEN) data
- B3 stock exchange data  
- Liqi tokenized assets
- Bank rates and economic indicators
- External APIs and file sources
"""

import pandas as pd
import numpy as np
import requests
from typing import Dict, List, Optional, Union, Tuple
from datetime import datetime, timedelta
import warnings
import time
from abc import ABC, abstractmethod
import os
from pathlib import Path

from ..utils.constants import DATA_SOURCES, ECONOMIC_INDICATORS, BRAZILIAN_HOLIDAYS
from ..utils.helpers import validate_data, clean_numeric_column, create_multi_asset_sample_data


class BaseDataLoader(ABC):
    """Base class for all data loaders"""
    
    def __init__(self, cache_dir: Optional[str] = None):
        """
        Initialize base data loader
        
        Args:
            cache_dir: Directory for caching downloaded data
        """
        self.cache_dir = Path(cache_dir) if cache_dir else Path.home() / '.cambi_analytics' / 'cache'
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
        # Rate limiting
        self.last_request_time = {}
        self.rate_limits = {}
    
    @abstractmethod
    def load_data(self, **kwargs) -> pd.DataFrame:
        """Load data - must be implemented by subclasses"""
        pass
    
    def _rate_limit(self, source: str, requests_per_minute: int = 60):
        """Implement rate limiting for API calls"""
        if source not in self.last_request_time:
            self.last_request_time[source] = 0
        
        time_since_last = time.time() - self.last_request_time[source]
        min_interval = 60.0 / requests_per_minute
        
        if time_since_last < min_interval:
            sleep_time = min_interval - time_since_last
            time.sleep(sleep_time)
        
        self.last_request_time[source] = time.time()
    
    def _get_cache_path(self, filename: str) -> Path:
        """Get cache file path"""
        return self.cache_dir / filename
    
    def _load_from_cache(self, cache_key: str, max_age_hours: int = 24) -> Optional[pd.DataFrame]:
        """Load data from cache if available and fresh"""
        cache_path = self._get_cache_path(f"{cache_key}.parquet")
        
        if cache_path.exists():
            # Check age
            file_age = time.time() - cache_path.stat().st_mtime
            if file_age < max_age_hours * 3600:
                try:
                    return pd.read_parquet(cache_path)
                except Exception as e:
                    warnings.warn(f"Failed to load cache file {cache_path}: {e}")
        
        return None
    
    def _save_to_cache(self, data: pd.DataFrame, cache_key: str):
        """Save data to cache"""
        cache_path = self._get_cache_path(f"{cache_key}.parquet")
        try:
            data.to_parquet(cache_path, index=False)
        except Exception as e:
            warnings.warn(f"Failed to save cache file {cache_path}: {e}")


class BacenDataLoader(BaseDataLoader):
    """Load data from Brazilian Central Bank (BACEN) API"""
    
    def __init__(self, cache_dir: Optional[str] = None):
        super().__init__(cache_dir)
        self.base_url = DATA_SOURCES['bacen']['base_url']
        self.rate_limit_rpm = DATA_SOURCES['bacen']['rate_limit']
    
    def load_economic_indicator(
        self, 
        indicator: str,
        start_date: str,
        end_date: str,
        use_cache: bool = True
    ) -> pd.DataFrame:
        """
        Load economic indicator from BACEN
        
        Args:
            indicator: Indicator code ('SELIC', 'IPCA', 'CDI', etc.)
            start_date: Start date (YYYY-MM-DD)
            end_date: End date (YYYY-MM-DD)
            use_cache: Whether to use cached data
            
        Returns:
            DataFrame with indicator data
        """
        if indicator not in ECONOMIC_INDICATORS:
            raise ValueError(f"Unknown indicator: {indicator}")
        
        series_id = ECONOMIC_INDICATORS[indicator]['series_id']
        
        # Check cache first
        cache_key = f"bacen_{indicator}_{start_date}_{end_date}"
        if use_cache:
            cached_data = self._load_from_cache(cache_key)
            if cached_data is not None:
                return cached_data
        
        # Format dates for BACEN API
        start_formatted = start_date.replace('-', '')
        end_formatted = end_date.replace('-', '')
        
        # Make API request
        url = f"{self.base_url}/{series_id}/dados"
        params = {
            'formato': 'json',
            'dataInicial': start_formatted,
            'dataFinal': end_formatted
        }
        
        self._rate_limit('bacen', self.rate_limit_rpm)
        
        try:
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            if not data:
                warnings.warn(f"No data returned for indicator {indicator}")
                return pd.DataFrame()
            
            # Convert to DataFrame
            df = pd.DataFrame(data)
            df['date'] = pd.to_datetime(df['data'], format='%d/%m/%Y')
            df[indicator] = pd.to_numeric(df['valor'], errors='coerce')
            df = df[['date', indicator]].dropna()
            
            # Save to cache
            if use_cache:
                self._save_to_cache(df, cache_key)
            
            return df
            
        except Exception as e:
            warnings.warn(f"Failed to load {indicator} from BACEN: {e}")
            return pd.DataFrame()
    
    def load_data(
        self, 
        indicators: List[str],
        start_date: str,
        end_date: str,
        **kwargs
    ) -> pd.DataFrame:
        """Load multiple indicators and merge"""
        dfs = []
        
        for indicator in indicators:
            df = self.load_economic_indicator(indicator, start_date, end_date, **kwargs)
            if not df.empty:
                dfs.append(df)
        
        if not dfs:
            return pd.DataFrame()
        
        # Merge all indicators
        result = dfs[0]
        for df in dfs[1:]:
            result = pd.merge(result, df, on='date', how='outer')
        
        return result.sort_values('date').reset_index(drop=True)


class LiqiDataLoader(BaseDataLoader):
    """Load data from Liqi tokenized assets platform"""
    
    def __init__(self, api_key: str, cache_dir: Optional[str] = None):
        super().__init__(cache_dir)
        self.api_key = api_key
        self.base_url = DATA_SOURCES['liqi']['base_url']
        self.rate_limit_rpm = DATA_SOURCES['liqi']['rate_limit']
        
        self.headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
    
    def load_receivables_data(
        self,
        start_date: str,
        end_date: str,
        asset_type: str = 'all',
        use_cache: bool = True
    ) -> pd.DataFrame:
        """
        Load receivables data from Liqi
        
        Args:
            start_date: Start date (YYYY-MM-DD)
            end_date: End date (YYYY-MM-DD)
            asset_type: Type of receivables ('brl', 'usd', 'all')
            use_cache: Whether to use cached data
            
        Returns:
            DataFrame with receivables yield data
        """
        cache_key = f"liqi_receivables_{asset_type}_{start_date}_{end_date}"
        if use_cache:
            cached_data = self._load_from_cache(cache_key)
            if cached_data is not None:
                return cached_data
        
        self._rate_limit('liqi', self.rate_limit_rpm)
        
        # Since this is a mock implementation (Liqi API details not public),
        # we'll generate realistic sample data
        warnings.warn("Liqi API integration is simulated with sample data")
        
        # Generate realistic Brazilian receivables data
        dates = pd.date_range(start_date, end_date, freq='D')
        
        # Brazilian receivables typically yield 18-25% annually
        np.random.seed(42)
        base_yield = 2200  # 22% in basis points
        volatility = 150   # 1.5% daily volatility
        
        yields = []
        current_yield = base_yield
        
        for _ in dates:
            # Mean reversion
            mean_reversion = 0.02 * (base_yield - current_yield)
            # Random shock
            shock = np.random.normal(0, volatility)
            current_yield += mean_reversion + shock
            yields.append(max(1000, current_yield))  # Min 10% yield
        
        df = pd.DataFrame({
            'date': dates,
            'cmBRL': yields
        })
        
        if use_cache:
            self._save_to_cache(df, cache_key)
        
        return df
    
    def load_data(self, **kwargs) -> pd.DataFrame:
        """Load Liqi data"""
        return self.load_receivables_data(**kwargs)


class B3DataLoader(BaseDataLoader):
    """Load data from B3 Brazilian stock exchange"""
    
    def __init__(self, api_key: Optional[str] = None, cache_dir: Optional[str] = None):
        super().__init__(cache_dir)
        self.api_key = api_key
        self.base_url = DATA_SOURCES['b3']['base_url']
        self.rate_limit_rpm = DATA_SOURCES['b3']['rate_limit']
    
    def load_treasury_data(
        self,
        start_date: str,
        end_date: str,
        bond_types: List[str] = ['LTN', 'NTN-B'],
        use_cache: bool = True
    ) -> pd.DataFrame:
        """
        Load Brazilian treasury bond data
        
        Args:
            start_date: Start date (YYYY-MM-DD)
            end_date: End date (YYYY-MM-DD)
            bond_types: Types of bonds to load
            use_cache: Whether to use cached data
            
        Returns:
            DataFrame with treasury yield data
        """
        cache_key = f"b3_treasury_{'-'.join(bond_types)}_{start_date}_{end_date}"
        if use_cache:
            cached_data = self._load_from_cache(cache_key)
            if cached_data is not None:
                return cached_data
        
        # Mock B3 treasury data (real API would require authentication)
        warnings.warn("B3 API integration is simulated with sample data")
        
        dates = pd.date_range(start_date, end_date, freq='D')
        
        # Treasury bonds typically follow SELIC + spread
        np.random.seed(42)
        selic_base = 1350  # 13.5% SELIC base
        
        data = {'date': dates}
        
        for bond_type in bond_types:
            if bond_type == 'LTN':
                # LTN (pre-fixed) typically trades at SELIC + small spread
                spread = 50  # 0.5% spread
                volatility = 80
            elif bond_type == 'NTN-B':
                # NTN-B (inflation-linked) trades at real yields
                spread = 600  # 6% real yield
                volatility = 120
            else:
                spread = 100
                volatility = 100
            
            yields = []
            current_yield = selic_base + spread
            
            for _ in dates:
                mean_reversion = 0.01 * (selic_base + spread - current_yield)
                shock = np.random.normal(0, volatility)
                current_yield += mean_reversion + shock
                yields.append(max(500, current_yield))
            
            data[f'{bond_type}_yield'] = yields
        
        df = pd.DataFrame(data)
        
        if use_cache:
            self._save_to_cache(df, cache_key)
        
        return df
    
    def load_data(self, **kwargs) -> pd.DataFrame:
        """Load B3 data"""
        return self.load_treasury_data(**kwargs)


class BrazilianDataLoader(BaseDataLoader):
    """Comprehensive Brazilian market data loader"""
    
    def __init__(
        self, 
        bacen_enabled: bool = True,
        liqi_api_key: Optional[str] = None,
        b3_api_key: Optional[str] = None,
        cache_dir: Optional[str] = None
    ):
        super().__init__(cache_dir)
        
        # Initialize sub-loaders
        self.loaders = {}
        
        if bacen_enabled:
            self.loaders['bacen'] = BacenDataLoader(cache_dir)
        
        if liqi_api_key:
            self.loaders['liqi'] = LiqiDataLoader(liqi_api_key, cache_dir)
        
        if b3_api_key:
            self.loaders['b3'] = B3DataLoader(b3_api_key, cache_dir)
    
    def load_comprehensive_data(
        self,
        start_date: str,
        end_date: str,
        include_economic_indicators: bool = True,
        include_receivables: bool = True,
        include_treasuries: bool = True,
        use_cache: bool = True
    ) -> pd.DataFrame:
        """
        Load comprehensive Brazilian market data
        
        Args:
            start_date: Start date (YYYY-MM-DD)
            end_date: End date (YYYY-MM-DD)
            include_economic_indicators: Include BACEN indicators
            include_receivables: Include Liqi receivables data
            include_treasuries: Include B3 treasury data
            use_cache: Whether to use cached data
            
        Returns:
            DataFrame with comprehensive market data
        """
        all_data = []
        
        # Load economic indicators
        if include_economic_indicators and 'bacen' in self.loaders:
            indicators = ['SELIC', 'CDI', 'IPCA']
            econ_data = self.loaders['bacen'].load_data(indicators, start_date, end_date, use_cache=use_cache)
            if not econ_data.empty:
                all_data.append(econ_data)
        
        # Load receivables data
        if include_receivables and 'liqi' in self.loaders:
            receivables_data = self.loaders['liqi'].load_receivables_data(start_date, end_date, use_cache=use_cache)
            if not receivables_data.empty:
                all_data.append(receivables_data)
        
        # Load treasury data
        if include_treasuries and 'b3' in self.loaders:
            treasury_data = self.loaders['b3'].load_treasury_data(start_date, end_date, use_cache=use_cache)
            if not treasury_data.empty:
                all_data.append(treasury_data)
        
        # Merge all data
        if not all_data:
            warnings.warn("No data loaded from any source")
            return pd.DataFrame()
        
        result = all_data[0]
        for df in all_data[1:]:
            result = pd.merge(result, df, on='date', how='outer')
        
        return result.sort_values('date').reset_index(drop=True)
    
    def load_data(self, **kwargs) -> pd.DataFrame:
        """Load Brazilian market data"""
        return self.load_comprehensive_data(**kwargs)


class DataLoader(BaseDataLoader):
    """General purpose data loader for multiple sources"""
    
    def __init__(self, cache_dir: Optional[str] = None):
        super().__init__(cache_dir)
    
    def load_from_file(
        self, 
        file_path: str,
        file_format: Optional[str] = None,
        **kwargs
    ) -> pd.DataFrame:
        """
        Load data from file
        
        Args:
            file_path: Path to data file
            file_format: File format ('csv', 'excel', 'parquet', 'json')
            **kwargs: Additional arguments for pandas readers
            
        Returns:
            DataFrame with loaded data
        """
        path = Path(file_path)
        
        if not path.exists():
            raise FileNotFoundError(f"Data file not found: {file_path}")
        
        # Infer format from extension if not provided
        if file_format is None:
            file_format = path.suffix.lower().lstrip('.')
        
        try:
            if file_format in ['csv', 'txt']:
                return pd.read_csv(file_path, **kwargs)
            elif file_format in ['xlsx', 'xls', 'excel']:
                return pd.read_excel(file_path, **kwargs)
            elif file_format == 'parquet':
                return pd.read_parquet(file_path, **kwargs)
            elif file_format == 'json':
                return pd.read_json(file_path, **kwargs)
            else:
                raise ValueError(f"Unsupported file format: {file_format}")
                
        except Exception as e:
            raise RuntimeError(f"Failed to load data from {file_path}: {e}")
    
    def load_sample_data(
        self,
        data_type: str = 'multi_asset',
        start_date: str = '2023-01-01',
        end_date: str = '2024-01-01',
        **kwargs
    ) -> pd.DataFrame:
        """
        Load sample data for testing and demonstration
        
        Args:
            data_type: Type of sample data ('multi_asset', 'brazilian_market')
            start_date: Start date for sample data
            end_date: End date for sample data
            **kwargs: Additional parameters for sample data generation
            
        Returns:
            DataFrame with sample data
        """
        if data_type == 'multi_asset':
            return create_multi_asset_sample_data(start_date, end_date, **kwargs)
        
        elif data_type == 'brazilian_market':
            # Create sample Brazilian market data
            dates = pd.date_range(start_date, end_date, freq='D')
            np.random.seed(42)
            
            data = {'date': dates}
            
            # SELIC rate (relatively stable around 13.5%)
            selic_base = 1350
            selic_values = []
            current_selic = selic_base
            
            for _ in dates:
                mean_reversion = 0.001 * (selic_base - current_selic)
                shock = np.random.normal(0, 20)
                current_selic += mean_reversion + shock
                selic_values.append(max(800, min(2000, current_selic)))
            
            data['SELIC'] = selic_values
            
            # CDI (follows SELIC closely)
            data['CDI'] = [s - np.random.normal(10, 5) for s in selic_values]
            
            # cmBRL (receivables, higher yield)
            data['cmBRL'] = [s + np.random.normal(800, 200) for s in selic_values]
            
            # cmUSD (lower yield, more stable)
            data['cmUSD'] = [max(1000, s - np.random.normal(200, 100)) for s in selic_values]
            
            # cmBTC (crypto-backed, volatile)
            data['cmBTC'] = [max(200, 500 + np.random.normal(0, 300)) for _ in selic_values]
            
            return pd.DataFrame(data)
        
        else:
            raise ValueError(f"Unknown sample data type: {data_type}")
    
    def load_data(self, source: str, **kwargs) -> pd.DataFrame:
        """
        Load data from specified source
        
        Args:
            source: Data source ('file', 'sample', 'url')
            **kwargs: Source-specific arguments
            
        Returns:
            DataFrame with loaded data
        """
        if source == 'file':
            return self.load_from_file(**kwargs)
        elif source == 'sample':
            return self.load_sample_data(**kwargs)
        else:
            raise ValueError(f"Unknown data source: {source}")
