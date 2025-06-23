import { Logger } from '../../utils/Logger';
import { Config } from '../../config/Config';
import cron from 'node-cron';

export interface HealthCheckConfig {
  intervals: {
    dataProviders: number; // milliseconds
    oracle: number;
    blockchain: number;
    aggregation: number;
  };
  thresholds: {
    maxLatency: number; // milliseconds
    minConfidence: number; // percentage
    maxDataAge: number; // milliseconds
    minSuccessRate: number; // percentage
  };
  alerts: {
    enableDiscord: boolean;
    enableSlack: boolean;
    enableEmail: boolean;
    criticalOnly: boolean;
  };
}

export interface ComponentHealth {
  component: string;
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'CRITICAL';
  lastCheck: number;
  uptime: number; // percentage
  latency: number; // milliseconds
  errorRate: number; // percentage
  details: Record<string, any>;
  issues: string[];
}

export interface SystemHealth {
  overall: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'CRITICAL';
  timestamp: number;
  uptime: number;
  components: ComponentHealth[];
  alerts: HealthAlert[];
  metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageLatency: number;
    dataFreshness: number;
  };
}

export interface HealthAlert {
  id: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  component: string;
  message: string;
  timestamp: number;
  acknowledged: boolean;
  resolvedAt?: number;
  metadata?: any;
}

/**
 * Health Monitor for comprehensive system monitoring
 * Tracks all oracle components and generates alerts
 */
export class HealthMonitor {
  private logger: Logger;
  private config: HealthCheckConfig;
  private systemStartTime: number;
  private healthHistory: Map<string, ComponentHealth[]>;
  private activeAlerts: Map<string, HealthAlert>;
  private healthCheckers: Map<string, () => Promise<ComponentHealth>>;
  private isRunning: boolean = false;

  constructor(config: Config) {
    this.logger = new Logger('HealthMonitor');
    this.systemStartTime = Date.now();
    this.healthHistory = new Map();
    this.activeAlerts = new Map();
    this.healthCheckers = new Map();

    // Default health check configuration
    this.config = {
      intervals: {
        dataProviders: 60000, // 1 minute
        oracle: 120000, // 2 minutes
        blockchain: 180000, // 3 minutes
        aggregation: 90000 // 1.5 minutes
      },
      thresholds: {
        maxLatency: 30000, // 30 seconds
        minConfidence: 70, // 70%
        maxDataAge: 600000, // 10 minutes
        minSuccessRate: 90 // 90%
      },
      alerts: {
        enableDiscord: config.getEnvVar('DISCORD_WEBHOOK_URL') !== '',
        enableSlack: config.getEnvVar('SLACK_WEBHOOK_URL') !== '',
        enableEmail: config.getEnvVar('ALERT_EMAIL') !== '',
        criticalOnly: false
      }
    };

    this.logger.info('Health monitor initialized', this.config);
  }

  /**
   * Start the health monitoring system
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Health monitor is already running');
      return;
    }

    this.logger.info('Starting health monitor...');

    try {
      // Schedule health checks
      this.scheduleHealthChecks();
      
      // Start monitoring
      this.isRunning = true;
      
      // Initial health check
      await this.performSystemHealthCheck();

      this.logger.info('Health monitor started successfully');
    } catch (error) {
      this.logger.error('Failed to start health monitor', error);
      throw error;
    }
  }

  /**
   * Stop the health monitoring system
   */
  public async stop(): Promise<void> {
    this.logger.info('Stopping health monitor...');
    this.isRunning = false;
  }

