import { Logger } from '../../utils/Logger';
import { Config } from '../../config/Config';

export interface OutlierConfig {
  // Statistical methods
  zScoreThreshold: number; // Standard deviations for z-score method
  iqrMultiplier: number; // Multiplier for IQR method
  modifiedZScoreThreshold: number; // For modified z-score using median

  // Percentage-based thresholds
  percentageDeviationThreshold: number; // Max percentage deviation from median
  
  // Minimum data requirements
  minDataPointsForDetection: number; // Minimum data points to perform outlier detection
  
  // Asset-specific configurations
  assetSpecificThresholds: Record<string, {
    zScore: number;
    percentageDeviation: number;
  }>;

  // Historical analysis
  useHistoricalData: boolean;
  historicalWindowSize: number; // Number of recent data points to consider
  
  // Consensus-based detection
  consensusThreshold: number; // How much agreement needed to not be an outlier
}

export interface OutlierResult {
  isOutlier: boolean;
  outlierScore: number; // 0-100, higher means more likely to be outlier
  detectionMethod: string;
  deviation: number;
  metadata: {
    zScore?: number;
    iqrPosition?: number;
    percentageDeviation?: number;
    medianValue?: number;
    standardDeviation?: number;
    confidence?: number;
  };
  reasons: string[];
}

export interface YieldDataPoint {
  source: string;
  yield: number;
  confidence: number;
  timestamp: number;
  metadata?: any;
}

export interface OutlierAnalysis {
  totalDataPoints: number;
  outliersDetected: number;
  outlierSources: string[];
  cleanDataPoints: YieldDataPoint[];
  outlierDataPoints: YieldDataPoint[];
  statistics: {
    mean: number;
    median: number;
    standardDeviation: number;
    q1: number;
    q3: number;
    iqr: number;
    range: number;
  };
}

/**
 * Outlier Detector for identifying anomalous yield data points
 * Uses multiple statistical methods to ensure robust outlier detection
 */
export class OutlierDetector {
  private logger: Logger;
  private config: OutlierConfig;
  private historicalData: Map<string, YieldDataPoint[]>; // Asset ID -> historical data

  constructor(config: Config) {
    this.logger = new Logger('OutlierDetector');
    this.historicalData = new Map();

    // Default configuration
    this.config = {
      zScoreThreshold: 2.5, // More conservative than standard 2.0
      iqrMultiplier: 1.5,
      modifiedZScoreThreshold: 3.5,
      percentageDeviationThreshold: 0.25, // 25% deviation
      minDataPointsForDetection: 3,
      assetSpecificThresholds: {
        'cmBTC': {
          zScore: 2.0, // More sensitive for BTC
          percentageDeviation: 0.15 // 15% for BTC
        },
        'cmUSD': {
          zScore: 2.5,
          percentageDeviation: 0.20 // 20% for USD
        },
        'cmBRL': {
          zScore: 3.0, // Less sensitive for BRL due to volatility
          percentageDeviation: 0.30 // 30% for BRL
        }
      },
      useHistoricalData: true,
      historicalWindowSize: 50,
      consensusThreshold: 0.7 // 70% of sources should agree
    };

    this.logger.info('Outlier detector initialized', this.config);
  }

  /**
   * Detect outliers in a set of yield data points
   */
  public detectOutliers(
    dataPoints: YieldDataPoint[],
    assetId: string
  ): OutlierAnalysis {
    try {
      if (dataPoints.length < this.config.minDataPointsForDetection) {
        this.logger.debug('Insufficient data points for outlier detection', {
          dataPoints: dataPoints.length,
          required: this.config.minDataPointsForDetection
        });

        return this.createEmptyAnalysis(dataPoints);
      }

      // Calculate basic statistics
      const statistics = this.calculateStatistics(dataPoints);
      
      // Detect outliers using multiple methods
      const outlierResults: Array<{ dataPoint: YieldDataPoint; result: OutlierResult }> = [];
      
      for (const dataPoint of dataPoints) {
        const result = this.detectSingleOutlier(dataPoint, dataPoints, assetId, statistics);
        outlierResults.push({ dataPoint, result });
      }

      // Separate clean and outlier data points
      const cleanDataPoints: YieldDataPoint[] = [];
      const outlierDataPoints: YieldDataPoint[] = [];
      const outlierSources: string[] = [];

      outlierResults.forEach(({ dataPoint, result }) => {
        if (result.isOutlier) {
          outlierDataPoints.push(dataPoint);
          outlierSources.push(dataPoint.source);
        } else {
          cleanDataPoints.push(dataPoint);
        }
      });

      const analysis: OutlierAnalysis = {
        totalDataPoints: dataPoints.length,
        outliersDetected: outlierDataPoints.length,
        outlierSources,
        cleanDataPoints,
        outlierDataPoints,
        statistics
      };

      this.logger.info('Outlier detection completed', {
        assetId,
        totalPoints: analysis.totalDataPoints,
        outliersDetected: analysis.outliersDetected,
        outlierSources: analysis.outlierSources
      });

      // Store historical data for future analysis
      this.updateHistoricalData(assetId, cleanDataPoints);

      return analysis;

    } catch (error) {
      this.logger.error('Failed to detect outliers', error, { assetId, dataPointCount: dataPoints.length });
      return this.createEmptyAnalysis(dataPoints);
    }
  }

