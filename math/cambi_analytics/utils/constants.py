"""
Core constants for CCYOE analytics

Contains asset identifiers, Brazilian market holidays, and other constants
used throughout the analytics package.
"""

from datetime import datetime
from typing import Dict, List

# Asset identifiers
ASSET_IDS = {
    'cmBTC': 'Cambi Bitcoin',
    'cmUSD': 'Cambi USD',
    'cmBRL': 'Cambi Brazilian Real'
}

# Brazilian market holidays (major ones that affect financial markets)
BRAZILIAN_HOLIDAYS = [
    # New Year's Day
    '2023-01-01', '2024-01-01', '2025-01-01',
    
    # Carnival (dates vary each year)
    '2023-02-20', '2023-02-21', '2023-02-22',
    '2024-02-12', '2024-02-13', '2024-02-14',
    '2025-03-03', '2025-03-04', '2025-03-05',
    
    # Good Friday
    '2023-04-07', '2024-03-29', '2025-04-18',
    
    # Tiradentes Day
    '2023-04-21', '2024-04-21', '2025-04-21',
    
    # Labor Day
    '2023-05-01', '2024-05-01', '2025-05-01',
    
    # Independence Day
    '2023-09-07', '2024-09-07', '2025-09-07',
    
    # Our Lady of Aparecida
    '2023-10-12', '2024-10-12', '2025-10-12',
    
    # All Souls' Day
    '2023-11-02', '2024-11-02', '2025-11-02',
    
    # Proclamation of the Republic
    '2023-11-15', '2024-11-15', '2025-11-15',
    
    # Christmas Day
    '2023-12-25', '2024-12-25', '2025-12-25'
]

# Economic indicators tracked for Brazilian market analysis
ECONOMIC_INDICATORS = {
    'SELIC': {
        'name': 'SELIC Rate',
        'description': 'Brazilian Central Bank base interest rate',
        'source': 'BACEN',
        'frequency': 'daily',
        'series_id': 11
    },
    'IPCA': {
        'name': 'IPCA Inflation Index',
        'description': 'Consumer Price Index - Brazil',
        'source': 'BACEN',
        'frequency': 'monthly',
        'series_id': 433
    },
    'CDI': {
        'name': 'CDI Rate',
        'description': 'Interbank Deposit Certificate Rate',
        'source': 'BACEN',
        'frequency': 'daily',
        'series_id': 4389
    },
    'USDBRL': {
        'name': 'USD/BRL Exchange Rate',
        'description': 'US Dollar to Brazilian Real exchange rate',
        'source': 'BACEN',
        'frequency': 'daily',
        'series_id': 1
    },
    'IGP_M': {
        'name': 'IGP-M Index',
        'description': 'General Price Index - Market',
        'source': 'FGV',
        'frequency': 'monthly',
        'series_id': 189
    }
}

# Asset configuration constants
ASSET_CONFIG = {
    'cmBTC': {
        'target_yield': 500,    # 5% in basis points
        'risk_free_rate': 300,  # 3% risk-free equivalent
        'volatility_target': 800,  # 8% volatility target
        'correlation_assets': ['BTC', 'crypto'],
        'supply_cap': 20,       # $20M supply cap
        'decimal_places': 8
    },
    'cmUSD': {
        'target_yield': 1400,   # 14% in basis points
        'risk_free_rate': 500,  # 5% risk-free equivalent
        'volatility_target': 300,  # 3% volatility target
        'correlation_assets': ['USD', 'treasuries'],
        'supply_cap': 50,       # $50M supply cap
        'decimal_places': 6
    },
    'cmBRL': {
        'target_yield': 2000,   # 20% in basis points
        'risk_free_rate': 1350, # 13.5% risk-free equivalent (SELIC)
        'volatility_target': 500,  # 5% volatility target
        'correlation_assets': ['BRL', 'emerging_markets'],
        'supply_cap': 1000,     # $1B supply cap (effectively unlimited)
        'decimal_places': 2
    }
}

