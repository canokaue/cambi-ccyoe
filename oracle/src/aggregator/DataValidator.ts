import { Logger } from '../../utils/Logger';
import { Config } from '../../config/Config';

export interface ValidationRule {
  name: string;
  description: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  validator: (data: any, context?: ValidationContext) => ValidationResult;
}

export interface ValidationContext {
  assetId: string;
  source: string;
  timestamp: number;
  expectedRange?: {
    min: number;
    max: number;
  };
  historicalData?: any[];
  marketConditions?: any;
}

export interface ValidationResult {
  isValid: boolean;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  code: string;
  details?: any;
  suggestion?: string;
}

export interface ValidationConfig {
  // Yield validation ranges (in basis points)
  yieldRanges: Record<string, { min: number; max: number; warning: number }>;
  
  // Data quality requirements
  requiredFields: string[];
  optionalFields: string[];
  
  // Temporal validation
  maxDataAge: number; // milliseconds
  futureTimestampTolerance: number; // milliseconds
  
  // Value validation
  precisionLimits: {
    maxDecimalPlaces: number;
    maxSignificantDigits: number;
  };
  
  // Cross-validation
  enableCrossValidation: boolean;
  crossValidationThreshold: number; // percentage difference
  
  // Metadata validation
  metadataValidation: {
    volumeRequired: boolean;
    maturityRequired: boolean;
    confidenceRequired: boolean;
  };
}

export interface YieldDataPoint {
  source: string;
  yield: number;
  confidence: number;
  timestamp: number;
  metadata?: any;
}

export interface ValidationReport {
  overallValid: boolean;
  totalChecks: number;
  errors: ValidationResult[];
  warnings: ValidationResult[];
  infos: ValidationResult[];
  validatedData: YieldDataPoint;
  score: number; // 0-100 overall validation score
  summary: string;
}

/**
 * Data Validator for comprehensive yield data validation
 * Ensures data quality, consistency, and business rule compliance
 */
export class DataValidator {
  private logger: Logger;
  private config: ValidationConfig;
  private validationRules: ValidationRule[];

  constructor(config: Config) {
    this.logger = new Logger('DataValidator');
    
    // Default validation configuration
    this.config = {
      yieldRanges: {
        'cmBTC': { min: 50, max: 2000, warning: 1500 }, // 0.5% to 20%, warning at 15%
        'cmUSD': { min: 100, max: 3000, warning: 2500 }, // 1% to 30%, warning at 25%
        'cmBRL': { min: 200, max: 5000, warning: 4000 } // 2% to 50%, warning at 40%
      },
      requiredFields: ['yield', 'confidence', 'timestamp', 'source'],
      optionalFields: ['metadata'],
      maxDataAge: 7200000, // 2 hours
      futureTimestampTolerance: 300000, // 5 minutes
      precisionLimits: {
        maxDecimalPlaces: 4,
        maxSignificantDigits: 8
      },
      enableCrossValidation: true,
      crossValidationThreshold: 0.30, // 30% difference
      metadataValidation: {
        volumeRequired: false,
        maturityRequired: false,
        confidenceRequired: true
      }
    };

    this.validationRules = this.initializeValidationRules();
    
    this.logger.info('Data validator initialized', {
      rulesCount: this.validationRules.length,
      config: this.config
    });
  }

