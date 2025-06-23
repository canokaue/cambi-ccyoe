# Cambi CCYOE Monitoring Bot

TypeScript bot built with Viem for monitoring and automating CCYOE operations on Cambi Protocol.

## Overview

The Cambi CCYOE Bot is an autonomous monitoring and execution system that:

- Monitors yield differentials across assets (cmBTC, cmUSD, cmBRL)
- Triggers rebalancing operations when thresholds are met
- Watches for unusual market conditions and circuit breaker events
- Provides real-time alerting and notifications
- Executes emergency procedures when needed

## Features

### Automated Monitoring
- **Yield Tracking**: Continuous monitoring of asset yields vs targets
- **Deviation Detection**: Alert on unusual yield patterns or data inconsistencies  
- **Health Monitoring**: Track oracle data freshness and system health
- **Gas Optimization**: Smart transaction timing for optimal gas costs

### Rebalancing Automation
- **Threshold-Based Triggers**: Execute rebalancing when excess yield exceeds configured thresholds
- **Time-Based Execution**: Respect minimum rebalancing frequencies
- **Multi-Signature Support**: Integration with governance multisig for parameter changes
- **Emergency Overrides**: Rapid response to market stress conditions

### Alerting & Notifications
- **Discord/Slack Integration**: Real-time notifications to team channels
- **Email Alerts**: Critical system notifications
- **Webhook Support**: Custom integrations with monitoring systems
- **Dashboard API**: Real-time data for frontend dashboards

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Viem Client   │────│   CCYOE Core    │────│   Oracle Data   │
│   (Blockchain)  │    │ (Smart Contract)│    │   (Yield Info)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │              ┌─────────────────┐              │
         └──────────────│  Monitoring Bot │──────────────┘
                        │   (This System) │
                        └─────────────────┘
                                 │
                   ┌─────────────┼─────────────┐
                   │             │             │
           ┌───────────────┐ ┌──────────┐ ┌──────────┐
           │   Alerting    │ │   API    │ │  Health  │
           │   System      │ │ Server   │ │ Monitor  │
           └───────────────┘ └──────────┘ └──────────┘
```

## Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Build the project
npm run build

# Run in development
npm run dev

# Run in production
npm start
```

## Configuration

### Environment Variables

```bash
# Blockchain Configuration
RPC_URL=https://mainnet.infura.io/v3/your-key
PRIVATE_KEY=your-private-key
CHAIN_ID=1

# Contract Addresses
CCYOE_CORE_ADDRESS=0x...
ORACLE_ADDRESS=0x...
VAULT_MANAGER_ADDRESS=0x...

# Monitoring Configuration
REBALANCE_THRESHOLD=100  # 1% in basis points
MIN_REBALANCE_INTERVAL=3600  # 1 hour in seconds
GAS_PRICE_THRESHOLD=50  # Max gas price in gwei

# Alerting Configuration
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ALERT_EMAIL=alerts@cambi.com

# Health Check Configuration
HEALTH_CHECK_INTERVAL=300  # 5 minutes
ORACLE_STALENESS_THRESHOLD=3600  # 1 hour
```

### Asset Configuration

```json
{
  "assets": {
    "cmBTC": {
      "targetYield": 500,
      "maxDeviation": 200,
      "minConfidence": 80,
      "alertThresholds": {
        "yield": 1000,
        "confidence": 60,
        "staleness": 7200
      }
    },
    "cmUSD": {
      "targetYield": 1400,
      "maxDeviation": 300,
      "minConfidence": 85,
      "alertThresholds": {
        "yield": 2000,
        "confidence": 70,
        "staleness": 3600
      }
    },
    "cmBRL": {
      "targetYield": 2000,
      "maxDeviation": 500,
      "minConfidence": 80,
      "alertThresholds": {
        "yield": 3000,
        "confidence": 65,
        "staleness": 3600
      }
    }
  }
}
```

## Usage

### Starting the Bot

```bash
# Production mode
npm start

# Development mode with auto-restart
npm run dev

# Dry-run mode (monitoring only, no transactions)
npm run dry-run
```

### Manual Operations

```bash
# Force rebalancing check
npm run rebalance

# Check system health
npm run health-check

# Emergency pause
npm run emergency-pause

# View current status
npm run status
```

## Monitoring

### Key Metrics
- Yield differentials between actual and target rates
- Oracle data freshness and confidence scores
- Transaction success rates and gas costs
- System uptime and error rates

### Alerts
- **Critical**: Oracle failures, contract pauses, emergency conditions
- **Warning**: High deviations, stale data, gas price spikes
- **Info**: Successful rebalances, routine operations

### Dashboard
Real-time dashboard available at `http://localhost:3000/dashboard` showing:
- Current yields for all assets
- Recent rebalancing activity
- System health metrics
- Alert history

## Security

### Private Key Management
- Use hardware wallets or secure key management systems
- Never commit private keys to version control
- Rotate keys regularly
- Use separate keys for different environments

### Permission Management
- Bot requires OPERATOR_ROLE for rebalancing operations
- Emergency functions require EMERGENCY_ROLE
- Parameter changes require GOVERNANCE_ROLE
- Implement role-based access controls

### Monitoring
- Transaction monitoring for unusual patterns
- Gas price protection against MEV attacks
- Slippage protection for rebalancing operations
- Rate limiting for API calls

## Development

### Adding New Monitoring Rules

```typescript
// src/monitors/CustomMonitor.ts
export class CustomMonitor extends BaseMonitor {
  async check(): Promise<MonitorResult> {
    // Your monitoring logic here
    return {
      status: 'HEALTHY',
      message: 'All systems operational',
      data: {}
    };
  }
}
```

### Custom Alert Handlers

```typescript
// src/alerts/CustomAlertHandler.ts
export class CustomAlertHandler implements AlertHandler {
  async sendAlert(alert: Alert): Promise<void> {
    // Your alert logic here
  }
}
```

### Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:monitors
npm run test:rebalancer
npm run test:alerts

# Run integration tests
npm run test:integration
```

## API Reference

### Health Check Endpoint
```
GET /health
Response: {
  "status": "HEALTHY",
  "uptime": 12345,
  "lastRebalance": "2024-01-01T00:00:00Z",
  "assets": {
    "cmBTC": { "yield": 500, "confidence": 95 },
    "cmUSD": { "yield": 1400, "confidence": 90 },
    "cmBRL": { "yield": 2500, "confidence": 85 }
  }
}
```

### Manual Rebalance Trigger
```
POST /rebalance
Body: { "force": false, "dryRun": false }
Response: { "txHash": "0x...", "gasUsed": 150000 }
```

### Emergency Pause
```
POST /emergency/pause
Body: { "reason": "Market stress detected" }
Response: { "success": true, "txHash": "0x..." }
```

## Troubleshooting

### Common Issues

1. **Transaction Failures**
   - Check gas price settings
   - Verify contract permissions
   - Ensure sufficient ETH balance

2. **Oracle Data Issues**
   - Verify oracle contract address
   - Check data provider health
   - Validate asset configurations

3. **Alert Delivery Problems**
   - Test webhook URLs
   - Check Discord/Slack permissions
   - Verify email SMTP settings

### Logs

Logs are written to:
- Console output (development)
- `logs/` directory (production)
- External logging service (if configured)

Log levels: ERROR, WARN, INFO, DEBUG

## License

MIT
