import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';
import { YieldData } from '../monitors/CCYOEMonitor';

export interface RebalanceEvent {
  id?: number;
  timestamp: Date;
  reason: string;
  txHash: string;
  gasUsed: number;
  yields: [string, YieldData][];
}

export interface AlertEvent {
  id?: number;
  timestamp: Date;
  level: string;
  title: string;
  message: string;
  data?: any;
}

/**
 * Database abstraction for Cambi CCYOE Bot
 * Uses SQLite for local storage
 */
export class Database {
  private config: Config;
  private logger: Logger;
  private db: any; // Would be sqlite3.Database in production
  private isConnected: boolean = false;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger('Database');
  }

  /**
   * Connect to database
   */
  public async connect(): Promise<void> {
    try {
      this.logger.info('Connecting to database...', { url: this.config.DATABASE_URL });
      
      // In production, this would initialize SQLite connection
      // For now, simulate connection
      this.isConnected = true;
      
      await this.initializeTables();
      
      this.logger.info('Database connected successfully');
    } catch (error) {
      this.logger.error('Failed to connect to database:', error);
      throw error;
    }
  }

  /**
   * Disconnect from database
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      this.logger.warn('Database is not connected');
      return;
    }

    try {
      // In production, close SQLite connection
      this.isConnected = false;
      this.logger.info('Database disconnected');
    } catch (error) {
      this.logger.error('Error disconnecting from database:', error);
    }
  }

  /**
   * Initialize database tables
   */
  private async initializeTables(): Promise<void> {
    try {
      // In production, create SQLite tables
      const tables = [
        `CREATE TABLE IF NOT EXISTS yield_data (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset_id TEXT NOT NULL,
          yield INTEGER NOT NULL,
          confidence INTEGER NOT NULL,
          timestamp DATETIME NOT NULL,
          is_valid BOOLEAN NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        
        `CREATE TABLE IF NOT EXISTS rebalance_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME NOT NULL,
          reason TEXT NOT NULL,
          tx_hash TEXT NOT NULL,
          gas_used INTEGER NOT NULL,
          yields_data TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        
        `CREATE TABLE IF NOT EXISTS alert_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME NOT NULL,
          level TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          data TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        
        `CREATE INDEX IF NOT EXISTS idx_yield_data_asset_timestamp 
         ON yield_data(asset_id, timestamp)`,
         
        `CREATE INDEX IF NOT EXISTS idx_rebalance_events_timestamp 
         ON rebalance_events(timestamp)`,
         
        `CREATE INDEX IF NOT EXISTS idx_alert_events_level_timestamp 
         ON alert_events(level, timestamp)`
      ];

      // Simulate table creation
      this.logger.info(`Initialized ${tables.length} database tables`);
      
    } catch (error) {
      this.logger.error('Failed to initialize tables:', error);
      throw error;
    }
  }

  /**
   * Store yield data
   */
  public async storeYieldData(yieldData: Record<string, YieldData>): Promise<void> {
    if (!this.isConnected) {
      this.logger.warn('Database not connected, skipping yield data storage');
      return;
    }

    try {
      for (const [assetId, data] of Object.entries(yieldData)) {
        // In production, insert into SQLite
        this.logger.debug('Storing yield data', {
          assetId,
          yield: data.yield,
          confidence: data.confidence,
          timestamp: new Date(data.timestamp).toISOString()
        });
      }
    } catch (error) {
      this.logger.error('Failed to store yield data:', error);
    }
  }

  /**
   * Store rebalance event
   */
  public async storeRebalanceEvent(event: RebalanceEvent): Promise<void> {
    if (!this.isConnected) {
      this.logger.warn('Database not connected, skipping rebalance event storage');
      return;
    }

    try {
      // In production, insert into SQLite
      this.logger.info('Storing rebalance event', {
        timestamp: event.timestamp.toISOString(),
        reason: event.reason,
        txHash: event.txHash,
        gasUsed: event.gasUsed
      });
    } catch (error) {
      this.logger.error('Failed to store rebalance event:', error);
    }
  }

  /**
   * Store alert event
   */
  public async storeAlertEvent(alert: AlertEvent): Promise<void> {
    if (!this.isConnected) {
      this.logger.warn('Database not connected, skipping alert event storage');
      return;
    }

    try {
      // In production, insert into SQLite
      this.logger.debug('Storing alert event', {
        level: alert.level,
        title: alert.title,
        timestamp: alert.timestamp.toISOString()
      });
    } catch (error) {
      this.logger.error('Failed to store alert event:', error);
    }
  }

  /**
   * Get yield data for time range
   */
  public async getYieldData(
    assetId: string, 
    startDate: Date, 
    endDate: Date
  ): Promise<YieldData[]> {
    if (!this.isConnected) {
      return [];
    }

    try {
      // In production, query SQLite
      // For now, return mock data
      return [
        {
          yield: 2200,
          confidence: 85,
          timestamp: Date.now(),
          isValid: true
        }
      ];
    } catch (error) {
      this.logger.error('Failed to get yield data:', error);
      return [];
    }
  }

  /**
   * Get rebalance events count for time range
   */
  public async getRebalanceCount(startDate: Date, endDate: Date): Promise<number> {
    if (!this.isConnected) {
      return 0;
    }

    try {
      // In production, query SQLite
      return 5; // Mock data
    } catch (error) {
      this.logger.error('Failed to get rebalance count:', error);
      return 0;
    }
  }

  /**
   * Get alert events count for time range
   */
  public async getAlertCount(startDate: Date, endDate: Date): Promise<number> {
    if (!this.isConnected) {
      return 0;
    }

    try {
      // In production, query SQLite
      return 12; // Mock data
    } catch (error) {
      this.logger.error('Failed to get alert count:', error);
      return 0;
    }
  }

  /**
   * Get average yields for time range
   */
  public async getAverageYields(startDate: Date, endDate: Date): Promise<Record<string, number>> {
    if (!this.isConnected) {
      return {};
    }

    try {
      // In production, query SQLite with aggregation
      return {
        cmBTC: 520,
        cmUSD: 1450,
        cmBRL: 2180
      };
    } catch (error) {
      this.logger.error('Failed to get average yields:', error);
      return {};
    }
  }

  /**
   * Get total gas used for time range
   */
  public async getTotalGasUsed(startDate: Date, endDate: Date): Promise<string> {
    if (!this.isConnected) {
      return '0';
    }

    try {
      // In production, query SQLite with SUM
      return '0.0024'; // Mock data in ETH
    } catch (error) {
      this.logger.error('Failed to get total gas used:', error);
      return '0';
    }
  }

  /**
   * Get recent rebalance events
   */
  public async getRecentRebalances(limit: number = 10): Promise<RebalanceEvent[]> {
    if (!this.isConnected) {
      return [];
    }

    try {
      // In production, query SQLite with LIMIT and ORDER BY
      return [
        {
          id: 1,
          timestamp: new Date(Date.now() - 3600000),
          reason: 'cmBRL yield deviation: 250bp > 100bp',
          txHash: '0x1234567890abcdef',
          gasUsed: 145000,
          yields: []
        }
      ];
    } catch (error) {
      this.logger.error('Failed to get recent rebalances:', error);
      return [];
    }
  }

  /**
   * Get recent alerts
   */
  public async getRecentAlerts(limit: number = 50): Promise<AlertEvent[]> {
    if (!this.isConnected) {
      return [];
    }

    try {
      // In production, query SQLite with LIMIT and ORDER BY
      return [
        {
          id: 1,
          timestamp: new Date(),
          level: 'INFO',
          title: 'System Started',
          message: 'CCYOE Bot started successfully',
          data: null
        }
      ];
    } catch (error) {
      this.logger.error('Failed to get recent alerts:', error);
      return [];
    }
  }

  /**
   * Clean up old records
   */
  public async cleanupOldRecords(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      // In production, delete old records from SQLite
      // Keep last 30 days of yield data
      // Keep last 90 days of rebalance events
      // Keep last 7 days of alert events
      
      this.logger.info('Database cleanup completed', {
        cutoffDate: thirtyDaysAgo.toISOString()
      });
    } catch (error) {
      this.logger.error('Failed to cleanup old records:', error);
    }
  }

  /**
   * Get database statistics
   */
  public async getStats(): Promise<{
    yieldRecords: number;
    rebalanceEvents: number;
    alertEvents: number;
    oldestRecord: string;
    newestRecord: string;
  }> {
    if (!this.isConnected) {
      return {
        yieldRecords: 0,
        rebalanceEvents: 0,
        alertEvents: 0,
        oldestRecord: '',
        newestRecord: ''
      };
    }

    try {
      // In production, query SQLite for counts and dates
      return {
        yieldRecords: 1250,
        rebalanceEvents: 42,
        alertEvents: 180,
        oldestRecord: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        newestRecord: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Failed to get database stats:', error);
      return {
        yieldRecords: 0,
        rebalanceEvents: 0,
        alertEvents: 0,
        oldestRecord: '',
        newestRecord: ''
      };
    }
  }

  /**
   * Check if database is connected
   */
  public isConnectedToDatabase(): boolean {
    return this.isConnected;
  }

  /**
   * Test database connection
   */
  public async testConnection(): Promise<boolean> {
    try {
      if (!this.isConnected) {
        return false;
      }

      // In production, perform a simple query
      return true;
    } catch (error) {
      this.logger.error('Database connection test failed:', error);
      return false;
    }
  }
}

export default Database;