  /**
   * Validate a single yield data point
   */
  public validateYieldData(
    data: YieldDataPoint,
    context: ValidationContext
  ): ValidationReport {
    try {
      const results: ValidationResult[] = [];
      let overallValid = true;
      let score = 100;

      // Run all validation rules
      for (const rule of this.validationRules) {
        try {
          const result = rule.validator(data, context);
          results.push(result);

          if (!result.isValid) {
            if (result.severity === 'ERROR') {
              overallValid = false;
              score -= 20;
            } else if (result.severity === 'WARNING') {
              score -= 10;
            } else {
              score -= 2;
            }
          }
        } catch (error) {
          this.logger.error(`Validation rule ${rule.name} failed`, error);
          results.push({
            isValid: false,
            severity: 'ERROR',
            message: `Validation rule ${rule.name} execution failed`,
            code: 'RULE_EXECUTION_ERROR',
            details: { error: error instanceof Error ? error.message : 'Unknown error' }
          });
          overallValid = false;
          score -= 15;
        }
      }

      // Categorize results
      const errors = results.filter(r => r.severity === 'ERROR');
      const warnings = results.filter(r => r.severity === 'WARNING');
      const infos = results.filter(r => r.severity === 'INFO');

      // Generate summary
      const summary = this.generateValidationSummary(errors, warnings, infos);

      // Ensure score doesn't go below 0
      score = Math.max(0, score);

      const report: ValidationReport = {
        overallValid,
        totalChecks: results.length,
        errors,
        warnings,
        infos,
        validatedData: data,
        score,
        summary
      };

      this.logger.debug('Validation completed', {
        source: data.source,
        assetId: context.assetId,
        valid: overallValid,
        score,
        errorsCount: errors.length,
        warningsCount: warnings.length
      });

      return report;

    } catch (error) {
      this.logger.error('Data validation failed', error, {
        source: data.source,
        assetId: context.assetId
      });

      return {
        overallValid: false,
        totalChecks: 0,
        errors: [{
          isValid: false,
          severity: 'ERROR',
          message: 'Validation process failed',
          code: 'VALIDATION_PROCESS_ERROR',
          details: { error: error instanceof Error ? error.message : 'Unknown error' }
        }],
        warnings: [],
        infos: [],
        validatedData: data,
        score: 0,
        summary: 'Validation process encountered an error'
      };
    }
  }

  /**
   * Initialize all validation rules
   */
  private initializeValidationRules(): ValidationRule[] {
    return [
      // Required Fields Validation
      {
        name: 'RequiredFields',
        description: 'Check if all required fields are present',
        severity: 'ERROR',
        validator: (data: any) => this.validateRequiredFields(data)
      },

      // Yield Range Validation
      {
        name: 'YieldRange',
        description: 'Validate yield is within acceptable range',
        severity: 'ERROR',
        validator: (data: any, context?: ValidationContext) => this.validateYieldRange(data, context)
      },

      // Timestamp Validation
      {
        name: 'TimestampValidation',
        description: 'Validate timestamp is reasonable and not too old',
        severity: 'WARNING',
        validator: (data: any) => this.validateTimestamp(data)
      },

      // Confidence Score Validation
      {
        name: 'ConfidenceScore',
        description: 'Validate confidence score is within 0-100 range',
        severity: 'WARNING',
        validator: (data: any) => this.validateConfidence(data)
      },

      // Data Type Validation
      {
        name: 'DataTypes',
        description: 'Validate data types are correct',
        severity: 'ERROR',
        validator: (data: any) => this.validateDataTypes(data)
      },

      // Precision Validation
      {
        name: 'PrecisionLimits',
        description: 'Validate numeric precision is reasonable',
        severity: 'WARNING',
        validator: (data: any) => this.validatePrecision(data)
      },

      // Metadata Validation
      {
        name: 'MetadataValidation',
        description: 'Validate metadata structure and content',
        severity: 'INFO',
        validator: (data: any) => this.validateMetadata(data)
      },

      // Business Logic Validation
      {
        name: 'BusinessLogic',
        description: 'Apply business-specific validation rules',
        severity: 'WARNING',
        validator: (data: any, context?: ValidationContext) => this.validateBusinessLogic(data, context)
      },

      // Consistency Validation
      {
        name: 'ConsistencyCheck',
        description: 'Check internal data consistency',
        severity: 'WARNING',
        validator: (data: any) => this.validateConsistency(data)
      }
    ];
  }

