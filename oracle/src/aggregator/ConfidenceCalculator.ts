import { Logger } from '../../utils/Logger';
import { Config } from '../../config/Config';

export interface ConfidenceMetrics {
  dataQuality: number; // 0-100 based on data completeness and validity
  sourceReliability: number; // 0-100 based on historical performance
  dataFreshness: number; // 0-100 based on how recent the data is
  consensus: number; // 0-100 based on agreement between sources
  volumeWeight: number; // 0-100 based on transaction volume or liquidity
}

export interface ConfidenceConfig {
  // Weights for different confidence factors (should sum to 1.0)
  weights: {
    dataQuality: number;
    sourceReliability: number;
    dataFreshness: number;
    consensus: number;
    volumeWeight: number;
  };
  
  // Decay parameters
  freshnessDecayRate: number; // How quickly confidence decays with age (per hour)
  reliabilityDecayRate: number; // How much failed requests impact reliability
  
  // Thresholds
  minConfidenceThreshold: number; // Minimum confidence to accept data
  consensusThreshold: number; // Minimum agreement between sources
  maxDataAge: number; // Maximum age in milliseconds before data is considered stale
}

export interface SourceMetrics {
  sourceId: string;
  successCount: number;
  failureCount: number;
  averageLatency: number;
  lastSuccessfulUpdate: number;
  historicalAccuracy: number; // Based on how often this source was close to consensus
  uptime: number; // Percentage uptime
}

export interface YieldDataPoint {
  source: string;
  yield: number;
  confidence: number;
  timestamp: number;
  metadata?: any;
}

/**
 * Confidence Calculator for evaluating data quality and reliability
 * Provides sophisticated confidence scoring for multi-source yield aggregation
 */
export class ConfidenceCalculator {
  private logger: Logger;
  private config: ConfidenceConfig;
  private sourceMetrics: Map<string, SourceMetrics>;
  private historicalData: Map<string, YieldDataPoint[]>; // For consensus analysis
  
  constructor(config: Config) {
    this.logger = new Logger('ConfidenceCalculator');
    this.sourceMetrics = new Map();
    this.historicalData = new Map();
    
    // Default configuration
    this.config = {
      weights: {
        dataQuality: 0.25,
        sourceReliability: 0.25,
        dataFreshness: 0.20,
        consensus: 0.20,
        volumeWeight: 0.10
      },
      freshnessDecayRate: 0.1, // 10% decay per hour
      reliabilityDecayRate: 0.05, // 5% decay per failure
      minConfidenceThreshold: 70,
      consensusThreshold: 0.85, // 85% agreement required
      maxDataAge: 3600000 // 1 hour in milliseconds
    };
    
    this.logger.info('Confidence calculator initialized', this.config);
  }

  /**
   * Calculate overall confidence for a yield data point
   */
  public calculateConfidence(
    dataPoint: YieldDataPoint,
    allDataPoints: YieldDataPoint[],
    assetId: string
  ): number {
    try {
      const metrics = this.calculateConfidenceMetrics(dataPoint, allDataPoints, assetId);
      
      // Calculate weighted average confidence
      const confidence = 
        metrics.dataQuality * this.config.weights.dataQuality +
        metrics.sourceReliability * this.config.weights.sourceReliability +
        metrics.dataFreshness * this.config.weights.dataFreshness +
        metrics.consensus * this.config.weights.consensus +
        metrics.volumeWeight * this.config.weights.volumeWeight;

      const finalConfidence = Math.round(Math.max(0, Math.min(100, confidence)));

      this.logger.debug('Calculated confidence', {
        source: dataPoint.source,
        assetId,
        confidence: finalConfidence,
        metrics
      });

      return finalConfidence;

    } catch (error) {
      this.logger.error('Failed to calculate confidence', error, {
        source: dataPoint.source,
        assetId
      });
      return 0;
    }
  }