  /**
   * Detect if a single data point is an outlier
   */
  public detectSingleOutlier(
    dataPoint: YieldDataPoint,
    allDataPoints: YieldDataPoint[],
    assetId: string,
    statistics?: any
  ): OutlierResult {
    const stats = statistics || this.calculateStatistics(allDataPoints);
    const assetConfig = this.config.assetSpecificThresholds[assetId];
    
    let isOutlier = false;
    let outlierScore = 0;
    const reasons: string[] = [];
    const metadata: any = {};
    let detectionMethod = 'composite';

    // Method 1: Z-Score Detection
    const zScore = this.calculateZScore(dataPoint.yield, stats.mean, stats.standardDeviation);
    metadata.zScore = zScore;
    
    const zThreshold = assetConfig?.zScore || this.config.zScoreThreshold;
    if (Math.abs(zScore) > zThreshold) {
      isOutlier = true;
      outlierScore += 30;
      reasons.push(`Z-score ${zScore.toFixed(2)} exceeds threshold ${zThreshold}`);
    }

    // Method 2: IQR Detection
    const iqrResult = this.detectIQROutlier(dataPoint.yield, stats);
    metadata.iqrPosition = iqrResult.position;
    
    if (iqrResult.isOutlier) {
      isOutlier = true;
      outlierScore += 25;
      reasons.push(`IQR outlier: ${iqrResult.reason}`);
    }

    // Method 3: Percentage Deviation from Median
    const percentageDeviation = Math.abs(dataPoint.yield - stats.median) / stats.median;
    metadata.percentageDeviation = percentageDeviation;
    metadata.medianValue = stats.median;
    
    const percentThreshold = assetConfig?.percentageDeviation || this.config.percentageDeviationThreshold;
    if (percentageDeviation > percentThreshold) {
      isOutlier = true;
      outlierScore += 20;
      reasons.push(`Percentage deviation ${(percentageDeviation * 100).toFixed(1)}% exceeds ${(percentThreshold * 100).toFixed(1)}%`);
    }

    // Method 4: Modified Z-Score (using median and MAD)
    const modifiedZScore = this.calculateModifiedZScore(dataPoint.yield, allDataPoints);
    if (Math.abs(modifiedZScore) > this.config.modifiedZScoreThreshold) {
      isOutlier = true;
      outlierScore += 15;
      reasons.push(`Modified Z-score ${modifiedZScore.toFixed(2)} exceeds threshold ${this.config.modifiedZScoreThreshold}`);
    }

    // Method 5: Confidence-based detection
    if (dataPoint.confidence < 50) {
      outlierScore += 10;
      reasons.push(`Low confidence score: ${dataPoint.confidence}`);
    }

    // Historical data comparison (if available)
    if (this.config.useHistoricalData) {
      const historicalScore = this.compareWithHistorical(dataPoint.yield, assetId);
      if (historicalScore > 0.3) { // 30% outlier score from historical
        outlierScore += 10;
        reasons.push(`Deviates significantly from historical data`);
      }
    }

    // Final outlier determination
    const finalOutlierScore = Math.min(100, outlierScore);
    const isDefinitiveOutlier = finalOutlierScore >= 40; // 40+ score means outlier

    metadata.standardDeviation = stats.standardDeviation;
    metadata.confidence = dataPoint.confidence;

    const result: OutlierResult = {
      isOutlier: isDefinitiveOutlier,
      outlierScore: finalOutlierScore,
      detectionMethod,
      deviation: Math.abs(dataPoint.yield - stats.median),
      metadata,
      reasons
    };

    if (isDefinitiveOutlier) {
      this.logger.warn('Outlier detected', {
        source: dataPoint.source,
        assetId,
        yield: dataPoint.yield,
        score: finalOutlierScore,
        reasons
      });
    }

    return result;
  }

