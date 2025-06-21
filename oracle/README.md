# Cambi RWA Oracle System

Real World Asset oracle system specialized for Cambi Protocol's CCYOE engine, similar to MakerDAO's oracle architecture but focused on Latin American fixed income yields.

## Overview

The Cambi Oracle provides reliable, on-chain yield data for Real World Assets (RWAs) including Brazilian receivables, government bonds, and other LatAm fixed income instruments. It aggregates data from multiple sources, applies confidence scoring, and publishes verified yield data for the CCYOE optimization engine.

## Architecture

### Core Components

- **OracleAggregator.sol**: Main oracle contract aggregating multiple data sources
- **RWADataProvider.sol**: Specialized provider for Real World Asset yield data
- **YieldValidator.sol**: Validates and scores yield data for confidence
- **EmergencyOracle.sol**: Fallback oracle for emergency situations

### Data Sources

1. **Primary Sources**:
   - Liqi tokenized receivables platform
   - B3 Brazilian stock exchange bond data
   - CVM regulatory filings
   - Major Brazilian banks (Itaú, Bradesco, Santander)

2. **Secondary Sources**:
   - Economic indicators (SELIC rate, inflation data)
   - Credit rating agencies
   - Government treasury data
   - Alternative data providers

3. **Validation Sources**:
   - Cross-reference with traditional finance APIs
   - Historical yield pattern analysis
   - Market stress indicators

## Features

### Yield Data Aggregation
- Multi-source data collection
- Weighted averaging with confidence scoring
- Outlier detection and filtering
- Historical yield tracking

### Confidence Scoring
- Source reliability weighting
- Data freshness penalties
- Market volatility adjustments
- Cross-validation bonuses

### Emergency Protocols
- Circuit breakers for unusual yield spikes
- Fallback to conservative estimates
- Manual override capabilities
- Governance-controlled parameters

## Installation

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Compile contracts
npm run compile

# Run tests
npm run test

# Deploy oracle system
npm run deploy:testnet
```

## Usage

### Data Provider Setup

```javascript
const provider = new RWADataProvider({
  liqiApiKey: process.env.LIQI_API_KEY,
  b3ApiKey: process.env.B3_API_KEY,
  updateInterval: 3600, // 1 hour
  confidenceThreshold: 80
});

await provider.start();
```

### Oracle Integration

```solidity
ICambiOracle oracle = ICambiOracle(oracleAddress);
uint256 cmBRLYield = oracle.getAssetYield(keccak256("cmBRL"));
bool isValid = oracle.isYieldDataValid(keccak256("cmBRL"));
```

## Configuration

### Asset Configuration
```json
{
  "cmBRL": {
    "sources": ["liqi", "b3", "itau"],
    "weights": [0.4, 0.3, 0.3],
    "heartbeat": 3600,
    "deviationThreshold": 0.05
  },
  "cmUSD": {
    "sources": ["liqi", "custom_usd"],
    "weights": [0.7, 0.3],
    "heartbeat": 3600,
    "deviationThreshold": 0.03
  }
}
```

### Data Source APIs
- Liqi API for tokenized receivables
- B3 API for government bonds
- Bank APIs for institutional rates
- Central Bank API for SELIC rate

## Security

### Multi-Source Validation
- Require minimum 2 sources agreement
- Flag deviations > threshold for manual review
- Historical pattern validation
- Cross-market correlation checks

### Access Control
- Multi-sig governance for parameter changes
- Role-based access for data providers
- Emergency pause mechanisms
- Audit trail for all updates

### Data Integrity
- Cryptographic signatures for data
- Timestamp validation
- Replay attack protection
- Source authenticity verification

## Monitoring

### Health Checks
- Source availability monitoring
- Data freshness tracking
- Confidence score trending
- Error rate monitoring

### Alerting
- Source downtime notifications
- Unusual yield deviation alerts
- Confidence score degradation
- Emergency circuit breaker triggers

## API Reference

### Core Methods
- `getAssetYield(bytes32 assetId)`: Get current yield for asset
- `getAssetYieldData(bytes32 assetId)`: Get full yield data with metadata
- `updateAssetYield(bytes32 assetId, uint256 yield, uint256 confidence)`: Update yield data
- `isYieldDataValid(bytes32 assetId)`: Check if data is valid and fresh

### Admin Methods
- `updateSourceWeights(bytes32 assetId, uint256[] weights)`: Update source weights
- `setHeartbeat(bytes32 assetId, uint256 heartbeat)`: Set update frequency
- `pauseAsset(bytes32 assetId)`: Pause updates for specific asset
- `emergencySetYield(bytes32 assetId, uint256 yield)`: Emergency yield override

## Development

### Adding New Data Sources
1. Implement `IDataSource` interface
2. Add source configuration
3. Update aggregation weights
4. Test thoroughly before production

### Testing
- Unit tests for all oracle components
- Integration tests with mock data sources
- Stress tests for high-volatility scenarios
- Security tests for attack vectors

## License

MIT