  /**
   * Calculate individual confidence metrics
   */
  public calculateConfidenceMetrics(
    dataPoint: YieldDataPoint,
    allDataPoints: YieldDataPoint[],
    assetId: string
  ): ConfidenceMetrics {
    return {
      dataQuality: this.calculateDataQuality(dataPoint),
      sourceReliability: this.calculateSourceReliability(dataPoint.source),
      dataFreshness: this.calculateDataFreshness(dataPoint.timestamp),
      consensus: this.calculateConsensus(dataPoint, allDataPoints),
      volumeWeight: this.calculateVolumeWeight(dataPoint)
    };
  }

  /**
   * Calculate data quality score based on completeness and validity
   */
  private calculateDataQuality(dataPoint: YieldDataPoint): number {
    let score = 0;

    // Base score for having valid yield data
    if (dataPoint.yield > 0 && !isNaN(dataPoint.yield)) {
      score += 40;
    }

    // Bonus for reasonable yield range (0.1% to 50% annually)
    if (dataPoint.yield >= 10 && dataPoint.yield <= 5000) { // In basis points
      score += 20;
    }

    // Bonus for having metadata
    if (dataPoint.metadata && typeof dataPoint.metadata === 'object') {
      score += 15;
      
      // Additional bonus for rich metadata
      const metadataKeys = Object.keys(dataPoint.metadata);
      if (metadataKeys.length >= 3) {
        score += 10;
      }
      
      // Bonus for volume data
      if (dataPoint.metadata.volume || dataPoint.metadata.totalVolume) {
        score += 10;
      }
      
      // Bonus for maturity data
      if (dataPoint.metadata.maturity || dataPoint.metadata.averageMaturity) {
        score += 5;
      }
    }

    return Math.min(100, score);
  }

  /**
   * Calculate source reliability based on historical performance
   */
  private calculateSourceReliability(sourceId: string): number {
    const metrics = this.sourceMetrics.get(sourceId);
    
    if (!metrics) {
      // New source gets neutral score
      return 50;
    }

    let score = 0;

    // Success rate component (0-40 points)
    const totalRequests = metrics.successCount + metrics.failureCount;
    if (totalRequests > 0) {
      const successRate = metrics.successCount / totalRequests;
      score += successRate * 40;
    }

    // Uptime component (0-25 points)
    score += metrics.uptime * 0.25;

    // Historical accuracy component (0-20 points)
    score += metrics.historicalAccuracy * 0.20;

    // Latency component (0-15 points) - lower is better
    if (metrics.averageLatency > 0) {
      const latencyScore = Math.max(0, 15 - (metrics.averageLatency / 1000)); // Penalize high latency
      score += latencyScore;
    }

    return Math.min(100, score);
  }

  /**
   * Calculate data freshness score based on timestamp
   */
  private calculateDataFreshness(timestamp: number): number {
    const now = Date.now();
    const age = now - timestamp;

    if (age < 0) {
      // Future timestamp is suspicious
      return 0;
    }

    if (age <= 60000) {
      // Less than 1 minute old - perfect freshness
      return 100;
    }

    if (age <= 300000) {
      // Less than 5 minutes old - excellent freshness
      return 90;
    }

    if (age <= 900000) {
      // Less than 15 minutes old - good freshness
      return 80;
    }

    if (age <= 1800000) {
      // Less than 30 minutes old - acceptable freshness
      return 60;
    }

    if (age <= 3600000) {
      // Less than 1 hour old - degraded freshness
      return 40;
    }

    if (age <= 7200000) {
      // Less than 2 hours old - poor freshness
      return 20;
    }

    // Older than 2 hours - very poor freshness
    return 10;
  }