  /**
   * Calculate basic statistical measures
   */
  private calculateStatistics(dataPoints: YieldDataPoint[]): any {
    const yields = dataPoints.map(dp => dp.yield).sort((a, b) => a - b);
    
    const mean = yields.reduce((sum, yield_) => sum + yield_, 0) / yields.length;
    const median = this.calculateMedian(yields);
    
    // Calculate standard deviation
    const variance = yields.reduce((sum, yield_) => sum + Math.pow(yield_ - mean, 2), 0) / yields.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Calculate quartiles
    const q1 = this.calculatePercentile(yields, 25);
    const q3 = this.calculatePercentile(yields, 75);
    const iqr = q3 - q1;
    
    const range = yields[yields.length - 1] - yields[0];

    return {
      mean,
      median,
      standardDeviation,
      q1,
      q3,
      iqr,
      range,
      min: yields[0],
      max: yields[yields.length - 1]
    };
  }

  /**
   * Calculate Z-score for a value
   */
  private calculateZScore(value: number, mean: number, standardDeviation: number): number {
    if (standardDeviation === 0) return 0;
    return (value - mean) / standardDeviation;
  }

  /**
   * Detect outliers using Interquartile Range (IQR) method
   */
  private detectIQROutlier(value: number, statistics: any): { isOutlier: boolean; position: string; reason: string } {
    const { q1, q3, iqr } = statistics;
    
    const lowerBound = q1 - (this.config.iqrMultiplier * iqr);
    const upperBound = q3 + (this.config.iqrMultiplier * iqr);
    
    let position = 'normal';
    let reason = '';
    let isOutlier = false;

    if (value < lowerBound) {
      position = 'below_lower_bound';
      reason = `Value ${value} below lower bound ${lowerBound.toFixed(2)}`;
      isOutlier = true;
    } else if (value > upperBound) {
      position = 'above_upper_bound';
      reason = `Value ${value} above upper bound ${upperBound.toFixed(2)}`;
      isOutlier = true;
    } else {
      position = 'within_bounds';
      reason = 'Within normal IQR range';
    }

    return { isOutlier, position, reason };
  }

  /**
   * Calculate Modified Z-Score using median absolute deviation (MAD)
   */
  private calculateModifiedZScore(value: number, dataPoints: YieldDataPoint[]): number {
    const yields = dataPoints.map(dp => dp.yield);
    const median = this.calculateMedian(yields);
    
    // Calculate median absolute deviation (MAD)
    const absoluteDeviations = yields.map(yield_ => Math.abs(yield_ - median));
    const mad = this.calculateMedian(absoluteDeviations);
    
    if (mad === 0) return 0;
    
    // Modified Z-score formula: 0.6745 * (x - median) / MAD
    return 0.6745 * (value - median) / mad;
  }

  /**
   * Compare with historical data to detect temporal outliers
   */
  private compareWithHistorical(value: number, assetId: string): number {
    const historical = this.historicalData.get(assetId);
    if (!historical || historical.length < 10) {
      return 0; // Not enough historical data
    }

    const recentData = historical.slice(-this.config.historicalWindowSize);
    const historicalYields = recentData.map(dp => dp.yield);
    const historicalStats = this.calculateStatistics(recentData);
    
    // Calculate how much this value deviates from historical norm
    const historicalZScore = this.calculateZScore(value, historicalStats.mean, historicalStats.standardDeviation);
    
    // Return outlier score based on historical deviation
    if (Math.abs(historicalZScore) > 3.0) {
      return 0.8; // High outlier score
    } else if (Math.abs(historicalZScore) > 2.0) {
      return 0.5; // Medium outlier score
    } else if (Math.abs(historicalZScore) > 1.5) {
      return 0.3; // Low outlier score
    }
    
    return 0; // Normal
  }

  /**
   * Update historical data for an asset
   */
  private updateHistoricalData(assetId: string, newDataPoints: YieldDataPoint[]): void {
    if (!this.config.useHistoricalData) return;

    let historical = this.historicalData.get(assetId) || [];
    
    // Add new data points
    historical = historical.concat(newDataPoints);
    
    // Keep only the most recent data points within the window size
    if (historical.length > this.config.historicalWindowSize) {
      historical = historical.slice(-this.config.historicalWindowSize);
    }
    
    // Sort by timestamp
    historical.sort((a, b) => a.timestamp - b.timestamp);
    
    this.historicalData.set(assetId, historical);
  }

