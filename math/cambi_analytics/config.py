"""
Configuration Management for CCYOE Analytics

Centralized configuration for all analytics components including:
- Data source settings
- Analysis parameters  
- Optimization settings
- Visualization preferences
- Performance thresholds
"""

import os
from pathlib import Path
from typing import Dict, List, Optional, Union, Any
import warnings
from dataclasses import dataclass, asdict

# Handle YAML import gracefully
try:
    import yaml
    YAML_AVAILABLE = True
except ImportError:
    YAML_AVAILABLE = False
    warnings.warn("PyYAML not available. Configuration file loading disabled.")


@dataclass
class DataSourceConfig:
    """Configuration for data sources"""
    cache_enabled: bool = True
    cache_max_age_hours: int = 24
    rate_limit_requests_per_minute: int = 60
    timeout_seconds: int = 30
    max_retries: int = 3
    
    # API configurations
    bacen_enabled: bool = True
    liqi_api_key: Optional[str] = None
    b3_api_key: Optional[str] = None
    
    # Data validation
    validate_data: bool = True
    handle_missing_data: str = 'interpolate'  # 'interpolate', 'forward_fill', 'drop'
    outlier_detection: bool = True
    outlier_threshold: float = 3.0


@dataclass
class AnalysisConfig:
    """Configuration for analysis parameters"""
    default_start_date: str = '2023-01-01'
    default_end_date: str = '2024-01-01'
    default_frequency: str = 'D'  # 'D', 'B', 'W', 'M'
    
    # Risk analysis
    var_confidence_levels: List[float] = None
    lookback_periods: List[int] = None
    stress_test_scenarios: List[str] = None
    
    # Performance analysis
    risk_free_rate: float = 0.135  # 13.5% SELIC base
    benchmark_assets: List[str] = None
    
    def __post_init__(self):
        if self.var_confidence_levels is None:
            self.var_confidence_levels = [0.90, 0.95, 0.99]
        if self.lookback_periods is None:
            self.lookback_periods = [30, 60, 90, 180, 252]
        if self.stress_test_scenarios is None:
            self.stress_test_scenarios = ['market_crash', 'correlation_breakdown', 'interest_rate_shock']
        if self.benchmark_assets is None:
            self.benchmark_assets = ['SELIC', 'CDI', 'IBOVESPA']


@dataclass
class OptimizationConfig:
    """Configuration for optimization parameters"""
    default_method: str = 'scipy'  # 'scipy', 'cvxpy', 'genetic'
    max_iterations: int = 1000
    tolerance: float = 1e-6
    
    # CCYOE specific
    rebalance_threshold_range: tuple = (25, 500)  # basis points
    allocation_bounds: Dict[str, tuple] = None
    transaction_cost_range: tuple = (1, 50)  # basis points
    
    # Multi-objective optimization
    default_objectives: List[str] = None
    objective_weights: Dict[str, float] = None
    
    def __post_init__(self):
        if self.allocation_bounds is None:
            self.allocation_bounds = {
                'under_supplied': (0.3, 0.5),
                'strategic_growth': (0.2, 0.4),
                'proportional': (0.1, 0.3),
                'treasury': (0.05, 0.2)
            }
        if self.default_objectives is None:
            self.default_objectives = ['sharpe_ratio', 'total_return']
        if self.objective_weights is None:
            self.objective_weights = {'sharpe_ratio': 0.7, 'total_return': 0.3}


@dataclass
class VisualizationConfig:
    """Configuration for visualization and reporting"""
    default_theme: str = 'plotly_white'
    figure_width: int = 1000
    figure_height: int = 600
    dpi: int = 300
    
    # Colors
    color_palette: List[str] = None
    
    # Dashboard
    dashboard_host: str = '127.0.0.1'
    dashboard_port: int = 8050
    dashboard_debug: bool = False
    
    # Export
    export_formats: List[str] = None
    export_directory: str = './exports'
    
    def __post_init__(self):
        if self.color_palette is None:
            self.color_palette = [
                '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
                '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
                '#bcbd22', '#17becf'
            ]
        if self.export_formats is None:
            self.export_formats = ['png', 'pdf', 'html']


