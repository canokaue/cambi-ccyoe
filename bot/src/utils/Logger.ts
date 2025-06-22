import winston from 'winston';
import path from 'path';
import fs from 'fs';

/**
 * Centralized logging utility for Cambi CCYOE Bot
 */
export class Logger {
  private logger: winston.Logger;
  private context: string;

  constructor(context: string = 'CambiBot') {
    this.context = context;
    this.logger = this.createLogger();
  }

  private createLogger(): winston.Logger {
    // Ensure logs directory exists
    const logsDir = path.dirname(process.env.LOG_FILE || 'logs/bot.log');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logLevel = process.env.LOG_LEVEL || 'info';
    const logFile = process.env.LOG_FILE || 'logs/bot.log';

    // Define custom format
    const customFormat = winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS'
      }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `${timestamp} [${level.toUpperCase()}] [${this.context}] ${message}${stackStr}${metaStr ? `\n${metaStr}` : ''}`;
      })
    );

    // Create transports
    const transports: winston.transport[] = [
      // Console transport
      new winston.transports.Console({
        level: logLevel,
        format: winston.format.combine(
          winston.format.colorize(),
          customFormat
        )
      }),
      
      // File transport for all logs
      new winston.transports.File({
        filename: logFile,
        level: logLevel,
        format: customFormat,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        tailable: true
      }),
      
      // Separate error log file
      new winston.transports.File({
        filename: logFile.replace('.log', '.error.log'),
        level: 'error',
        format: customFormat,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 3,
        tailable: true
      })
    ];

    return winston.createLogger({
      level: logLevel,
      transports,
      exitOnError: false,
      // Handle uncaught exceptions and rejections
      exceptionHandlers: [
        new winston.transports.File({ 
          filename: logFile.replace('.log', '.exceptions.log'),
          maxsize: 5 * 1024 * 1024,
          maxFiles: 2
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({ 
          filename: logFile.replace('.log', '.rejections.log'),
          maxsize: 5 * 1024 * 1024,
          maxFiles: 2
        })
      ]
    });
  }

  /**
   * Log error message
   */
  public error(message: string, error?: Error | any, meta?: any): void {
    if (error instanceof Error) {
      this.logger.error(message, { stack: error.stack, message: error.message, ...meta });
    } else if (error) {
      this.logger.error(message, { error, ...meta });
    } else {
      this.logger.error(message, meta);
    }
  }

  /**
   * Log warning message
   */
  public warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  /**
   * Log info message
   */
  public info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  /**
   * Log debug message
   */
  public debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }

  /**
   * Log rebalancing operation
   */
  public logRebalancing(reason: string, txHash: string, gasUsed: number, gasPrice: string): void {
    this.info('Rebalancing executed', {
      reason,
      txHash,
      gasUsed,
      gasPrice,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log yield monitoring data
   */
  public logYieldMonitoring(assetId: string, yield: number, confidence: number, deviation: number): void {
    this.debug('Yield monitoring update', {
      assetId,
      yield,
      confidence,
      deviation,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log health check results
   */
  public logHealthCheck(component: string, status: 'HEALTHY' | 'WARNING' | 'CRITICAL', details?: any): void {
    const level = status === 'HEALTHY' ? 'debug' : status === 'WARNING' ? 'warn' : 'error';
    this.logger[level](`Health check: ${component}`, {
      status,
      details,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log blockchain transaction
   */
  public logTransaction(txHash: string, action: string, gasUsed?: number, gasPrice?: string): void {
    this.info('Blockchain transaction', {
      txHash,
      action,
      gasUsed,
      gasPrice,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log alert sent
   */
  public logAlert(level: string, title: string, channel: string, success: boolean): void {
    this.info('Alert sent', {
      level,
      title,
      channel,
      success,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log performance metrics
   */
  public logPerformance(operation: string, duration: number, success: boolean, meta?: any): void {
    this.debug('Performance metric', {
      operation,
      duration,
      success,
      ...meta,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log API request
   */
  public logAPIRequest(method: string, path: string, statusCode: number, duration: number): void {
    this.debug('API request', {
      method,
      path,
      statusCode,
      duration,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log emergency action
   */
  public logEmergency(action: string, reason: string, triggeredBy: string, txHash?: string): void {
    this.error('Emergency action triggered', {
      action,
      reason,
      triggeredBy,
      txHash,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Create child logger with additional context
   */
  public child(additionalContext: string): Logger {
    const childLogger = new Logger(`${this.context}:${additionalContext}`);
    return childLogger;
  }

  /**
   * Create timed logger for measuring operation duration
   */
  public time(operation: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.logPerformance(operation, duration, true);
    };
  }

  /**
   * Log with structured data for monitoring systems
   */
  public metric(name: string, value: number, tags?: Record<string, string>): void {
    this.info('Metric', {
      metric: name,
      value,
      tags,
      timestamp: Date.now()
    });
  }

  /**
   * Set log level dynamically
   */
  public setLevel(level: string): void {
    this.logger.level = level;
    this.info(`Log level changed to ${level}`);
  }

  /**
   * Get current log level
   */
  public getLevel(): string {
    return this.logger.level;
  }

  /**
   * Close logger and cleanup resources
   */
  public close(): void {
    this.logger.end();
  }
}

export default Logger;