  /**
   * Schedule periodic health checks
   */
  private scheduleHealthChecks(): void {
    // Data providers health check every minute
    cron.schedule('* * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        await this.checkDataProvidersHealth();
      } catch (error) {
        this.logger.error('Data providers health check failed', error);
      }
    });

    // Oracle service health check every 2 minutes
    cron.schedule('*/2 * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        await this.checkOracleHealth();
      } catch (error) {
        this.logger.error('Oracle health check failed', error);
      }
    });

    // Blockchain connectivity check every 3 minutes
    cron.schedule('*/3 * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        await this.checkBlockchainHealth();
      } catch (error) {
        this.logger.error('Blockchain health check failed', error);
      }
    });

    // Aggregation system check every 1.5 minutes
    cron.schedule('*/1 * * * *', async () => {
      if (!this.isRunning) return;
      
      // Only run on odd minutes for 1.5 minute interval simulation
      const minute = new Date().getMinutes();
      if (minute % 3 === 0 || minute % 3 === 1) return;
      
      try {
        await this.checkAggregationHealth();
      } catch (error) {
        this.logger.error('Aggregation health check failed', error);
      }
    });

    // System-wide health check every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      if (!this.isRunning) return;
      
      try {
        await this.performSystemHealthCheck();
      } catch (error) {
        this.logger.error('System health check failed', error);
      }
    });
  }

  /**
   * Register a custom health checker
   */
  public registerHealthChecker(
    component: string,
    checker: () => Promise<ComponentHealth>
  ): void {
    this.healthCheckers.set(component, checker);
    this.logger.info(`Registered health checker for ${component}`);
  }

  /**
   * Check data providers health
   */
  private async checkDataProvidersHealth(): Promise<void> {
    // This would integrate with the actual data providers
    // For now, we'll create a sample implementation
    
    const components = ['liqi', 'b3', 'bacen', 'banks'];
    
    for (const component of components) {
      try {
        const checker = this.healthCheckers.get(component);
        let health: ComponentHealth;
        
        if (checker) {
          health = await checker();
        } else {
          // Default health check implementation
          health = await this.performDefaultHealthCheck(component);
        }
        
        this.updateComponentHealth(component, health);
        await this.evaluateAlerts(health);
        
      } catch (error) {
        this.logger.error(`Health check failed for ${component}`, error);
        
        const unhealthyStatus: ComponentHealth = {
          component,
          status: 'UNHEALTHY',
          lastCheck: Date.now(),
          uptime: 0,
          latency: 0,
          errorRate: 100,
          details: { error: error instanceof Error ? error.message : 'Unknown error' },
          issues: ['Health check execution failed']
        };
        
        this.updateComponentHealth(component, unhealthyStatus);
        await this.evaluateAlerts(unhealthyStatus);
      }
    }
  }

  /**
   * Check oracle service health
   */
  private async checkOracleHealth(): Promise<void> {
    const checker = this.healthCheckers.get('oracle');
    let health: ComponentHealth;
    
    if (checker) {
      health = await checker();
    } else {
      health = await this.performDefaultHealthCheck('oracle');
    }
    
    this.updateComponentHealth('oracle', health);
    await this.evaluateAlerts(health);
  }

  /**
   * Check blockchain connectivity health
   */
  private async checkBlockchainHealth(): Promise<void> {
    const checker = this.healthCheckers.get('blockchain');
    let health: ComponentHealth;
    
    if (checker) {
      health = await checker();
    } else {
      health = await this.performDefaultHealthCheck('blockchain');
    }
    
    this.updateComponentHealth('blockchain', health);
    await this.evaluateAlerts(health);
  }

  /**
   * Check aggregation system health
   */
  private async checkAggregationHealth(): Promise<void> {
    const checker = this.healthCheckers.get('aggregation');
    let health: ComponentHealth;
    
    if (checker) {
      health = await checker();
    } else {
      health = await this.performDefaultHealthCheck('aggregation');
    }
    
    this.updateComponentHealth('aggregation', health);
    await this.evaluateAlerts(health);
  }

  /**
   * Perform default health check for a component
   */
  private async performDefaultHealthCheck(component: string): Promise<ComponentHealth> {
    // This is a placeholder implementation
    // In a real system, this would check the actual component
    
    const isHealthy = Math.random() > 0.1; // 90% healthy simulation
    const latency = Math.random() * 1000; // Random latency up to 1 second
    
    return {
      component,
      status: isHealthy ? 'HEALTHY' : 'DEGRADED',
      lastCheck: Date.now(),
      uptime: isHealthy ? 99.5 : 85.0,
      latency,
      errorRate: isHealthy ? 1.0 : 15.0,
      details: {
        simulatedCheck: true,
        randomHealth: isHealthy
      },
      issues: isHealthy ? [] : ['Simulated degraded performance']
    };
  }

  /**
   * Update component health history
   */
  private updateComponentHealth(component: string, health: ComponentHealth): void {
    let history = this.healthHistory.get(component) || [];
    
    // Add new health record
    history.push(health);
    
    // Keep only last 100 records per component
    if (history.length > 100) {
      history = history.slice(-100);
    }
    
    this.healthHistory.set(component, history);
    
    this.logger.debug(`Updated health for ${component}`, {
      status: health.status,
      uptime: health.uptime,
      latency: health.latency
    });
  }

  /**
   * Evaluate and generate alerts based on health status
   */
  private async evaluateAlerts(health: ComponentHealth): Promise<void> {
    const alertId = `${health.component}-${health.status.toLowerCase()}`;
    
    // Check if we should create an alert
    let shouldAlert = false;
    let severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' = 'INFO';
    let message = '';

    switch (health.status) {
      case 'CRITICAL':
        shouldAlert = true;
        severity = 'CRITICAL';
        message = `${health.component} is in CRITICAL state`;
        break;
      case 'UNHEALTHY':
        shouldAlert = true;
        severity = 'ERROR';
        message = `${health.component} is UNHEALTHY`;
        break;
      case 'DEGRADED':
        shouldAlert = !this.config.alerts.criticalOnly;
        severity = 'WARNING';
        message = `${health.component} performance is DEGRADED`;
        break;
      case 'HEALTHY':
        // Check if we need to resolve an existing alert
        const existingAlert = this.activeAlerts.get(alertId);
        if (existingAlert && !existingAlert.resolvedAt) {
          existingAlert.resolvedAt = Date.now();
          this.logger.info(`Alert resolved: ${existingAlert.message}`);
        }
        return;
    }

    // Check additional thresholds
    if (health.latency > this.config.thresholds.maxLatency) {
      shouldAlert = true;
      severity = severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
      message += ` (High latency: ${health.latency}ms)`;
    }

    if (health.errorRate > (100 - this.config.thresholds.minSuccessRate)) {
      shouldAlert = true;
      severity = severity === 'CRITICAL' ? 'CRITICAL' : 'ERROR';
      message += ` (High error rate: ${health.errorRate}%)`;
    }

    if (shouldAlert) {
      await this.createAlert(alertId, severity, health.component, message, {
        health,
        thresholds: this.config.thresholds
      });
    }
  }

  /**
   * Create and send an alert
   */
  private async createAlert(
    id: string,
    severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL',
    component: string,
    message: string,
    metadata?: any
  ): Promise<void> {
    // Check if alert already exists and is recent
    const existingAlert = this.activeAlerts.get(id);
    if (existingAlert && !existingAlert.resolvedAt) {
      const timeSinceAlert = Date.now() - existingAlert.timestamp;
      if (timeSinceAlert < 300000) { // Don't spam alerts within 5 minutes
        return;
      }
    }

    const alert: HealthAlert = {
      id,
      severity,
      component,
      message,
      timestamp: Date.now(),
      acknowledged: false,
      metadata
    };

    this.activeAlerts.set(id, alert);

    // Log the alert
    const logLevel = severity === 'CRITICAL' ? 'error' : 
                    severity === 'ERROR' ? 'error' :
                    severity === 'WARNING' ? 'warn' : 'info';
    
    this.logger[logLevel](`ALERT [${severity}]: ${message}`, { alert });

    // Send notifications
    await this.sendNotifications(alert);
  }

  /**
   * Send alert notifications
   */
  private async sendNotifications(alert: HealthAlert): Promise<void> {
    try {
      // Skip non-critical alerts if configured
      if (this.config.alerts.criticalOnly && 
          alert.severity !== 'CRITICAL' && 
          alert.severity !== 'ERROR') {
        return;
      }

      // This would integrate with actual notification services
      // For now, we'll just log the notification intent
      
      this.logger.info('Sending alert notifications', {
        alert: alert.message,
        severity: alert.severity,
        component: alert.component,
        enabledChannels: {
          discord: this.config.alerts.enableDiscord,
          slack: this.config.alerts.enableSlack,
          email: this.config.alerts.enableEmail
        }
      });

      // TODO: Implement actual notification sending
      // - Discord webhook
      // - Slack webhook  
      // - Email notifications
      
    } catch (error) {
      this.logger.error('Failed to send alert notifications', error, { alert });
    }
  }

  /**
   * Perform comprehensive system health check
   */
  public async performSystemHealthCheck(): Promise<SystemHealth> {
    const now = Date.now();
    const systemUptime = ((now - this.systemStartTime) / (now - this.systemStartTime)) * 100;
    
    // Collect all component health statuses
    const components: ComponentHealth[] = [];
    let overallStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'CRITICAL' = 'HEALTHY';
    
    for (const [componentName, history] of this.healthHistory.entries()) {
      if (history.length > 0) {
        const latestHealth = history[history.length - 1];
        components.push(latestHealth);
        
        // Determine overall status based on worst component
        if (latestHealth.status === 'CRITICAL') {
          overallStatus = 'CRITICAL';
        } else if (latestHealth.status === 'UNHEALTHY' && overallStatus !== 'CRITICAL') {
          overallStatus = 'UNHEALTHY';
        } else if (latestHealth.status === 'DEGRADED' && 
                   overallStatus !== 'CRITICAL' && 
                   overallStatus !== 'UNHEALTHY') {
          overallStatus = 'DEGRADED';
        }
      }
    }

    // Calculate system metrics
    const metrics = this.calculateSystemMetrics(components);
    
    // Get active alerts
    const alerts = Array.from(this.activeAlerts.values())
      .filter(alert => !alert.resolvedAt)
      .sort((a, b) => b.timestamp - a.timestamp);

    const systemHealth: SystemHealth = {
      overall: overallStatus,
      timestamp: now,
      uptime: systemUptime,
      components,
      alerts,
      metrics
    };

    this.logger.info('System health check completed', {
      overall: overallStatus,
      components: components.length,
      activeAlerts: alerts.length,
      uptime: systemUptime
    });

    return systemHealth;
  }

  /**
   * Calculate system-wide metrics
   */
  private calculateSystemMetrics(components: ComponentHealth[]): SystemHealth['metrics'] {
    let totalRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;
    let totalLatency = 0;
    let oldestData = Date.now();

    for (const component of components) {
      // Simulate metrics based on component health
      const requests = 100; // Simulated
      totalRequests += requests;
      
      const successRate = (100 - component.errorRate) / 100;
      const successful = Math.floor(requests * successRate);
      successfulRequests += successful;
      failedRequests += (requests - successful);
      
      totalLatency += component.latency;
      
      if (component.lastCheck < oldestData) {
        oldestData = component.lastCheck;
      }
    }

    const averageLatency = components.length > 0 ? totalLatency / components.length : 0;
    const dataFreshness = Date.now() - oldestData;

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      averageLatency,
      dataFreshness
    };
  }

  /**
   * Get current system health
   */
  public async getCurrentHealth(): Promise<SystemHealth> {
    return this.performSystemHealthCheck();
  }

  /**
   * Get component health history
   */
  public getComponentHistory(component: string, limit: number = 50): ComponentHealth[] {
    const history = this.healthHistory.get(component) || [];
    return history.slice(-limit);
  }

  /**
   * Get all active alerts
   */
  public getActiveAlerts(): HealthAlert[] {
    return Array.from(this.activeAlerts.values())
      .filter(alert => !alert.resolvedAt)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Acknowledge an alert
   */
  public acknowledgeAlert(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (alert) {
      alert.acknowledged = true;
      this.logger.info(`Alert acknowledged: ${alert.message}`, { alertId });
      return true;
    }
    return false;
  }

  /**
   * Resolve an alert manually
   */
  public resolveAlert(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (alert) {
      alert.resolvedAt = Date.now();
      this.logger.info(`Alert manually resolved: ${alert.message}`, { alertId });
      return true;
    }
    return false;
  }

  /**
   * Update health check configuration
   */
  public updateConfig(newConfig: Partial<HealthCheckConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Health monitor configuration updated', newConfig);
  }

  /**
   * Get health check configuration
   */
  public getConfig(): HealthCheckConfig {
    return { ...this.config };
  }

  /**
   * Get health monitoring statistics
   */
  public getStatistics(): {
    systemUptime: number;
    totalAlerts: number;
    activeAlerts: number;
    resolvedAlerts: number;
    componentsMonitored: number;
    healthChecksPerformed: number;
  } {
    const allAlerts = Array.from(this.activeAlerts.values());
    const activeAlertsCount = allAlerts.filter(a => !a.resolvedAt).length;
    const resolvedAlertsCount = allAlerts.filter(a => a.resolvedAt).length;
    
    let totalHealthChecks = 0;
    this.healthHistory.forEach(history => {
      totalHealthChecks += history.length;
    });

    return {
      systemUptime: Date.now() - this.systemStartTime,
      totalAlerts: allAlerts.length,
      activeAlerts: activeAlertsCount,
      resolvedAlerts: resolvedAlertsCount,
      componentsMonitored: this.healthHistory.size,
      healthChecksPerformed: totalHealthChecks
    };
  }
}

export default HealthMonitor;