@dataclass
class PerformanceConfig:
    """Configuration for performance thresholds and alerts"""
    # Performance thresholds
    min_sharpe_ratio: float = 1.0
    max_drawdown_threshold: float = 0.15  # 15%
    min_win_rate: float = 0.55  # 55%
    
    # CCYOE specific thresholds
    min_excess_yield: float = 50  # 0.5% minimum excess yield for rebalancing
    max_rebalancing_frequency: int = 10  # per month
    min_diversification_ratio: float = 1.2
    
    # Alerts
    send_performance_alerts: bool = True
    alert_email: Optional[str] = None
    alert_slack_webhook: Optional[str] = None
    
    # Monitoring
    monitoring_frequency: str = 'daily'  # 'real-time', 'hourly', 'daily'
    health_check_interval: int = 300  # seconds


class AnalyticsConfig:
    """
    Main configuration class for CCYOE Analytics
    
    Manages all configuration aspects including loading from files,
    environment variables, and providing defaults.
    """
    
    def __init__(self, config_file: Optional[str] = None):
        """
        Initialize configuration
        
        Args:
            config_file: Path to YAML configuration file
        """
        self.config_file = config_file
        self.config_dir = Path.home() / '.cambi_analytics'
        self.config_dir.mkdir(exist_ok=True)
        
        # Initialize with defaults
        self.data_source = DataSourceConfig()
        self.analysis = AnalysisConfig()
        self.optimization = OptimizationConfig()
        self.visualization = VisualizationConfig()
        self.performance = PerformanceConfig()
        
        # Load configuration
        self._load_configuration()
        self._load_environment_variables()
    
    def _load_configuration(self):
        """Load configuration from file"""
        if not YAML_AVAILABLE:
            return
            
        if self.config_file and Path(self.config_file).exists():
            try:
                with open(self.config_file, 'r') as f:
                    config_data = yaml.safe_load(f)
                
                # Update configurations
                if 'data_source' in config_data:
                    self._update_dataclass(self.data_source, config_data['data_source'])
                
                if 'analysis' in config_data:
                    self._update_dataclass(self.analysis, config_data['analysis'])
                
                if 'optimization' in config_data:
                    self._update_dataclass(self.optimization, config_data['optimization'])
                
                if 'visualization' in config_data:
                    self._update_dataclass(self.visualization, config_data['visualization'])
                
                if 'performance' in config_data:
                    self._update_dataclass(self.performance, config_data['performance'])
                    
            except Exception as e:
                warnings.warn(f"Failed to load configuration file {self.config_file}: {e}")
    
    def _load_environment_variables(self):
        """Load configuration from environment variables with validation"""
        # API keys
        liqi_key = os.getenv('LIQI_API_KEY')
        if liqi_key and len(liqi_key) > 10:  # Basic validation
            self.data_source.liqi_api_key = liqi_key
        
        b3_key = os.getenv('B3_API_KEY')
        if b3_key and len(b3_key) > 10:
            self.data_source.b3_api_key = b3_key
        
        # Alert settings
        alert_email = os.getenv('ALERT_EMAIL')
        if alert_email and '@' in alert_email:  # Basic email validation
            self.performance.alert_email = alert_email
        
        slack_webhook = os.getenv('SLACK_WEBHOOK_URL')
        if slack_webhook and slack_webhook.startswith('https://hooks.slack.com'):
            self.performance.alert_slack_webhook = slack_webhook
        
        # Dashboard settings
        dashboard_host = os.getenv('DASHBOARD_HOST')
        if dashboard_host:
            self.visualization.dashboard_host = dashboard_host
        
        dashboard_port = os.getenv('DASHBOARD_PORT')
        if dashboard_port:
            try:
                port = int(dashboard_port)
                if 1024 <= port <= 65535:  # Valid port range
                    self.visualization.dashboard_port = port
            except ValueError:
                warnings.warn("Invalid DASHBOARD_PORT environment variable")
    
    def _update_dataclass(self, dataclass_instance, config_dict):
        """Update dataclass instance with values from dictionary"""
        for key, value in config_dict.items():
            if hasattr(dataclass_instance, key):
                setattr(dataclass_instance, key, value)
    
    def save_configuration(self, file_path: Optional[str] = None):
        """
        Save current configuration to file
        
        Args:
            file_path: Path to save configuration (if None, use default)
        """
        if not YAML_AVAILABLE:
            warnings.warn("PyYAML not available. Cannot save configuration.")
            return
            
        if file_path is None:
            file_path = self.config_dir / 'config.yaml'
        
        config_dict = {
            'data_source': asdict(self.data_source),
            'analysis': asdict(self.analysis),
            'optimization': asdict(self.optimization),
            'visualization': asdict(self.visualization),
            'performance': asdict(self.performance)
        }
        
        try:
            with open(file_path, 'w') as f:
                yaml.dump(config_dict, f, default_flow_style=False, indent=2)
        except Exception as e:
            warnings.warn(f"Failed to save configuration to {file_path}: {e}")
    
    def get_cache_directory(self) -> Path:
        """Get cache directory path"""
        cache_dir = self.config_dir / 'cache'
        cache_dir.mkdir(exist_ok=True)
        return cache_dir
    
    def get_export_directory(self) -> Path:
        """Get export directory path"""
        export_dir = Path(self.visualization.export_directory)
        export_dir.mkdir(exist_ok=True)
        return export_dir
    
    def validate_configuration(self) -> Dict[str, List[str]]:
        """
        Validate configuration settings
        
        Returns:
            Dict with validation results and any issues found
        """
        issues = {
            'errors': [],
            'warnings': []
        }
        
        # Validate data source config
        if self.data_source.cache_max_age_hours < 0:
            issues['errors'].append("Cache max age must be non-negative")
        
        if self.data_source.timeout_seconds <= 0:
            issues['errors'].append("Timeout must be positive")
        
        # Validate analysis config
        try:
            from datetime import datetime
            datetime.strptime(self.analysis.default_start_date, '%Y-%m-%d')
            datetime.strptime(self.analysis.default_end_date, '%Y-%m-%d')
        except ValueError:
            issues['errors'].append("Invalid date format in analysis config")
        
        if self.analysis.risk_free_rate < 0 or self.analysis.risk_free_rate > 1:
            issues['warnings'].append("Risk-free rate seems unusual")
        
        # Validate optimization config
        if self.optimization.max_iterations <= 0:
            issues['errors'].append("Max iterations must be positive")
        
        if self.optimization.tolerance <= 0:
            issues['errors'].append("Tolerance must be positive")
        
        # Validate allocation bounds
        for allocation_type, (min_val, max_val) in self.optimization.allocation_bounds.items():
            if min_val < 0 or max_val > 1 or min_val >= max_val:
                issues['errors'].append(f"Invalid bounds for {allocation_type}")
        
        # Validate visualization config
        if self.visualization.figure_width <= 0 or self.visualization.figure_height <= 0:
            issues['errors'].append("Figure dimensions must be positive")
        
        if self.visualization.dashboard_port < 1024 or self.visualization.dashboard_port > 65535:
            issues['warnings'].append("Dashboard port outside recommended range")
        
        # Validate performance config
        if self.performance.max_drawdown_threshold < 0 or self.performance.max_drawdown_threshold > 1:
            issues['errors'].append("Max drawdown threshold must be between 0 and 1")
        
        if self.performance.min_win_rate < 0 or self.performance.min_win_rate > 1:
            issues['errors'].append("Min win rate must be between 0 and 1")
        
        return issues
    
    def update_from_dict(self, config_dict: Dict[str, Any]):
        """
        Update configuration from dictionary
        
        Args:
            config_dict: Dictionary with configuration updates
        """
        for section, values in config_dict.items():
            if hasattr(self, section) and isinstance(values, dict):
                self._update_dataclass(getattr(self, section), values)
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Convert configuration to dictionary
        
        Returns:
            Dictionary representation of configuration
        """
        return {
            'data_source': asdict(self.data_source),
            'analysis': asdict(self.analysis),
            'optimization': asdict(self.optimization),
            'visualization': asdict(self.visualization),
            'performance': asdict(self.performance)
        }


# Global configuration instance
_global_config = None


def get_config(config_file: Optional[str] = None) -> AnalyticsConfig:
    """
    Get global configuration instance
    
    Args:
        config_file: Path to configuration file (only used on first call)
        
    Returns:
        AnalyticsConfig instance
    """
    global _global_config
    
    if _global_config is None:
        _global_config = AnalyticsConfig(config_file)
    
    return _global_config


def reset_config():
    """Reset global configuration (useful for testing)"""
    global _global_config
    _global_config = None
