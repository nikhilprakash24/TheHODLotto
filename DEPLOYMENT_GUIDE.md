# TheHODLotto - Complete Deployment Guide

This guide covers the complete deployment process for TheHODLotto system including the new reward points system.

## Table of Contents
1. [System Architecture](#system-architecture)
2. [Prerequisites](#prerequisites)
3. [Deployment Order](#deployment-order)
4. [Configuration Steps](#configuration-steps)
5. [Testing Checklist](#testing-checklist)
6. [Mainnet Deployment](#mainnet-deployment)

---

## System Architecture

TheHODLotto consists of 5 main contracts:

```
┌─────────────────────────────────────────────────────────────┐
│                      HODL Token (ERC20)                      │
│         (User's main token - they hold to earn rewards)      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Users hold
                         ↓
┌─────────────────────────────────────────────────────────────┐
│              RewardPointsManager Contract                    │
│  - Calculates rewards: baseRate × multiplier × time         │
│  - Users claim rewards themselves (they pay gas)             │
│  - Uses min(current balance, balance at last claim)          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Mints reward points
                         ↓
┌─────────────────────────────────────────────────────────────┐
│              RewardPoints Token (ERC20)                      │
│  - Non-transferable (soulbound)                              │
│  - Can ONLY be used for NFT tickets or game bets             │
│  - Burned on use                                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Burned for minting
                         ↓
┌─────────────────────────────────────────────────────────────┐
│           NFTLotteryMintingTierV11 (UUPS Proxy)             │
│  - Accepts: ETH, ERC20 tokens, AND Reward Points            │
│  - 10 tiers with exponential weights                         │
│  - Soulbound NFT lottery tickets                             │
│  - Gas optimized (O(1) minting)                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Provides participant data
                         ↓
┌─────────────────────────────────────────────────────────────┐
│              LotteryDrawManagerV2 Contract                   │
│  - Binary search winner selection O(log n)                   │
│  - 4 draw types: Weekly/Monthly/Quarterly/Yearly             │
│  - Bitcoin-style halving                                     │
│  - Multi-asset prize buckets                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### 1. Environment Setup
```bash
npm install
npx hardhat compile
```

### 2. Network Configuration
Edit `hardhat.config.js` to add your target network:

```javascript
networks: {
  sepolia: {
    url: process.env.SEPOLIA_RPC_URL,
    accounts: [process.env.PRIVATE_KEY]
  },
  mainnet: {
    url: process.env.MAINNET_RPC_URL,
    accounts: [process.env.PRIVATE_KEY]
  }
}
```

### 3. Environment Variables
Create `.env` file:
```bash
PRIVATE_KEY=your_deployer_private_key
SEPOLIA_RPC_URL=your_rpc_url
ETHERSCAN_API_KEY=your_etherscan_api_key
```

---

## Deployment Order

**CRITICAL: Deploy in this exact order!**

### Step 1: Deploy HODL Token (Your Main Token)

```javascript
// scripts/1_deploy_hodl_token.js
const { ethers } = require("hardhat");

async function main() {
  const HODLToken = await ethers.getContractFactory("HODLToken");
  const hodlToken = await HODLToken.deploy(
    "HODL Token",
    "HODL",
    ethers.parseEther("1000000000") // 1 billion tokens
  );
  await hodlToken.waitForDeployment();

  console.log("HODL Token deployed to:", await hodlToken.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the address:** `HODL_TOKEN_ADDRESS=0x...`

---

### Step 2: Deploy RewardPoints Token

```javascript
// scripts/2_deploy_reward_points.js
const { ethers } = require("hardhat");

async function main() {
  const RewardPoints = await ethers.getContractFactory("RewardPoints");
  const rewardPoints = await RewardPoints.deploy();
  await rewardPoints.waitForDeployment();

  console.log("RewardPoints deployed to:", await rewardPoints.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the address:** `REWARD_POINTS_ADDRESS=0x...`

---

### Step 3: Deploy RewardPointsManager

```javascript
// scripts/3_deploy_reward_manager.js
const { ethers } = require("hardhat");

async function main() {
  const HODL_TOKEN_ADDRESS = "0x..."; // From Step 1
  const REWARD_POINTS_ADDRESS = "0x..."; // From Step 2

  // Base reward rate: 1 reward point per token per day
  // = 1e18 / (24 * 60 * 60) = ~11574074074074 wei per second
  const BASE_REWARD_RATE = "11574074074074";

  const RewardPointsManager = await ethers.getContractFactory("RewardPointsManager");
  const rewardManager = await RewardPointsManager.deploy(
    HODL_TOKEN_ADDRESS,
    REWARD_POINTS_ADDRESS,
    BASE_REWARD_RATE
  );
  await rewardManager.waitForDeployment();

  console.log("RewardPointsManager deployed to:", await rewardManager.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the address:** `REWARD_MANAGER_ADDRESS=0x...`

---

### Step 4: Deploy NFT Lottery Minting Contract (UUPS Proxy)

```javascript
// scripts/4_deploy_minting_contract.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  const NFTLotteryMintingTierV11 = await ethers.getContractFactory("NFTLotteryMintingTierV11");

  const minting = await upgrades.deployProxy(
    NFTLotteryMintingTierV11,
    [],
    {
      initializer: "initialize",
      kind: "uups"
    }
  );
  await minting.waitForDeployment();

  console.log("NFT Minting Contract (Proxy) deployed to:", await minting.getAddress());
  console.log("Implementation deployed to:", await upgrades.erc1967.getImplementationAddress(await minting.getAddress()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the addresses:**
- `MINTING_PROXY_ADDRESS=0x...`
- `MINTING_IMPL_ADDRESS=0x...`

---

### Step 5: Deploy Lottery Draw Manager

```javascript
// scripts/5_deploy_draw_manager.js
const { ethers } = require("hardhat");

async function main() {
  const MINTING_PROXY_ADDRESS = "0x..."; // From Step 4
  const RANDOMNESS_MODE = 0; // 0 = PSEUDO_RANDOM, 1 = CHAINLINK_VRF

  const LotteryDrawManagerV2 = await ethers.getContractFactory("LotteryDrawManagerV2");
  const drawManager = await LotteryDrawManagerV2.deploy(
    MINTING_PROXY_ADDRESS,
    RANDOMNESS_MODE
  );
  await drawManager.waitForDeployment();

  console.log("Draw Manager deployed to:", await drawManager.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the address:** `DRAW_MANAGER_ADDRESS=0x...`

---

## Configuration Steps

After deployment, configure each contract in this order:

### 1. Configure RewardPoints Token

```javascript
// scripts/config/1_configure_reward_points.js
const rewardPoints = await ethers.getContractAt("RewardPoints", REWARD_POINTS_ADDRESS);

// Set the reward manager (can only be done ONCE!)
await rewardPoints.setRewardManager(REWARD_MANAGER_ADDRESS);

// Add NFT minting contract as authorized spender
await rewardPoints.addAuthorizedSpender(MINTING_PROXY_ADDRESS);

// Add any game contracts as authorized spenders (future)
// await rewardPoints.addAuthorizedSpender(GAME_CONTRACT_ADDRESS);

console.log("✅ RewardPoints configured");
```

---

### 2. Configure RewardPointsManager Multipliers

```javascript
// scripts/config/2_configure_reward_multipliers.js
const rewardManager = await ethers.getContractAt("RewardPointsManager", REWARD_MANAGER_ADDRESS);

// Set multiplier tiers
// Tier 0: 1x multiplier for 0+ tokens
await rewardManager.setMultiplierTier(
  0,
  10000, // 10000 basis points = 1x
  0      // 0 tokens minimum
);

// Tier 1: 1.5x multiplier for 1000+ tokens
await rewardManager.setMultiplierTier(
  1,
  15000, // 15000 basis points = 1.5x
  ethers.parseEther("1000")
);

// Tier 2: 2x multiplier for 10000+ tokens
await rewardManager.setMultiplierTier(
  2,
  20000, // 20000 basis points = 2x
  ethers.parseEther("10000")
);

// Tier 3: 3x multiplier for 100000+ tokens (whales)
await rewardManager.setMultiplierTier(
  3,
  30000, // 30000 basis points = 3x
  ethers.parseEther("100000")
);

console.log("✅ Reward multipliers configured");
```

---

### 3. Configure NFT Minting Contract

```javascript
// scripts/config/3_configure_minting_contract.js
const minting = await ethers.getContractAt("NFTLotteryMintingTierV11", MINTING_PROXY_ADDRESS);

// Set payment tokens
await minting.setPaymentToken(PAYMENT_TOKEN_ADDRESS); // Your ERC20 (e.g., USDC)
await minting.setAnotherPaymentToken(ANOTHER_TOKEN_ADDRESS); // Another ERC20
await minting.setRewardPointsToken(REWARD_POINTS_ADDRESS); // Reward points

// Set tier prices (example for tier 0)
// Tier 0: 0.001 ETH OR 1 USDC OR 10 Reward Points
await minting.setTierPrice(
  0, // tier
  ethers.parseEther("0.001"), // ETH price
  ethers.parseUnits("1", 6),  // USDC price (6 decimals)
  ethers.parseEther("0.5")    // Another token price
);

await minting.setTierPriceInRewardPoints(
  0, // tier
  ethers.parseEther("10") // 10 reward points
);

// Set all 10 tiers...
for (let i = 0; i < 10; i++) {
  const ethPrice = ethers.parseEther((0.001 * (2 ** i)).toString());
  const usdcPrice = ethers.parseUnits((1 * (2 ** i)).toString(), 6);
  const rewardPrice = ethers.parseEther((10 * (2 ** i)).toString());

  await minting.setTierPrice(i, ethPrice, usdcPrice, 0);
  await minting.setTierPriceInRewardPoints(i, rewardPrice);
}

console.log("✅ Minting contract configured");
```

---

### 4. Configure Lottery Draw Manager

```javascript
// scripts/config/4_configure_draw_manager.js
const drawManager = await ethers.getContractAt("LotteryDrawManagerV2", DRAW_MANAGER_ADDRESS);

// Configure Weekly draws
await drawManager.configureDrawType(
  0, // DrawType.WEEKLY
  ethers.parseEther("1"),  // 1 ETH prize
  52  // Halving every 52 weeks (1 year)
);

// Configure Monthly draws
await drawManager.configureDrawType(
  1, // DrawType.MONTHLY
  ethers.parseEther("10"), // 10 ETH prize
  12  // Halving every 12 months
);

// Configure Quarterly draws
await drawManager.configureDrawType(
  2, // DrawType.QUARTERLY
  ethers.parseEther("50"), // 50 ETH prize
  4   // Halving every 4 quarters
);

// Configure Yearly draws
await drawManager.configureDrawType(
  3, // DrawType.YEARLY
  ethers.parseEther("500"), // 500 ETH prize
  4   // Halving every 4 years
);

console.log("✅ Draw manager configured");
```

---

## Testing Checklist

### Testnet Testing Sequence

```bash
# 1. Test Reward Points Earning
node scripts/test/test_rewards.js

# 2. Test Minting with Different Payment Methods
node scripts/test/test_minting.js

# 3. Test Lottery Draws
node scripts/test/test_draws.js

# 4. Test Full User Journey
node scripts/test/test_user_journey.js
```

### Test Scenarios

- [ ] User holds HODL tokens
- [ ] User claims reward points after 1 day
- [ ] User claims reward points after 1 week
- [ ] User with higher balance gets higher rewards (multiplier test)
- [ ] User sells tokens, then claims (should use minimum balance)
- [ ] User mints NFT with ETH
- [ ] User mints NFT with ERC20 token
- [ ] User mints NFT with Reward Points (points are burned)
- [ ] Reward points cannot be transferred
- [ ] Weekly lottery draw executes correctly
- [ ] Halving occurs after configured interval
- [ ] Multi-asset prize distribution works
- [ ] Binary search winner selection works with 100+ participants

---

## Post-Deployment Configuration Summary

### Contract Addresses Checklist

Save all these addresses in a config file:

```json
{
  "network": "sepolia",
  "contracts": {
    "hodlToken": "0x...",
    "rewardPoints": "0x...",
    "rewardManager": "0x...",
    "mintingProxy": "0x...",
    "mintingImpl": "0x...",
    "drawManager": "0x..."
  },
  "configuration": {
    "baseRewardRate": "11574074074074",
    "multiplierTiers": [
      { "tier": 0, "multiplier": 10000, "threshold": "0" },
      { "tier": 1, "multiplier": 15000, "threshold": "1000" },
      { "tier": 2, "multiplier": 20000, "threshold": "10000" },
      { "tier": 3, "multiplier": 30000, "threshold": "100000" }
    ]
  }
}
```

### Required Setup Calls (In Order!)

1. ✅ `RewardPoints.setRewardManager(rewardManagerAddress)`
2. ✅ `RewardPoints.addAuthorizedSpender(mintingProxyAddress)`
3. ✅ `RewardPointsManager.setMultiplierTier(...)` for each tier
4. ✅ `NFTMinting.setPaymentToken(tokenAddress)`
5. ✅ `NFTMinting.setRewardPointsToken(rewardPointsAddress)`
6. ✅ `NFTMinting.setTierPrice(...)` for all 10 tiers
7. ✅ `NFTMinting.setTierPriceInRewardPoints(...)` for all 10 tiers
8. ✅ `DrawManager.configureDrawType(...)` for all 4 draw types

---

## Mainnet Deployment

### Pre-Deployment Checklist

- [ ] All tests passing (109/109)
- [ ] 2+ week testnet testing completed
- [ ] Bug bounty program completed
- [ ] No critical issues found
- [ ] Gas prices acceptable
- [ ] Sufficient ETH for deployment (~0.5 ETH)
- [ ] Multisig wallet ready for ownership
- [ ] Contract verification on Etherscan ready

### Deployment Steps

1. Deploy all contracts following the order above
2. Verify all contracts on Etherscan
3. Configure all contracts
4. Transfer ownership to multisig wallet
5. Fund prize pools
6. Announce launch

### Security Considerations

- Use a multisig wallet (Gnosis Safe) as owner
- Set appropriate gas limits
- Monitor for unusual activity
- Have pause functionality ready
- Keep emergency contact list

---

## Dashboard Integration

### Required Contract ABIs

```bash
# Export ABIs for frontend
npx hardhat export-abi
```

### Contract Addresses for Frontend

```javascript
// frontend/src/config/contracts.js
export const CONTRACTS = {
  HODL_TOKEN: "0x...",
  REWARD_POINTS: "0x...",
  REWARD_MANAGER: "0x...",
  NFT_MINTING: "0x...",
  DRAW_MANAGER: "0x..."
};
```

### Key Read Functions for Dashboard

**Reward Points:**
- `pendingRewards(address user)` - Show claimable rewards
- `getUserClaimData(address user)` - Full user stats
- `getUserMultiplier(address user)` - Current multiplier tier

**NFT Minting:**
- `tiers(uint256 tier)` - Get tier prices
- `balanceOf(address owner)` - NFTs owned
- `addressToLottoIDs(address owner)` - Lottery entries

**Draw Manager:**
- `getUserWins(address user)` - Draws won
- `getDrawDetails(uint256 drawId)` - Draw information
- `getDrawConfig(uint8 drawType)` - Next draw time

---

## Troubleshooting

### Common Issues

**Issue: "Reward manager already set"**
- Solution: This can only be set once. Deploy a new RewardPoints contract if needed.

**Issue: "Not authorized spender"**
- Solution: Call `addAuthorizedSpender()` on RewardPoints contract.

**Issue: "Reward points are non-transferable"**
- Solution: This is intended. Users can only use points for minting/betting.

**Issue: Gas estimation failed**
- Solution: Check that all prerequisite contracts are deployed and configured.

---

## Support & Resources

- GitHub: https://github.com/yourusername/TheHODLotto
- Documentation: [LOTTERY_SYSTEM_ANALYSIS.md](./LOTTERY_SYSTEM_ANALYSIS.md)
- Test Guide: [TEST_RUNNER.md](./TEST_RUNNER.md)

---

**Last Updated:** 2025-01-06
**Version:** 2.0 (with Reward Points System)
