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

### Step 2: Deploy RewardPoints Token (UUPS Proxy)

```javascript
// scripts/2_deploy_reward_points.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  const RewardPoints = await ethers.getContractFactory("RewardPoints");

  const rewardPoints = await upgrades.deployProxy(
    RewardPoints,
    [],
    {
      initializer: "initialize",
      kind: "uups"
    }
  );
  await rewardPoints.waitForDeployment();

  console.log("RewardPoints (Proxy) deployed to:", await rewardPoints.getAddress());
  console.log("Implementation deployed to:", await upgrades.erc1967.getImplementationAddress(await rewardPoints.getAddress()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the addresses:**
- `REWARD_POINTS_PROXY_ADDRESS=0x...`
- `REWARD_POINTS_IMPL_ADDRESS=0x...`

---

### Step 3: Deploy RewardPointsManager (UUPS Proxy)

```javascript
// scripts/3_deploy_reward_manager.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  const HODL_TOKEN_ADDRESS = "0x..."; // From Step 1
  const REWARD_POINTS_PROXY_ADDRESS = "0x..."; // From Step 2

  // Base reward rate: 1 reward point per token per day
  // = 1e18 / (24 * 60 * 60) = ~11574074074074 wei per second
  const BASE_REWARD_RATE = "11574074074074";

  const RewardPointsManager = await ethers.getContractFactory("RewardPointsManager");
  const rewardManager = await upgrades.deployProxy(
    RewardPointsManager,
    [
      HODL_TOKEN_ADDRESS,
      REWARD_POINTS_PROXY_ADDRESS,
      BASE_REWARD_RATE
    ],
    {
      initializer: "initialize",
      kind: "uups"
    }
  );
  await rewardManager.waitForDeployment();

  console.log("RewardPointsManager (Proxy) deployed to:", await rewardManager.getAddress());
  console.log("Implementation deployed to:", await upgrades.erc1967.getImplementationAddress(await rewardManager.getAddress()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the addresses:**
- `REWARD_MANAGER_PROXY_ADDRESS=0x...`
- `REWARD_MANAGER_IMPL_ADDRESS=0x...`

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

### Step 5: Deploy Lottery Draw Manager (UUPS Proxy)

```javascript
// scripts/5_deploy_draw_manager.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  const MINTING_PROXY_ADDRESS = "0x..."; // From Step 4
  const RANDOMNESS_MODE = 0; // 0 = PSEUDO_RANDOM, 1 = CHAINLINK_VRF

  const LotteryDrawManagerV2 = await ethers.getContractFactory("LotteryDrawManagerV2");
  const drawManager = await upgrades.deployProxy(
    LotteryDrawManagerV2,
    [
      MINTING_PROXY_ADDRESS,
      RANDOMNESS_MODE
    ],
    {
      initializer: "initialize",
      kind: "uups"
    }
  );
  await drawManager.waitForDeployment();

  console.log("Draw Manager (Proxy) deployed to:", await drawManager.getAddress());
  console.log("Implementation deployed to:", await upgrades.erc1967.getImplementationAddress(await drawManager.getAddress()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

**Save the addresses:**
- `DRAW_MANAGER_PROXY_ADDRESS=0x...`
- `DRAW_MANAGER_IMPL_ADDRESS=0x...`

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

## Upgrading Contracts

All contracts (except HODLToken) use the UUPS (Universal Upgradeable Proxy Standard) pattern, which allows you to upgrade the implementation while preserving the contract address and state.

### When to Upgrade

- Fix bugs in contract logic
- Add new features
- Optimize gas usage
- Improve security

### How to Upgrade

**IMPORTANT:** Only the owner can upgrade contracts. The proxy address remains the same.

#### Upgrade RewardPoints

```javascript
// scripts/upgrade/upgrade_reward_points.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  const REWARD_POINTS_PROXY_ADDRESS = "0x..."; // Your deployed proxy

  const RewardPointsV2 = await ethers.getContractFactory("RewardPointsV2");

  console.log("Upgrading RewardPoints...");
  const upgraded = await upgrades.upgradeProxy(
    REWARD_POINTS_PROXY_ADDRESS,
    RewardPointsV2
  );

  await upgraded.waitForDeployment();

  console.log("RewardPoints upgraded successfully");
  console.log("Proxy address (unchanged):", await upgraded.getAddress());
  console.log("New implementation:", await upgrades.erc1967.getImplementationAddress(await upgraded.getAddress()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

#### Upgrade RewardPointsManager

```javascript
// scripts/upgrade/upgrade_reward_manager.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  const REWARD_MANAGER_PROXY_ADDRESS = "0x...";

  const RewardPointsManagerV2 = await ethers.getContractFactory("RewardPointsManagerV2");

  console.log("Upgrading RewardPointsManager...");
  const upgraded = await upgrades.upgradeProxy(
    REWARD_MANAGER_PROXY_ADDRESS,
    RewardPointsManagerV2
  );

  console.log("RewardPointsManager upgraded successfully");
  console.log("Proxy address (unchanged):", await upgraded.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

#### Upgrade LotteryDrawManagerV2

```javascript
// scripts/upgrade/upgrade_draw_manager.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  const DRAW_MANAGER_PROXY_ADDRESS = "0x...";

  const LotteryDrawManagerV3 = await ethers.getContractFactory("LotteryDrawManagerV3");

  console.log("Upgrading LotteryDrawManager...");
  const upgraded = await upgrades.upgradeProxy(
    DRAW_MANAGER_PROXY_ADDRESS,
    LotteryDrawManagerV3
  );

  console.log("LotteryDrawManager upgraded successfully");
  console.log("Proxy address (unchanged):", await upgraded.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### Upgrade Safety

**Before upgrading in production:**

1. **Test on testnet first** - Always test upgrades on testnet
2. **Validate upgrade** - Run validation before deploying:
   ```bash
   npx hardhat run scripts/upgrade/validate_upgrade.js
   ```
3. **Backup state** - Document current contract state
4. **Pause contracts** - Pause contracts during upgrade if possible
5. **Verify on Etherscan** - Verify new implementation after upgrade

**Storage Layout Warning:**

⚠️ **CRITICAL:** When upgrading, you CANNOT:
- Change the order of existing state variables
- Change the type of existing state variables
- Remove existing state variables

You CAN:
- Add new state variables at the end
- Add new functions
- Modify function logic

### Admin Controls Available

All upgradeable contracts have comprehensive admin controls:

**RewardPointsManager:**
- `setBaseRewardRate(uint256)` - Update earning rate
- `setMinClaimInterval(uint256)` - Change claim frequency
- `setMultiplierTier(uint256, uint256, uint256)` - Update multipliers
- `removeLastTier()` - Remove multiplier tiers
- `pause()`/`unpause()` - Emergency controls

**LotteryDrawManagerV2:**
- `setDrawInterval(DrawType, uint256)` - Change draw timing
- `setRandomnessMode(RandomnessMode)` - Switch randomness source
- `setDrawTypeActive(DrawType, bool)` - Enable/disable draw types
- `pause()`/`unpause()` - Emergency controls

**NFTLotteryMintingTierV11:**
- `setTierPrice(uint256, uint256, uint256, uint256, uint256)` - Update prices
- `setTierWeight(uint256, uint256)` - Update tier weights
- `setRewardPointsToken(address)` - Set reward points address
- `setTierPriceInRewardPoints(uint256, uint256)` - Update point prices
- `activateLottery()`/`deactivateLottery()` - Control minting

**RewardPoints:**
- `addAuthorizedSpender(address)` - Add contracts that can burn points
- `removeAuthorizedSpender(address)` - Remove spender authorization
- Note: `setRewardManager()` can only be called ONCE

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
**Version:** 2.1 (UUPS Upgradeable with Reward Points System)