  /**
   * Calculate consensus score based on agreement with other sources
   */
  private calculateConsensus(dataPoint: YieldDataPoint, allDataPoints: YieldDataPoint[]): number {
    if (allDataPoints.length <= 1) {
      // Can't calculate consensus with only one data point
      return 50;
    }

    const otherDataPoints = allDataPoints.filter(dp => dp.source !== dataPoint.source);
    if (otherDataPoints.length === 0) {
      return 50;
    }

    // Calculate how close this data point is to the median of others
    const otherYields = otherDataPoints.map(dp => dp.yield).sort((a, b) => a - b);
    const median = this.calculateMedian(otherYields);
    
    if (median === 0) {
      return 0;
    }

    // Calculate percentage difference from median
    const percentageDiff = Math.abs(dataPoint.yield - median) / median;

    // Score based on how close to median (smaller difference = higher score)
    let consensusScore = 0;

    if (percentageDiff <= 0.02) {
      // Within 2% of median - excellent consensus
      consensusScore = 100;
    } else if (percentageDiff <= 0.05) {
      // Within 5% of median - good consensus
      consensusScore = 90;
    } else if (percentageDiff <= 0.10) {
      // Within 10% of median - acceptable consensus
      consensusScore = 70;
    } else if (percentageDiff <= 0.20) {
      // Within 20% of median - poor consensus
      consensusScore = 40;
    } else if (percentageDiff <= 0.50) {
      // Within 50% of median - very poor consensus
      consensusScore = 20;
    } else {
      // More than 50% different - no consensus
      consensusScore = 0;
    }

    return consensusScore;
  }

  /**
   * Calculate volume weight score based on transaction volume or liquidity
   */
  private calculateVolumeWeight(dataPoint: YieldDataPoint): number {
    if (!dataPoint.metadata) {
      return 50; // Neutral score if no metadata
    }

    const volume = dataPoint.metadata.volume || 
                  dataPoint.metadata.totalVolume || 
                  dataPoint.metadata.liquidityVolume ||
                  0;

    if (volume <= 0) {
      return 30; // Low score for no volume data
    }

    // Score based on volume tiers (adjust thresholds based on asset type)
    if (volume >= 100000000) {
      // Very high volume (100M+)
      return 100;
    } else if (volume >= 50000000) {
      // High volume (50M+)
      return 90;
    } else if (volume >= 10000000) {
      // Good volume (10M+)
      return 80;
    } else if (volume >= 1000000) {
      // Moderate volume (1M+)
      return 65;
    } else if (volume >= 100000) {
      // Low volume (100K+)
      return 45;
    } else {
      // Very low volume
      return 25;
    }
  }

  /**
   * Update source metrics based on performance
   */
  public updateSourceMetrics(
    sourceId: string,
    success: boolean,
    latency: number,
    accuracy?: number
  ): void {
    let metrics = this.sourceMetrics.get(sourceId);
    
    if (!metrics) {
      metrics = {
        sourceId,
        successCount: 0,
        failureCount: 0,
        averageLatency: 0,
        lastSuccessfulUpdate: 0,
        historicalAccuracy: 80, // Start with reasonable default
        uptime: 100
      };
    }

    // Update success/failure counts
    if (success) {
      metrics.successCount++;
      metrics.lastSuccessfulUpdate = Date.now();
    } else {
      metrics.failureCount++;
    }

    // Update average latency using exponential moving average
    if (success && latency > 0) {
      const alpha = 0.1; // Smoothing factor
      metrics.averageLatency = alpha * latency + (1 - alpha) * metrics.averageLatency;
    }

    // Update historical accuracy if provided
    if (accuracy !== undefined) {
      const alpha = 0.2; // Smoothing factor for accuracy
      metrics.historicalAccuracy = alpha * accuracy + (1 - alpha) * metrics.historicalAccuracy;
    }

    // Calculate uptime percentage
    const totalRequests = metrics.successCount + metrics.failureCount;
    metrics.uptime = totalRequests > 0 ? (metrics.successCount / totalRequests) * 100 : 100;

    this.sourceMetrics.set(sourceId, metrics);

    this.logger.debug('Updated source metrics', {
      sourceId,
      success,
      latency,
      metrics
    });
  }

