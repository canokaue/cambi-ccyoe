"""
Cambi CCYOE Analytics Package

Advanced analytics, backtesting, and mathematical modeling for the 
Cross-Collateral Yield Optimization Engine (CCYOE).
"""

__version__ = "1.0.0"
__author__ = "Cambi Protocol"
__license__ = "MIT"

# Core imports
from .core.yield_analyzer import YieldAnalyzer
from .core.backtester import CCYOEBacktester, BacktestResults
from .core.optimizer import YieldOptimizer, OptimizationConfig

# Data handling
from .data.loaders import DataLoader, BrazilianDataLoader
from .data.processors import YieldProcessor, DataValidator

# Models
from .models.optimization import OptimizationEngine
from .models.risk_models import RiskCalculator, VaRCalculator
from .models.correlation import CorrelationAnalyzer

# Visualization
from .visualization.plots import YieldPlotter, PerformancePlotter
from .visualization.dashboards import CCYOEDashboard
from .visualization.reports import AnalyticsReporter

# Utilities
from .utils.metrics import PerformanceMetrics, RiskMetrics
from .utils.constants import ASSET_IDS, BRAZILIAN_HOLIDAYS
from .utils.helpers import calculate_business_days, format_percentage

# Configuration
from .config import AnalyticsConfig

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
    'RiskCalculator',
    'VaRCalculator',
    'CorrelationAnalyzer',
    
    # Visualization
    'YieldPlotter',
    'PerformancePlotter',
    'CCYOEDashboard',
    'AnalyticsReporter',
    
    # Utilities
    'PerformanceMetrics',
    'RiskMetrics',
    'ASSET_IDS',
    'BRAZILIAN_HOLIDAYS',
    'calculate_business_days',
    'format_percentage',
    
    # Configuration
    'AnalyticsConfig'
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