# Optimization constants
OPTIMIZATION_CONSTRAINTS = {
    'min_allocation': 0.05,         # 5% minimum allocation
    'max_allocation': 0.50,         # 50% maximum allocation
    'min_treasury_allocation': 0.05, # 5% minimum treasury
    'max_treasury_allocation': 0.15, # 15% maximum treasury
    'rebalance_threshold_min': 25,   # 0.25% minimum threshold
    'rebalance_threshold_max': 500,  # 5% maximum threshold
    'transaction_cost_min': 1,       # 0.01% minimum transaction cost
    'transaction_cost_max': 50       # 0.5% maximum transaction cost
}

# Risk management constants
RISK_PARAMETERS = {
    'var_confidence_levels': [0.90, 0.95, 0.99],
    'stress_test_scenarios': [
        'market_crash',
        'correlation_breakdown', 
        'interest_rate_shock',
        'liquidity_crisis',
        'currency_crisis'
    ],
    'max_drawdown_threshold': 0.15,  # 15%
    'volatility_threshold': 0.25,    # 25%
    'correlation_threshold': 0.80,   # 80%
    'lookback_periods': [30, 60, 90, 180, 252]  # days
}

# Data source configuration
DATA_SOURCES = {
    'liqi': {
        'name': 'Liqi Digital Assets',
        'base_url': 'https://api.liqi.com.br',
        'endpoints': {
            'receivables': '/v1/receivables',
            'yields': '/v1/yields',
            'portfolios': '/v1/portfolios'
        },
        'rate_limit': 100,  # requests per minute
        'timeout': 30
    },
    'b3': {
        'name': 'B3 Brazilian Stock Exchange',
        'base_url': 'https://api.b3.com.br',
        'endpoints': {
            'bonds': '/v1/bonds',
            'treasuries': '/v1/treasuries',
            'indices': '/v1/indices'
        },
        'rate_limit': 60,
        'timeout': 45
    },
    'bacen': {
        'name': 'Brazilian Central Bank',
        'base_url': 'https://api.bcb.gov.br/dados/serie/bcdata.sgs',
        'rate_limit': 120,
        'timeout': 60
    }
}

# Analysis constants
ANALYSIS_PERIODS = {
    'daily': 1,
    'weekly': 7,
    'monthly': 30,
    'quarterly': 90,
    'yearly': 365
}

# Trading day constants
BUSINESS_DAYS_PER_YEAR = 252
BUSINESS_DAYS_PER_MONTH = 21
BUSINESS_DAYS_PER_QUARTER = 63

# Currency codes
CURRENCY_CODES = {
    'BRL': 'Brazilian Real',
    'USD': 'US Dollar', 
    'BTC': 'Bitcoin'
}

# Yield calculation constants
BASIS_POINTS_PER_PERCENT = 100
PERCENT_TO_DECIMAL = 0.01
DECIMAL_TO_PERCENT = 100

# Performance benchmarks for Brazilian market
BRAZILIAN_BENCHMARKS = {
    'SELIC': 'Brazilian Central Bank base rate',
    'CDI': 'Interbank deposit rate',
    'IBOVESPA': 'Brazilian stock index',
    'IRF_M': 'Fixed income index',
    'IPCA_15': 'Inflation benchmark'
}

# API timeout and retry constants
API_TIMEOUT = 30
API_MAX_RETRIES = 3
API_BACKOFF_FACTOR = 2

# File format constants
SUPPORTED_FILE_FORMATS = ['.csv', '.xlsx', '.json', '.parquet']
DEFAULT_DATE_FORMAT = '%Y-%m-%d'
DEFAULT_DATETIME_FORMAT = '%Y-%m-%d %H:%M:%S'

# Logging constants
LOG_FORMAT = '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
LOG_DATE_FORMAT = '%Y-%m-%d %H:%M:%S'