  /**
   * Calculate median of an array
   */
  private calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    } else {
      return sorted[middle];
    }
  }

  /**
   * Calculate percentile of an array
   */
  private calculatePercentile(sortedValues: number[], percentile: number): number {
    if (sortedValues.length === 0) return 0;
    
    const index = (percentile / 100) * (sortedValues.length - 1);
    const lowerIndex = Math.floor(index);
    const upperIndex = Math.ceil(index);
    
    if (lowerIndex === upperIndex) {
      return sortedValues[lowerIndex];
    }
    
    const weight = index - lowerIndex;
    return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
  }

  /**
   * Create empty analysis when insufficient data
   */
  private createEmptyAnalysis(dataPoints: YieldDataPoint[]): OutlierAnalysis {
    return {
      totalDataPoints: dataPoints.length,
      outliersDetected: 0,
      outlierSources: [],
      cleanDataPoints: dataPoints,
      outlierDataPoints: [],
      statistics: {
        mean: 0,
        median: 0,
        standardDeviation: 0,
        q1: 0,
        q3: 0,
        iqr: 0,
        range: 0
      }
    };
  }

  /**
   * Get outlier detection configuration
   */
  public getConfig(): OutlierConfig {
    return { ...this.config };
  }

  /**
   * Update outlier detection configuration
   */
  public updateConfig(newConfig: Partial<OutlierConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Outlier detector configuration updated', newConfig);
  }

  /**
   * Get historical data for an asset
   */
  public getHistoricalData(assetId: string): YieldDataPoint[] {
    return this.historicalData.get(assetId) || [];
  }

  /**
   * Clear historical data
   */
  public clearHistoricalData(assetId?: string): void {
    if (assetId) {
      this.historicalData.delete(assetId);
      this.logger.info(`Cleared historical data for ${assetId}`);
    } else {
      this.historicalData.clear();
      this.logger.info('Cleared all historical data');
    }
  }

  /**
   * Analyze outlier patterns across multiple assets
   */
  public analyzeOutlierPatterns(analyses: Map<string, OutlierAnalysis>): {
    totalOutliers: number;
    outliersByAsset: Record<string, number>;
    commonOutlierSources: string[];
    patternAnalysis: {
      mostProblematicSources: string[];
      assetsWithMostOutliers: string[];
      timeBasedPatterns: any;
    };
  } {
    let totalOutliers = 0;
    const outliersByAsset: Record<string, number> = {};
    const sourceOutlierCounts: Map<string, number> = new Map();
    
    // Collect outlier statistics
    analyses.forEach((analysis, assetId) => {
      totalOutliers += analysis.outliersDetected;
      outliersByAsset[assetId] = analysis.outliersDetected;
      
      analysis.outlierSources.forEach(source => {
        sourceOutlierCounts.set(source, (sourceOutlierCounts.get(source) || 0) + 1);
      });
    });

    // Find common outlier sources (sources that are outliers across multiple assets)
    const commonOutlierSources = Array.from(sourceOutlierCounts.entries())
      .filter(([, count]) => count >= 2) // Outlier in at least 2 assets
      .map(([source]) => source);

    // Find most problematic sources
    const mostProblematicSources = Array.from(sourceOutlierCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([source]) => source);

    // Find assets with most outliers
    const assetsWithMostOutliers = Object.entries(outliersByAsset)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([assetId]) => assetId);

    return {
      totalOutliers,
      outliersByAsset,
      commonOutlierSources,
      patternAnalysis: {
        mostProblematicSources,
        assetsWithMostOutliers,
        timeBasedPatterns: {} // Could be expanded for temporal analysis
      }
    };
  }

  /**
   * Export outlier detection metrics for monitoring
   */
  public exportMetrics(): {
    config: OutlierConfig;
    historicalDataSizes: Record<string, number>;
    detectionStats: {
      totalDetections: number;
      averageOutlierRate: number;
    };
    timestamp: number;
  } {
    const historicalDataSizes: Record<string, number> = {};
    this.historicalData.forEach((data, assetId) => {
      historicalDataSizes[assetId] = data.length;
    });

    return {
      config: { ...this.config },
      historicalDataSizes,
      detectionStats: {
        totalDetections: 0, // Could track this over time
        averageOutlierRate: 0 // Could calculate from historical data
      },
      timestamp: Date.now()
    };
  }
}

export default OutlierDetector;