  /**
   * Validate required fields are present
   */
  private validateRequiredFields(data: any): ValidationResult {
    const missingFields = this.config.requiredFields.filter(field => {
      return data[field] === undefined || data[field] === null;
    });

    if (missingFields.length > 0) {
      return {
        isValid: false,
        severity: 'ERROR',
        message: `Missing required fields: ${missingFields.join(', ')}`,
        code: 'MISSING_REQUIRED_FIELDS',
        details: { missingFields },
        suggestion: 'Ensure all required fields are provided by the data source'
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'All required fields present',
      code: 'REQUIRED_FIELDS_OK'
    };
  }

  /**
   * Validate yield is within acceptable range
   */
  private validateYieldRange(data: any, context?: ValidationContext): ValidationResult {
    if (typeof data.yield !== 'number' || isNaN(data.yield)) {
      return {
        isValid: false,
        severity: 'ERROR',
        message: 'Yield must be a valid number',
        code: 'INVALID_YIELD_TYPE'
      };
    }

    const assetId = context?.assetId || 'default';
    const range = this.config.yieldRanges[assetId] || this.config.yieldRanges['cmUSD'];

    if (data.yield < range.min) {
      return {
        isValid: false,
        severity: 'ERROR',
        message: `Yield ${data.yield} is below minimum ${range.min} basis points`,
        code: 'YIELD_TOO_LOW',
        details: { yield: data.yield, min: range.min, max: range.max }
      };
    }

    if (data.yield > range.max) {
      return {
        isValid: false,
        severity: 'ERROR',
        message: `Yield ${data.yield} exceeds maximum ${range.max} basis points`,
        code: 'YIELD_TOO_HIGH',
        details: { yield: data.yield, min: range.min, max: range.max }
      };
    }

    if (data.yield > range.warning) {
      return {
        isValid: true,
        severity: 'WARNING',
        message: `Yield ${data.yield} is unusually high (above ${range.warning} basis points)`,
        code: 'YIELD_HIGH_WARNING',
        details: { yield: data.yield, warning: range.warning }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'Yield within acceptable range',
      code: 'YIELD_RANGE_OK'
    };
  }

  /**
   * Validate timestamp is reasonable
   */
  private validateTimestamp(data: any): ValidationResult {
    if (typeof data.timestamp !== 'number' || isNaN(data.timestamp)) {
      return {
        isValid: false,
        severity: 'ERROR',
        message: 'Timestamp must be a valid number',
        code: 'INVALID_TIMESTAMP_TYPE'
      };
    }

    const now = Date.now();
    const age = now - data.timestamp;

    // Check for future timestamps
    if (age < -this.config.futureTimestampTolerance) {
      return {
        isValid: false,
        severity: 'WARNING',
        message: `Timestamp is in the future by ${Math.abs(age) / 1000} seconds`,
        code: 'FUTURE_TIMESTAMP',
        details: { timestamp: data.timestamp, age }
      };
    }

    // Check for stale data
    if (age > this.config.maxDataAge) {
      return {
        isValid: false,
        severity: 'WARNING',
        message: `Data is too old: ${age / 1000} seconds (max: ${this.config.maxDataAge / 1000})`,
        code: 'STALE_DATA',
        details: { timestamp: data.timestamp, age, maxAge: this.config.maxDataAge }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'Timestamp is valid and fresh',
      code: 'TIMESTAMP_OK'
    };
  }

  /**
   * Validate confidence score
   */
  private validateConfidence(data: any): ValidationResult {
    if (typeof data.confidence !== 'number' || isNaN(data.confidence)) {
      return {
        isValid: false,
        severity: 'WARNING',
        message: 'Confidence must be a valid number',
        code: 'INVALID_CONFIDENCE_TYPE'
      };
    }

    if (data.confidence < 0 || data.confidence > 100) {
      return {
        isValid: false,
        severity: 'WARNING',
        message: `Confidence ${data.confidence} must be between 0 and 100`,
        code: 'CONFIDENCE_OUT_OF_RANGE',
        details: { confidence: data.confidence }
      };
    }

    if (data.confidence < 30) {
      return {
        isValid: true,
        severity: 'WARNING',
        message: `Low confidence score: ${data.confidence}`,
        code: 'LOW_CONFIDENCE',
        details: { confidence: data.confidence }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'Confidence score is valid',
      code: 'CONFIDENCE_OK'
    };
  }

  /**
   * Validate data types
   */
  private validateDataTypes(data: any): ValidationResult {
    const typeErrors: string[] = [];

    if (typeof data.yield !== 'number') {
      typeErrors.push('yield must be number');
    }

    if (typeof data.confidence !== 'number') {
      typeErrors.push('confidence must be number');
    }

    if (typeof data.timestamp !== 'number') {
      typeErrors.push('timestamp must be number');
    }

    if (typeof data.source !== 'string') {
      typeErrors.push('source must be string');
    }

    if (typeErrors.length > 0) {
      return {
        isValid: false,
        severity: 'ERROR',
        message: `Data type errors: ${typeErrors.join(', ')}`,
        code: 'INVALID_DATA_TYPES',
        details: { typeErrors }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'All data types are correct',
      code: 'DATA_TYPES_OK'
    };
  }

  /**
   * Validate numeric precision
   */
  private validatePrecision(data: any): ValidationResult {
    if (typeof data.yield !== 'number') {
      return {
        isValid: true,
        severity: 'INFO',
        message: 'Skipping precision check for non-numeric yield',
        code: 'PRECISION_SKIP'
      };
    }

    const yieldStr = data.yield.toString();
    const decimalPart = yieldStr.split('.')[1];
    
    if (decimalPart && decimalPart.length > this.config.precisionLimits.maxDecimalPlaces) {
      return {
        isValid: false,
        severity: 'WARNING',
        message: `Yield has too many decimal places: ${decimalPart.length} (max: ${this.config.precisionLimits.maxDecimalPlaces})`,
        code: 'EXCESSIVE_DECIMAL_PLACES',
        details: { decimalPlaces: decimalPart.length, maxAllowed: this.config.precisionLimits.maxDecimalPlaces }
      };
    }

    const significantDigits = yieldStr.replace(/[^0-9]/g, '').replace(/^0+/, '').length;
    if (significantDigits > this.config.precisionLimits.maxSignificantDigits) {
      return {
        isValid: false,
        severity: 'WARNING',
        message: `Yield has too many significant digits: ${significantDigits} (max: ${this.config.precisionLimits.maxSignificantDigits})`,
        code: 'EXCESSIVE_SIGNIFICANT_DIGITS',
        details: { significantDigits, maxAllowed: this.config.precisionLimits.maxSignificantDigits }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'Numeric precision is acceptable',
      code: 'PRECISION_OK'
    };
  }

  /**
   * Validate metadata structure and content
   */
  private validateMetadata(data: any): ValidationResult {
    if (!data.metadata) {
      if (this.config.metadataValidation.volumeRequired || 
          this.config.metadataValidation.maturityRequired) {
        return {
          isValid: false,
          severity: 'WARNING',
          message: 'Metadata is missing but contains required fields',
          code: 'MISSING_METADATA'
        };
      }
      
      return {
        isValid: true,
        severity: 'INFO',
        message: 'Metadata is optional and not provided',
        code: 'METADATA_OPTIONAL'
      };
    }

    const issues: string[] = [];

    // Check for volume data if required
    if (this.config.metadataValidation.volumeRequired) {
      const volume = data.metadata.volume || data.metadata.totalVolume;
      if (!volume || typeof volume !== 'number' || volume <= 0) {
        issues.push('Volume data required but missing or invalid');
      }
    }

    // Check for maturity data if required
    if (this.config.metadataValidation.maturityRequired) {
      const maturity = data.metadata.maturity || data.metadata.averageMaturity;
      if (!maturity || typeof maturity !== 'number' || maturity <= 0) {
        issues.push('Maturity data required but missing or invalid');
      }
    }

    if (issues.length > 0) {
      return {
        isValid: false,
        severity: 'WARNING',
        message: `Metadata validation issues: ${issues.join(', ')}`,
        code: 'METADATA_VALIDATION_FAILED',
        details: { issues }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'Metadata is valid',
      code: 'METADATA_OK'
    };
  }

  /**
   * Apply business-specific validation rules
   */
  private validateBusinessLogic(data: any, context?: ValidationContext): ValidationResult {
    const issues: string[] = [];

    // Check for suspicious yield-confidence combinations
    if (data.yield > 3000 && data.confidence > 90) { // >30% yield with >90% confidence
      issues.push('Unusually high yield with very high confidence is suspicious');
    }

    // Check for low yields with high confidence (might indicate data error)
    if (data.yield < 100 && data.confidence > 95) { // <1% yield with >95% confidence
      issues.push('Very low yield with extremely high confidence may indicate data issue');
    }

    // Asset-specific business rules
    if (context?.assetId) {
      switch (context.assetId) {
        case 'cmBTC':
          if (data.yield > 1500) { // >15% for BTC is unusual
            issues.push('BTC yields above 15% are extremely unusual and should be verified');
          }
          break;
        case 'cmBRL':
          if (data.yield < 500) { // <5% for BRL is unusual given Brazil's high rates
            issues.push('BRL yields below 5% are unusual given typical Brazilian interest rates');
          }
          break;
      }
    }

    // Source-specific rules
    if (data.source === 'bacen' && data.yield > 2000) { // Central bank data shouldn't be >20%
      issues.push('Central bank data with >20% yield is highly unusual');
    }

    if (issues.length > 0) {
      return {
        isValid: true, // Business logic issues are warnings, not errors
        severity: 'WARNING',
        message: `Business logic concerns: ${issues.join(', ')}`,
        code: 'BUSINESS_LOGIC_WARNING',
        details: { issues }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'Business logic validation passed',
      code: 'BUSINESS_LOGIC_OK'
    };
  }

  /**
   * Check internal data consistency
   */
  private validateConsistency(data: any): ValidationResult {
    const issues: string[] = [];

    // Check timestamp vs confidence relationship
    const dataAge = Date.now() - data.timestamp;
    if (dataAge > 3600000 && data.confidence > 90) { // >1 hour old but >90% confidence
      issues.push('High confidence for old data may be inconsistent');
    }

    // Check metadata consistency
    if (data.metadata) {
      // Volume vs confidence consistency
      const volume = data.metadata.volume || data.metadata.totalVolume;
      if (volume && volume < 10000 && data.confidence > 85) {
        issues.push('High confidence with very low volume may be inconsistent');
      }

      // Maturity vs yield relationship
      const maturity = data.metadata.maturity || data.metadata.averageMaturity;
      if (maturity && maturity < 30 && data.yield > 2000) {
        issues.push('Very short maturity with high yield may indicate data inconsistency');
      }
    }

    if (issues.length > 0) {
      return {
        isValid: true,
        severity: 'WARNING',
        message: `Consistency concerns: ${issues.join(', ')}`,
        code: 'CONSISTENCY_WARNING',
        details: { issues }
      };
    }

    return {
      isValid: true,
      severity: 'INFO',
      message: 'Data consistency check passed',
      code: 'CONSISTENCY_OK'
    };
  }

  /**
   * Generate validation summary
   */
  private generateValidationSummary(
    errors: ValidationResult[],
    warnings: ValidationResult[],
    infos: ValidationResult[]
  ): string {
    if (errors.length > 0) {
      return `Validation failed with ${errors.length} error(s) and ${warnings.length} warning(s)`;
    }
    
    if (warnings.length > 0) {
      return `Validation passed with ${warnings.length} warning(s)`;
    }
    
    return 'Validation passed successfully';
  }

  /**
   * Validate multiple data points and cross-validate
   */
  public validateMultipleDataPoints(
    dataPoints: YieldDataPoint[],
    assetId: string
  ): {
    individualReports: ValidationReport[];
    crossValidationResults: ValidationResult[];
    overallValid: boolean;
    averageScore: number;
  } {
    const individualReports: ValidationReport[] = [];
    const crossValidationResults: ValidationResult[] = [];

    // Validate each data point individually
    for (const dataPoint of dataPoints) {
      const context: ValidationContext = {
        assetId,
        source: dataPoint.source,
        timestamp: Date.now()
      };
      
      const report = this.validateYieldData(dataPoint, context);
      individualReports.push(report);
    }

    // Cross-validation between data points
    if (this.config.enableCrossValidation && dataPoints.length > 1) {
      const crossValidation = this.performCrossValidation(dataPoints, assetId);
      crossValidationResults.push(...crossValidation);
    }

    // Calculate overall results
    const overallValid = individualReports.every(r => r.overallValid) && 
                        !crossValidationResults.some(r => r.severity === 'ERROR');
    
    const averageScore = individualReports.reduce((sum, r) => sum + r.score, 0) / individualReports.length;

    return {
      individualReports,
      crossValidationResults,
      overallValid,
      averageScore
    };
  }

  /**
   * Perform cross-validation between data points
   */
  private performCrossValidation(dataPoints: YieldDataPoint[], assetId: string): ValidationResult[] {
    const results: ValidationResult[] = [];
    
    if (dataPoints.length < 2) {
      return results;
    }

    const yields = dataPoints.map(dp => dp.yield);
    const mean = yields.reduce((sum, y) => sum + y, 0) / yields.length;
    
    // Check for outliers based on cross-validation threshold
    for (const dataPoint of dataPoints) {
      const deviation = Math.abs(dataPoint.yield - mean) / mean;
      
      if (deviation > this.config.crossValidationThreshold) {
        results.push({
          isValid: false,
          severity: 'WARNING',
          message: `Data point from ${dataPoint.source} deviates ${(deviation * 100).toFixed(1)}% from cross-validation average`,
          code: 'CROSS_VALIDATION_DEVIATION',
          details: {
            source: dataPoint.source,
            yield: dataPoint.yield,
            average: mean,
            deviation: deviation,
            threshold: this.config.crossValidationThreshold
          }
        });
      }
    }

    if (results.length === 0) {
      results.push({
        isValid: true,
        severity: 'INFO',
        message: 'Cross-validation passed - all data points are consistent',
        code: 'CROSS_VALIDATION_OK'
      });
    }

    return results;
  }

  /**
   * Get validation configuration
   */
  public getConfig(): ValidationConfig {
    return { ...this.config };
  }

  /**
   * Update validation configuration
   */
  public updateConfig(newConfig: Partial<ValidationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Validation configuration updated', newConfig);
  }

  /**
   * Add custom validation rule
   */
  public addValidationRule(rule: ValidationRule): void {
    this.validationRules.push(rule);
    this.logger.info(`Added custom validation rule: ${rule.name}`);
  }

  /**
   * Remove validation rule by name
   */
  public removeValidationRule(ruleName: string): boolean {
    const initialLength = this.validationRules.length;
    this.validationRules = this.validationRules.filter(rule => rule.name !== ruleName);
    
    if (this.validationRules.length < initialLength) {
      this.logger.info(`Removed validation rule: ${ruleName}`);
      return true;
    }
    
    return false;
  }

  /**
   * Get all validation rules
   */
  public getValidationRules(): ValidationRule[] {
    return [...this.validationRules];
  }
}

export default DataValidator;