  /**
   * Get confidence threshold for an asset
   */
  public getConfidenceThreshold(assetId: string): number {
    // Different assets might have different confidence requirements
    const thresholds: Record<string, number> = {
      'cmBTC': 75, // Higher threshold for BTC
      'cmUSD': 70, // Standard threshold for USD
      'cmBRL': 65  // Slightly lower for BRL due to market volatility
    };

    return thresholds[assetId] || this.config.minConfidenceThreshold;
  }

  /**
   * Check if data meets minimum confidence requirements
   */
  public meetsConfidenceThreshold(confidence: number, assetId: string): boolean {
    const threshold = this.getConfidenceThreshold(assetId);
    return confidence >= threshold;
  }

  /**
   * Calculate median of an array of numbers
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
   * Get source reliability metrics
   */
  public getSourceMetrics(sourceId: string): SourceMetrics | null {
    return this.sourceMetrics.get(sourceId) || null;
  }

  /**
   * Get all source metrics
   */
  public getAllSourceMetrics(): Map<string, SourceMetrics> {
    return new Map(this.sourceMetrics);
  }

  /**
   * Reset source metrics (useful for testing or when changing providers)
   */
  public resetSourceMetrics(sourceId?: string): void {
    if (sourceId) {
      this.sourceMetrics.delete(sourceId);
      this.logger.info(`Reset metrics for source: ${sourceId}`);
    } else {
      this.sourceMetrics.clear();
      this.logger.info('Reset all source metrics');
    }
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: Partial<ConfidenceConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Confidence calculator configuration updated', newConfig);
  }

  /**
   * Get current configuration
   */
  public getConfig(): ConfidenceConfig {
    return { ...this.config };
  }

  /**
   * Calculate confidence distribution statistics
   */
  public calculateConfidenceStatistics(
    dataPoints: YieldDataPoint[],
    assetId: string
  ): {
    average: number;
    median: number;
    min: number;
    max: number;
    standardDeviation: number;
    aboveThreshold: number;
  } {
    if (dataPoints.length === 0) {
      return {
        average: 0,
        median: 0,
        min: 0,
        max: 0,
        standardDeviation: 0,
        aboveThreshold: 0
      };
    }

    const confidences = dataPoints.map(dp => 
      this.calculateConfidence(dp, dataPoints, assetId)
    );

    const average = confidences.reduce((sum, conf) => sum + conf, 0) / confidences.length;
    const median = this.calculateMedian(confidences);
    const min = Math.min(...confidences);
    const max = Math.max(...confidences);
    
    // Calculate standard deviation
    const variance = confidences.reduce(
      (sum, conf) => sum + Math.pow(conf - average, 2), 
      0
    ) / confidences.length;
    const standardDeviation = Math.sqrt(variance);

    // Count how many are above threshold
    const threshold = this.getConfidenceThreshold(assetId);
    const aboveThreshold = confidences.filter(conf => conf >= threshold).length;

    return {
      average: Math.round(average * 100) / 100,
      median: Math.round(median * 100) / 100,
      min,
      max,
      standardDeviation: Math.round(standardDeviation * 100) / 100,
      aboveThreshold
    };
  }

  /**
   * Export metrics for monitoring and analysis
   */
  public exportMetrics(): {
    sourceMetrics: Record<string, SourceMetrics>;
    config: ConfidenceConfig;
    timestamp: number;
  } {
    const sourceMetricsObj: Record<string, SourceMetrics> = {};
    this.sourceMetrics.forEach((metrics, sourceId) => {
      sourceMetricsObj[sourceId] = { ...metrics };
    });

    return {
      sourceMetrics: sourceMetricsObj,
      config: { ...this.config },
      timestamp: Date.now()
    };
  }
}

export default ConfidenceCalculator;
