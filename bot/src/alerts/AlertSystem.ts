import axios from 'axios';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';

export interface Alert {
  level: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  title: string;
  message: string;
  data?: any;
  timestamp?: number;
}

export interface AlertChannel {
  name: string;
  enabled: boolean;
  sendAlert(alert: Alert): Promise<boolean>;
}

/**
 * Alert System - Manages notifications across multiple channels
 */
export class AlertSystem {
  private config: Config;
  private logger: Logger;
  private channels: Map<string, AlertChannel> = new Map();
  private isRunning: boolean = false;
  private alertQueue: Alert[] = [];
  private processing: boolean = false;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger.child('AlertSystem');
    this.initializeChannels();
  }

  /**
   * Initialize alert channels
   */
  private initializeChannels(): void {
    // Discord channel
    if (this.config.getDiscordWebhook()) {
      this.channels.set('discord', new DiscordChannel(
        this.config.getDiscordWebhook()!,
        this.logger
      ));
    }

    // Slack channel
    if (this.config.getSlackWebhook()) {
      this.channels.set('slack', new SlackChannel(
        this.config.getSlackWebhook()!,
        this.logger
      ));
    }

    // Email channel (simplified implementation)
    if (this.config.getAlertEmail()) {
      this.channels.set('email', new EmailChannel(
        this.config.getAlertEmail()!,
        this.logger
      ));
    }

    // Console channel (always available)
    this.channels.set('console', new ConsoleChannel(this.logger));

    this.logger.info(`Initialized ${this.channels.size} alert channels`, {
      channels: Array.from(this.channels.keys())
    });
  }

  /**
   * Start the alert system
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Alert system is already running');
      return;
    }

    this.logger.info('Starting alert system...');

    // Test all channels
    await this.testChannels();

    this.isRunning = true;
    this.startQueueProcessor();

    this.logger.info('Alert system started successfully');
  }

  /**
   * Stop the alert system
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Alert system is not running');
      return;
    }

    this.logger.info('Stopping alert system...');
    this.isRunning = false;

    // Process remaining alerts in queue
    if (this.alertQueue.length > 0) {
      this.logger.info(`Processing ${this.alertQueue.length} remaining alerts...`);
      await this.processQueue();
    }

    this.logger.info('Alert system stopped');
  }

  /**
   * Send an alert through all configured channels
   */
  public async sendAlert(alert: Alert): Promise<void> {
    // Add timestamp if not provided
    if (!alert.timestamp) {
      alert.timestamp = Date.now();
    }

    // Add to queue for processing
    this.alertQueue.push(alert);

    // Process immediately if not already processing
    if (!this.processing) {
      this.processQueue();
    }
  }

  /**
   * Start the queue processor
   */
  private startQueueProcessor(): void {
    setInterval(() => {
      if (this.isRunning && this.alertQueue.length > 0 && !this.processing) {
        this.processQueue();
      }
    }, 1000); // Check every second
  }

  /**
   * Process alert queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.alertQueue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.alertQueue.length > 0) {
        const alert = this.alertQueue.shift();
        if (alert) {
          await this.processAlert(alert);
        }
      }
    } catch (error) {
      this.logger.error('Error processing alert queue:', error);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single alert
   */
  private async processAlert(alert: Alert): Promise<void> {
    const channels = this.getChannelsForAlert(alert);
    
    this.logger.debug('Processing alert', {
      level: alert.level,
      title: alert.title,
      channels: channels.map(c => c.name)
    });

    // Send to all applicable channels in parallel
    const promises = channels.map(async (channel) => {
      try {
        const success = await channel.sendAlert(alert);
        this.logger.logAlert(alert.level, alert.title, channel.name, success);
        return { channel: channel.name, success };
      } catch (error) {
        this.logger.error(`Failed to send alert via ${channel.name}:`, error);
        return { channel: channel.name, success: false };
      }
    });

    const results = await Promise.allSettled(promises);
    
    // Log overall results
    const successful = results.filter(r => 
      r.status === 'fulfilled' && r.value.success
    ).length;
    
    this.logger.info(`Alert sent via ${successful}/${channels.length} channels`, {
      alert: { level: alert.level, title: alert.title },
      results: results.map(r => r.status === 'fulfilled' ? r.value : { error: true })
    });
  }

  /**
   * Get channels that should receive this alert
   */
  private getChannelsForAlert(alert: Alert): AlertChannel[] {
    const channels: AlertChannel[] = [];

    // Critical and error alerts go to all channels
    if (alert.level === 'CRITICAL' || alert.level === 'ERROR') {
      return Array.from(this.channels.values()).filter(c => c.enabled);
    }

    // Warning alerts go to discord/slack + console
    if (alert.level === 'WARNING') {
      const warningChannels = ['discord', 'slack', 'console'];
      warningChannels.forEach(name => {
        const channel = this.channels.get(name);
        if (channel && channel.enabled) {
          channels.push(channel);
        }
      });
      return channels;
    }

    // Info alerts go to console by default
    const consoleChannel = this.channels.get('console');
    if (consoleChannel && consoleChannel.enabled) {
      channels.push(consoleChannel);
    }

    return channels;
  }

  /**
   * Test all channels
   */
  private async testChannels(): Promise<void> {
    this.logger.info('Testing alert channels...');

    const testAlert: Alert = {
      level: 'INFO',
      title: 'Alert System Test',
      message: 'This is a test message to verify alert channel connectivity',
      timestamp: Date.now()
    };

    for (const [name, channel] of this.channels.entries()) {
      try {
        const success = await channel.sendAlert(testAlert);
        this.logger.info(`Channel test ${name}: ${success ? 'SUCCESS' : 'FAILED'}`);
      } catch (error) {
        this.logger.warn(`Channel test ${name} failed:`, error);
      }
    }
  }

  /**
   * Get alert statistics
   */
  public getAlertStats(): {
    totalAlerts: number;
    alertsByLevel: Record<string, number>;
    channelHealth: Record<string, boolean>;
    queueSize: number;
  } {
    return {
      totalAlerts: 0, // Would track in production
      alertsByLevel: {
        INFO: 0,
        WARNING: 0,
        ERROR: 0,
        CRITICAL: 0
      },
      channelHealth: Object.fromEntries(
        Array.from(this.channels.entries()).map(([name, channel]) => [name, channel.enabled])
      ),
      queueSize: this.alertQueue.length
    };
  }
}

