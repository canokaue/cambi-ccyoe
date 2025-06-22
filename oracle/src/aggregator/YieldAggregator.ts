import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';

export interface YieldDataPoint {
  source: string;
  yield: number;
  confidence: number;
  timestamp: number;
  metadata?: any;
}

export interface AggregatedYield {
  assetId: string;
  yield: number;
  confidence: number;
  timestamp: number;
  sources: string[];
  weights: number[];
  metadata: {
    rawData: YieldDataPoint[];
    weightedAverage: number;
    standardDeviation: number;
    outliers: YieldDataPoint[];
  };
}

export interface AggregationConfig {
  outlierThreshold: number; // Standard deviations for outlier detection
  minSources: number; // Minimum number of sources required
  maxAge: number; // Maximum age of data points in seconds
  confidenceDecay: number; // How much confidence decays with age
}

/**
 * Yield Aggregator for combining multiple data sources into reliable yield estimates
 * Similar to MakerDAO's oracle aggregation but specialized for RWA yields
 */
export class YieldAggregator {
  private logger: Logger;
  private config: Config;
  private aggregationConfig: AggregationConfig;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger('YieldAggregator');
    this.aggregationConfig = {
      outlierThreshold: 2.0, // 2 standard deviations
      minSources: 2,
      maxAge: 7200, // 2 hours
      confidenceDecay: 0.1 // 10% confidence loss per hour
    };
  }

  /**
   * Aggregate yield data from multiple sources
   */
  public aggregateYieldData(assetId: string, rawData: YieldDataPoint[]): AggregatedYield | null {
    try {
      this.logger.debug(`Aggregating yield data for ${assetId}`, { dataPoints: rawData.length });

      // Filter out stale data
      const freshData = this.filterFreshData(rawData);
      
      if (freshData.length < this.aggregationConfig.minSources) {
        this.logger.warn(`Insufficient fresh data sources for ${assetId}`, {
          required: this.aggregationConfig.minSources,
          available: freshData.length
        });
        return null;
      }

      // Apply age-based confidence decay
      const ageAdjustedData = this.applyConfidenceDecay(freshData);

      // Detect and remove outliers
      const { cleanData, outliers } = this.detectOutliers(ageAdjustedData);

      if (cleanData.length < this.aggregationConfig.minSources) {
        this.logger.warn(`Insufficient data after outlier removal for ${assetId}`, {
          originalCount: freshData.length,
          outlierCount: outliers.length,
          remainingCount: cleanData.length
        });
        return null;
      }

      // Get asset configuration for weights
      const assetConfig = this.config.getAssetConfig(assetId);
      if (!assetConfig) {
        this.logger.error(`No configuration found for asset ${assetId}`);
        return null;
      }

      // Calculate weighted average
      const { weightedYield, aggregateConfidence } = this.calculateWeightedAverage(
        cleanData,
        assetConfig.sources,
        assetConfig.weights
      );

      // Calculate metadata
      const yields = cleanData.map(d => d.yield);
      const standardDeviation = this.calculateStandardDeviation(yields);

      const result: AggregatedYield = {
        assetId,
        yield: Math.round(weightedYield),
        confidence: Math.round(aggregateConfidence),
        timestamp: Date.now(),
        sources: cleanData.map(d => d.source),
        weights: this.getEffectiveWeights(cleanData, assetConfig.sources, assetConfig.weights),
        metadata: {
          rawData: freshData,
          weightedAverage: weightedYield,
          standardDeviation,
          outliers
        }
      };

      this.logger.logAggregation(
        assetId,
        result.sources,
        result.yield,
        result.confidence
      );

      return result;

    } catch (error) {
      this.logger.error(`Error aggregating yield data for ${assetId}`, error);
      return null;
    }
  }

  /**
   * Filter out stale data based on timestamp
   */
  private filterFreshData(data: YieldDataPoint[]): YieldDataPoint[] {
    const now = Date.now();
    const maxAge = this.aggregationConfig.maxAge * 1000; // Convert to milliseconds

    return data.filter(point => {
      const age = now - point.timestamp;
      return age <= maxAge;
    });
  }

  /**
   * Apply confidence decay based on data age
   */
  private applyConfidenceDecay(data: YieldDataPoint[]): YieldDataPoint[] {
    const now = Date.now();
    const decayRate = this.aggregationConfig.confidenceDecay;

    return data.map(point => {
      const ageHours = (now - point.timestamp) / (1000 * 3600);
      const decayFactor = Math.max(0, 1 - (decayRate * ageHours));
      
      return {
        ...point,
        confidence: point.confidence * decayFactor
      };
    });
  }

  /**
   * Detect and remove outliers using z-score method
   */
  private detectOutliers(data: YieldDataPoint[]): { cleanData: YieldDataPoint[], outliers: YieldDataPoint[] } {
    if (data.length <= 2) {
      return { cleanData: data, outliers: [] };
    }

    const yields = data.map(d => d.yield);
    const mean = this.calculateMean(yields);
    const stdDev = this.calculateStandardDeviation(yields);

    const threshold = this.aggregationConfig.outlierThreshold;
    const cleanData: YieldDataPoint[] = [];
    const outliers: YieldDataPoint[] = [];

    data.forEach(point => {
      const zScore = Math.abs((point.yield - mean) / stdDev);
      
      if (zScore <= threshold) {
        cleanData.push(point);
      } else {
        outliers.push(point);
        this.logger.warn(`Outlier detected for source ${point.source}`, {
          yield: point.yield,
          mean,
          stdDev,
          zScore,
          threshold
        });
      }
    });

    return { cleanData, outliers };
  }

  /**
   * Calculate weighted average of yields
   */
  private calculateWeightedAverage(
    data: YieldDataPoint[],
    configuredSources: string[],
    configuredWeights: number[]
  ): { weightedYield: number, aggregateConfidence: number } {
    
    // Create a map of source to weight
    const sourceWeights = new Map<string, number>();
    configuredSources.forEach((source, index) => {
      sourceWeights.set(source, configuredWeights[index] || 0);
    });

    // Calculate effective weights for available sources
    let totalWeight = 0;
    let weightedSum = 0;
    let confidenceSum = 0;

    data.forEach(point => {
      const weight = sourceWeights.get(point.source) || 0;
      if (weight > 0) {
        totalWeight += weight;
        weightedSum += point.yield * weight;
        confidenceSum += point.confidence * weight;
      }
    });

    if (totalWeight === 0) {
      // Fallback to equal weights if no configured weights match
      const equalWeight = 1 / data.length;
      data.forEach(point => {
        totalWeight += equalWeight;
        weightedSum += point.yield * equalWeight;
        confidenceSum += point.confidence * equalWeight;
      });
    }

    const weightedYield = weightedSum / totalWeight;
    const aggregateConfidence = confidenceSum / totalWeight;

    return { weightedYield, aggregateConfidence };
  }

  /**
   * Get effective weights used in calculation
   */
  private getEffectiveWeights(
    data: YieldDataPoint[],
    configuredSources: string[],
    configuredWeights: number[]
  ): number[] {
    const sourceWeights = new Map<string, number>();
    configuredSources.forEach((source, index) => {
      sourceWeights.set(source, configuredWeights[index] || 0);
    });

    let totalWeight = 0;
    const effectiveWeights: number[] = [];

    data.forEach(point => {
      const weight = sourceWeights.get(point.source) || (1 / data.length);
      effectiveWeights.push(weight);
      totalWeight += weight;
    });

    // Normalize weights to sum to 1
    return effectiveWeights.map(w => w / totalWeight);
  }

  /**
   * Calculate mean of an array of numbers
   */
  private calculateMean(values: number[]): number {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Calculate standard deviation of an array of numbers
   */
  private calculateStandardDeviation(values: number[]): number {
    const mean = this.calculateMean(values);
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const avgSquaredDiff = this.calculateMean(squaredDiffs);
    return Math.sqrt(avgSquaredDiff);
  }

  /**
   * Validate aggregated result against circuit breaker conditions
   */
  public validateResult(result: AggregatedYield): { isValid: boolean, reason?: string } {
    const assetConfig = this.config.getAssetConfig(result.assetId);
    if (!assetConfig) {
      return { isValid: false, reason: 'No asset configuration found' };
    }

    // Check minimum confidence threshold
    if (result.confidence < assetConfig.minConfidence) {
      return {
        isValid: false,
        reason: `Confidence ${result.confidence}% below minimum ${assetConfig.minConfidence}%`
      };
    }

    // Check deviation from target yield
    const deviationPercent = Math.abs(result.yield - assetConfig.targetYield) / assetConfig.targetYield;
    if (deviationPercent > assetConfig.deviationThreshold) {
      this.logger.logCircuitBreaker(
        result.assetId,
        'Yield deviation exceeded threshold',
        assetConfig.targetYield,
        result.yield
      );
      
      return {
        isValid: false,
        reason: `Yield deviation ${(deviationPercent * 100).toFixed(2)}% exceeds threshold ${(assetConfig.deviationThreshold * 100).toFixed(2)}%`
      };
    }

    // Check for minimum data freshness
    const oldestDataAge = Date.now() - Math.min(...result.metadata.rawData.map(d => d.timestamp));
    if (oldestDataAge > assetConfig.heartbeat * 1000) {
      return {
        isValid: false,
        reason: `Data too stale: ${Math.round(oldestDataAge / 1000)}s > ${assetConfig.heartbeat}s`
      };
    }

    return { isValid: true };
  }

  /**
   * Update aggregation configuration
   */
  public updateAggregationConfig(config: Partial<AggregationConfig>): void {
    this.aggregationConfig = { ...this.aggregationConfig, ...config };
    this.logger.info('Aggregation configuration updated', this.aggregationConfig);
  }

  /**
   * Get current aggregation configuration
   */
  public getAggregationConfig(): AggregationConfig {
    return { ...this.aggregationConfig };
  }
}

export default YieldAggregator;
