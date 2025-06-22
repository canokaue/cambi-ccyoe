import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';
import { CambiCCYOEBot } from '../index';

interface APIRequest extends Request {
  startTime?: number;
}

/**
 * API Server for Cambi CCYOE Bot
 * Provides REST endpoints for monitoring and control
 */
export class APIServer {
  private app: express.Application;
  private server: any;
  private config: Config;
  private logger: Logger;
  private bot: CambiCCYOEBot;
  private isRunning: boolean = false;

  constructor(config: Config, logger: Logger, bot: CambiCCYOEBot) {
    this.config = config;
    this.logger = logger.child('APIServer');
    this.bot = bot;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Security middleware
    this.app.use(helmet());
    this.app.use(cors());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request timing middleware
    this.app.use((req: APIRequest, res: Response, next: NextFunction) => {
      req.startTime = Date.now();
      next();
    });

    // Logging middleware
    this.app.use((req: APIRequest, res: Response, next: NextFunction) => {
      res.on('finish', () => {
        const duration = req.startTime ? Date.now() - req.startTime : 0;
        this.logger.logAPIRequest(req.method, req.path, res.statusCode, duration);
      });
      next();
    });

    // Error handling middleware
    this.app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
      this.logger.error('API Error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: this.config.isProduction() ? 'An error occurred' : error.message
      });
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', async (req: Request, res: Response) => {
      try {
        const status = this.bot.getSystemStatus();
        res.json({
          status: 'OK',
          timestamp: new Date().toISOString(),
          uptime: status.uptime,
          isRunning: status.isRunning,
          health: status.health.status
        });
      } catch (error) {
        res.status(500).json({ error: 'Health check failed' });
      }
    });

    // Detailed system status
    this.app.get('/status', async (req: Request, res: Response) => {
      try {
        const status = this.bot.getSystemStatus();
        res.json(status);
      } catch (error) {
        this.logger.error('Error getting system status:', error);
        res.status(500).json({ error: 'Failed to get system status' });
      }
    });

    // Current yields data
    this.app.get('/yields', async (req: Request, res: Response) => {
      try {
        const status = this.bot.getSystemStatus();
        res.json({
          yields: status.currentYields,
          lastUpdate: status.lastRebalance,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.logger.error('Error getting yields data:', error);
        res.status(500).json({ error: 'Failed to get yields data' });
      }
    });

    // Force rebalancing check
    this.app.post('/rebalance', async (req: Request, res: Response) => {
      try {
        const { force = false } = req.body;
        
        this.logger.info('Manual rebalance trigger requested', { force });
        
        const result = await this.bot.forceRebalanceCheck();
        
        res.json({
          success: true,
          result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.logger.error('Error triggering rebalance:', error);
        res.status(500).json({ 
          success: false,
          error: 'Failed to trigger rebalance',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // Emergency pause
    this.app.post('/emergency/pause', async (req: Request, res: Response) => {
      try {
        const { reason = 'Manual emergency pause via API' } = req.body;
        
        this.logger.warn('Emergency pause requested via API', { reason });
        
        const result = await this.bot.emergencyPause(reason);
        
        res.json({
          success: result.success,
          txHash: result.txHash,
          reason,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.logger.error('Error executing emergency pause:', error);
        res.status(500).json({ 
          success: false,
          error: 'Failed to execute emergency pause',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // System metrics
    this.app.get('/metrics', async (req: Request, res: Response) => {
      try {
        const status = this.bot.getSystemStatus();
        
        const metrics = {
          uptime: status.uptime,
          lastRebalance: status.lastRebalance,
          healthStatus: status.health.status,
          yieldsCount: Object.keys(status.currentYields).length,
          systemRunning: status.isRunning,
          memoryUsage: process.memoryUsage(),
          nodeVersion: process.version,
          timestamp: new Date().toISOString()
        };
        
        res.json(metrics);
      } catch (error) {
        this.logger.error('Error getting metrics:', error);
        res.status(500).json({ error: 'Failed to get metrics' });
      }
    });

    // Configuration info (safe subset)
    this.app.get('/config', async (req: Request, res: Response) => {
      try {
        const safeConfig = {
          chainId: this.config.CHAIN_ID,
          rebalanceThreshold: this.config.REBALANCE_THRESHOLD,
          minRebalanceInterval: this.config.MIN_REBALANCE_INTERVAL,
          gasThreshold: this.config.GAS_PRICE_THRESHOLD,
          dryRun: this.config.DRY_RUN,
          supportedAssets: this.config.SUPPORTED_ASSETS,
          healthCheckInterval: this.config.HEALTH_CHECK_INTERVAL,
          oracleStaleThreshold: this.config.ORACLE_STALENESS_THRESHOLD
        };
        
        res.json(safeConfig);
      } catch (error) {
        this.logger.error('Error getting config:', error);
        res.status(500).json({ error: 'Failed to get configuration' });
      }
    });

    // Asset configuration
    this.app.get('/assets/:assetId', async (req: Request, res: Response) => {
      try {
        const { assetId } = req.params;
        const assetConfig = this.config.getAssetConfig(assetId);
        
        if (!assetConfig) {
          return res.status(404).json({ error: `Asset ${assetId} not found` });
        }
        
        const status = this.bot.getSystemStatus();
        const currentYield = status.currentYields[assetId];
        
        res.json({
          assetId,
          config: assetConfig,
          currentYield,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.logger.error('Error getting asset info:', error);
        res.status(500).json({ error: 'Failed to get asset information' });
      }
    });

    // Bot logs (last N entries)
    this.app.get('/logs', async (req: Request, res: Response) => {
      try {
        const { limit = 100, level = 'info' } = req.query;
        
        // In production, this would read from log files
        // For now, return a mock response
        res.json({
          logs: [
            {
              timestamp: new Date().toISOString(),
              level: 'info',
              message: 'System monitoring active',
              context: 'CambiBot'
            }
          ],
          limit: Number(limit),
          level,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.logger.error('Error getting logs:', error);
        res.status(500).json({ error: 'Failed to get logs' });
      }
    });

    // Dashboard data endpoint
    this.app.get('/dashboard', async (req: Request, res: Response) => {
      try {
        const status = this.bot.getSystemStatus();
        
        const dashboardData = {
          overview: {
            isRunning: status.isRunning,
            health: status.health.status,
            uptime: status.uptime,
            lastRebalance: status.lastRebalance
          },
          yields: status.currentYields,
          assets: this.config.SUPPORTED_ASSETS.map(assetId => {
            const config = this.config.getAssetConfig(assetId);
            const current = status.currentYields[assetId];
            return {
              assetId,
              target: config?.targetYield,
              current: current?.yield,
              confidence: current?.confidence,
              deviation: current && config ? current.yield - config.targetYield : 0
            };
          }),
          recentActivity: [], // Would be populated from database
          alerts: [], // Would be populated from alert system
          timestamp: new Date().toISOString()
        };
        
        res.json(dashboardData);
      } catch (error) {
        this.logger.error('Error getting dashboard data:', error);
        res.status(500).json({ error: 'Failed to get dashboard data' });
      }
    });

    // 404 handler
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Endpoint ${req.method} ${req.originalUrl} not found`,
        availableEndpoints: [
          'GET /health',
          'GET /status', 
          'GET /yields',
          'POST /rebalance',
          'POST /emergency/pause',
          'GET /metrics',
          'GET /config',
          'GET /assets/:assetId',
          'GET /logs',
          'GET /dashboard'
        ]
      });
    });
  }

  /**
   * Start the API server
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('API server is already running');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.API_PORT, this.config.API_HOST, () => {
          this.isRunning = true;
          this.logger.info(`API server started on ${this.config.API_HOST}:${this.config.API_PORT}`);
          resolve();
        });

        this.server.on('error', (error: Error) => {
          this.logger.error('API server error:', error);
          reject(error);
        });
      } catch (error) {
        this.logger.error('Failed to start API server:', error);
        reject(error);
      }
    });
  }

  /**
   * Stop the API server
   */
  public async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      this.logger.warn('API server is not running');
      return;
    }

    return new Promise((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        this.logger.info('API server stopped');
        resolve();
      });
    });
  }

  /**
   * Get server status
   */
  public getServerStatus(): {
    isRunning: boolean;
    port: number;
    host: string;
    uptime: number;
  } {
    return {
      isRunning: this.isRunning,
      port: this.config.API_PORT,
      host: this.config.API_HOST,
      uptime: this.server ? process.uptime() : 0
    };
  }
}

export default APIServer;