/**
 * Discord Alert Channel
 */
class DiscordChannel implements AlertChannel {
  public readonly name = 'discord';
  public enabled = true;
  
  private webhookUrl: string;
  private logger: Logger;

  constructor(webhookUrl: string, logger: Logger) {
    this.webhookUrl = webhookUrl;
    this.logger = logger.child('DiscordChannel');
  }

  async sendAlert(alert: Alert): Promise<boolean> {
    try {
      const color = this.getColorForLevel(alert.level);
      const timestamp = new Date(alert.timestamp || Date.now()).toISOString();

      const embed = {
        title: alert.title,
        description: alert.message,
        color: color,
        timestamp: timestamp,
        fields: alert.data ? [
          {
            name: 'Additional Data',
            value: '```json\n' + JSON.stringify(alert.data, null, 2) + '\n```',
            inline: false
          }
        ] : [],
        footer: {
          text: 'Cambi CCYOE Bot'
        }
      };

      const payload = {
        embeds: [embed],
        username: 'Cambi CCYOE Bot'
      };

      const response = await axios.post(this.webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      });

      return response.status === 204;
    } catch (error) {
      this.logger.error('Discord alert failed:', error);
      return false;
    }
  }

  private getColorForLevel(level: string): number {
    const colors = {
      INFO: 0x3498db,     // Blue
      WARNING: 0xf39c12,  // Orange
      ERROR: 0xe74c3c,    // Red
      CRITICAL: 0x8e44ad  // Purple
    };
    return colors[level as keyof typeof colors] || colors.INFO;
  }
}

/**
 * Slack Alert Channel
 */
class SlackChannel implements AlertChannel {
  public readonly name = 'slack';
  public enabled = true;
  
  private webhookUrl: string;
  private logger: Logger;

  constructor(webhookUrl: string, logger: Logger) {
    this.webhookUrl = webhookUrl;
    this.logger = logger.child('SlackChannel');
  }

  async sendAlert(alert: Alert): Promise<boolean> {
    try {
      const color = this.getColorForLevel(alert.level);
      const timestamp = Math.floor((alert.timestamp || Date.now()) / 1000);

      const attachment = {
        color: color,
        title: alert.title,
        text: alert.message,
        ts: timestamp,
        fields: alert.data ? [
          {
            title: 'Additional Data',
            value: '```' + JSON.stringify(alert.data, null, 2) + '```',
            short: false
          }
        ] : []
      };

      const payload = {
        username: 'Cambi CCYOE Bot',
        attachments: [attachment]
      };

      const response = await axios.post(this.webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      });

      return response.status === 200;
    } catch (error) {
      this.logger.error('Slack alert failed:', error);
      return false;
    }
  }

  private getColorForLevel(level: string): string {
    const colors = {
      INFO: 'good',
      WARNING: 'warning',
      ERROR: 'danger',
      CRITICAL: 'danger'
    };
    return colors[level as keyof typeof colors] || colors.INFO;
  }
}

/**
 * Email Alert Channel (simplified)
 */
class EmailChannel implements AlertChannel {
  public readonly name = 'email';
  public enabled = true;
  
  private emailAddress: string;
  private logger: Logger;

  constructor(emailAddress: string, logger: Logger) {
    this.emailAddress = emailAddress;
    this.logger = logger.child('EmailChannel');
  }

  async sendAlert(alert: Alert): Promise<boolean> {
    try {
      // In production, this would integrate with an email service like SendGrid
      this.logger.info('Email alert (simulated)', {
        to: this.emailAddress,
        subject: `[${alert.level}] ${alert.title}`,
        message: alert.message,
        data: alert.data
      });
      
      return true;
    } catch (error) {
      this.logger.error('Email alert failed:', error);
      return false;
    }
  }
}

/**
 * Console Alert Channel
 */
class ConsoleChannel implements AlertChannel {
  public readonly name = 'console';
  public enabled = true;
  
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child('ConsoleChannel');
  }

  async sendAlert(alert: Alert): Promise<boolean> {
    try {
      const level = alert.level.toLowerCase();
      const timestamp = new Date(alert.timestamp || Date.now()).toISOString();
      
      const logMethod = level === 'critical' || level === 'error' ? 'error' : 
                       level === 'warning' ? 'warn' : 'info';
      
      this.logger[logMethod](`[ALERT] ${alert.title}`, {
        message: alert.message,
        level: alert.level,
        timestamp,
        data: alert.data
      });
      
      return true;
    } catch (error) {
      console.error('Console alert failed:', error);
      return false;
    }
  }
}

export default AlertSystem;
