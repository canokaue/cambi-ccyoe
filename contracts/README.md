# Cambi CCYOE Smart Contracts

Cross-Collateral Yield Optimization Engine (CCYOE) smart contract protocol built with Foundry.

## Overview

The CCYOE protocol implements Cambi's innovative yield optimization strategy that treats all protocol yields as a unified pool, dynamically redistributing excess yields from high-performing assets to boost returns across the entire protocol.

## Architecture

### Core Contracts

- **CCYOECore.sol**: Main orchestrator contract managing yield distribution and optimization
- **VaultManager.sol**: Manages individual asset vaults (cmBTC, cmUSD, cmBRL)
- **YieldDistributor.sol**: Handles yield calculation and redistribution logic
- **GovernanceMultisig.sol**: DAO/multisig controls for rebalancing parameters
- **RWAVault.sol**: Specialized vault for Real World Asset integration

### Key Features

1. **Isolated Vault Architecture**: Each asset maintains independent solvency
2. **Dynamic Supply Caps**: Maintains attractive yields through controlled supply
3. **Automated Rebalancing**: Smart contract-based yield optimization
4. **Emergency Controls**: Circuit breakers and pause mechanisms
5. **Cross-Collateral Optimization**: Excess yields boost underperforming assets

## Yield Distribution Logic

```
Base Yield Distribution:
- cmBRL holders: Native yield (14-25%)
- cmUSD holders: Native yield (12-18%)  
- cmBTC holders: Native yield (3-8%)

Optimization Distribution:
- 40% to under-supplied assets
- 30% to strategic growth incentives
- 20% to all holders proportionally
- 10% to protocol treasury
```

## Installation

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install dependencies
forge install
```

## Usage

```bash
# Compile contracts
forge build

# Run tests
forge test

# Deploy locally
forge script script/Deploy.s.sol --rpc-url localhost --broadcast

# Run coverage
forge coverage
```

## Testing

The test suite covers:
- Yield calculation and distribution
- Vault isolation and security
- Governance controls
- Emergency scenarios
- Integration with oracle system

## Security

- Multi-signature governance controls
- Time-delayed parameter changes
- Circuit breakers for unusual yield patterns
- Isolated vault architecture prevents contagion
- Comprehensive test coverage

## Configuration

Key parameters controlled by governance:
- Target yield rates per asset
- Redistribution percentages
- Supply caps and expansion triggers
- Emergency pause controls
- Oracle update permissions

## License

MIT
