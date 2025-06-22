"""
Cambi CCYOE Analytics Package

Advanced analytics, backtesting, and mathematical modeling for the 
Cross-Collateral Yield Optimization Engine (CCYOE).
"""

__version__ = "1.0.0"
__author__ = "Cambi Protocol"
__license__ = "MIT"

# Core imports (existing files)
from .core.yield_analyzer import YieldAnalyzer
from .core.backtester import CCYOEBacktester, BacktestResults, OptimizationConfig
from .core.optimizer import YieldOptimizer

# Data handling (existing files)
from .data.loaders import DataLoader, BrazilianDataLoader
from .data.processors import YieldProcessor, DataValidator

# Models (existing files)
from .models.optimization import OptimizationEngine

# Utilities (existing files)
from .utils.metrics import PerformanceMetrics, RiskMetrics, VaRCalculator
from .utils.constants import ASSET_IDS, BRAZILIAN_HOLIDAYS, ECONOMIC_INDICATORS
from .utils.helpers import (
    calculate_business_days, format_percentage, validate_data,
    create_multi_asset_sample_data
)

# Configuration (existing file)
from .config import AnalyticsConfig, get_config

__all__ = [
    # Core
    'YieldAnalyzer',
    'CCYOEBacktester', 
    'BacktestResults',
    'YieldOptimizer',
    'OptimizationConfig',
    
    # Data
    'DataLoader',
    'BrazilianDataLoader',
    'YieldProcessor',
    'DataValidator',
    
    # Models
    'OptimizationEngine',
    
    # Utilities
    'PerformanceMetrics',
    'RiskMetrics',
    'VaRCalculator',
    'ASSET_IDS',
    'BRAZILIAN_HOLIDAYS',
    'ECONOMIC_INDICATORS',
    'calculate_business_days',
    'format_percentage',
    'validate_data',
    'create_multi_asset_sample_data',
    
    # Configuration
    'AnalyticsConfig',
    'get_config'
]

# Package-level configuration
import logging
import warnings

# Set up logging
logging.getLogger(__name__).addHandler(logging.NullHandler())

# Filter warnings for numerical computations
warnings.filterwarnings('ignore', category=RuntimeWarning, module='numpy')
warnings.filterwarnings('ignore', category=FutureWarning, module='pandas')

# Version info
VERSION_INFO = tuple(map(int, __version__.split('.')))
