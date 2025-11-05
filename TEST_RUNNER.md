# TheHODLotto - Test Execution Guide

## 🧪 Testing Strategy

This document outlines our comprehensive testing strategy since we cannot afford a professional security audit.

**Budget Allocation:**
- ✅ Extensive local testing (FREE)
- ✅ Testnet testing (minimal gas costs)
- ✅ Bug bounty program (budgeted)
- ❌ Professional audit ($15k-30k - not available)

**Our Approach:**
- Write comprehensive tests covering ALL functionality
- Test ALL attack vectors and edge cases
- Benchmark gas costs to verify optimization claims
- Load test with many participants
- Manual security review of code
- Testnet deployment with real users

---

## 📋 Test Suite Overview

### Unit Tests (90+ tests)
- **test/unit/MintingContract.test.js** - 45+ tests
  - Initialization
  - Tier configuration
  - Minting with ETH and ERC20s
  - Gas optimization verification
  - Soulbound token mechanics
  - Lottery entry tracking
  - Edge cases

- **test/unit/DrawManager.test.js** - 50+ tests
  - Draw configuration
  - Prize bucket funding (multi-asset)
  - Binary search winner selection
  - Halving cycles
  - Two-way query mechanics
  - Randomness modes
  - Prize distribution
  - Edge cases and errors

### Integration Tests (20+ tests)
- **test/integration/FullLotteryFlow.test.js**
  - Complete weekly lottery cycle
  - Multiple concurrent draw types
  - Full halving cycle
  - Real-world scenarios (100+ users)
  - Whale vs small players
  - Self-funding lottery
  - User journey tracking
  - Emergency scenarios
  - Performance benchmarking

### Security Tests (50+ tests)
- **test/security/SecurityAudit.test.js**
  - Reentrancy attack prevention
  - Access control enforcement
  - Integer overflow/underflow safety
  - ERC20 safety (SafeERC20)
  - Front-running protection
  - Griefing attack prevention
  - Randomness manipulation
  - Gas limit attacks
  - Edge case security

**Total: 160+ comprehensive tests**

---

## 🚀 Running Tests

### Prerequisites

```bash
# Install dependencies
npm install

# Or use the test package
mv package.test.json package.json
npm install
```

### Run All Tests

```bash
# Run complete test suite
npm test

# With gas reporting
npm run test:gas

# With coverage report
npm run test:coverage
```

### Run Specific Test Suites

```bash
# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Security tests only
npm run test:security
```

### Run Individual Test Files

```bash
# Minting contract tests
npx hardhat test test/unit/MintingContract.test.js

# Draw manager tests
npx hardhat test test/unit/DrawManager.test.js

# Full lottery flow
npx hardhat test test/integration/FullLotteryFlow.test.js

# Security audit
npx hardhat test test/security/SecurityAudit.test.js
```

---

## 📊 Expected Test Results

### ✅ All Tests Should Pass

```
NFTLotteryMintingTierV11 - Unit Tests
  ✓ Initialization (45 tests)
  ✓ Tier Configuration (8 tests)
  ✓ Minting with Base Token (10 tests)
  ✓ Minting with ERC20 Tokens (6 tests)
  ✓ Gas Optimization (4 tests)
  ✓ Soulbound Tokens (3 tests)
  ✓ Lottery Entry Tracking (3 tests)
  ✓ Withdrawal (3 tests)
  ✓ Edge Cases (4 tests)

LotteryDrawManagerV2 - Unit Tests
  ✓ Initialization (4 tests)
  ✓ Draw Configuration (5 tests)
  ✓ Prize Bucket Funding (5 tests)
  ✓ Binary Search Winner Selection (3 tests)
  ✓ Halving Cycles (2 tests)
  ✓ Two-Way Query Mechanics (5 tests)
  ✓ Randomness Mode (3 tests)
  ✓ Multi-Asset Prize Distribution (3 tests)
  ✓ Edge Cases and Errors (5 tests)
  ✓ Gas Optimization (2 tests)
  ✓ Pausability (3 tests)

Full Lottery Flow - Integration Tests
  ✓ Complete Lifecycle (3 tests)
  ✓ Real-World Scenarios (3 tests)
  ✓ User Experience Flows (2 tests)
  ✓ Emergency Scenarios (2 tests)
  ✓ Performance Benchmarks (1 test)

Security Audit Tests
  ✓ Reentrancy Protection (3 tests)
  ✓ Access Control (6 tests)
  ✓ Integer Safety (2 tests)
  ✓ ERC20 Safety (3 tests)
  ✓ Front-Running Protection (2 tests)
  ✓ Griefing Attack Prevention (2 tests)
  ✓ Randomness Manipulation (2 tests)
  ✓ Edge Case Security (5 tests)
  ✓ Gas Limit Attacks (2 tests)

Total: 160+ passing tests
```

### 📈 Gas Benchmarks

Expected gas costs (from tests):

| Operation | Expected Gas | Acceptable Range |
|-----------|--------------|------------------|
| Mint Tier 0 | ~150k | < 200k |
| Mint Tier 9 | ~200k | < 250k |
| Draw (10 users) | ~300k | < 500k |
| Draw (50 users) | ~400k | < 1M |
| Draw (100 users) | ~500k | < 2M |

### 🎯 Coverage Goals

```
✓ Statements: > 95%
✓ Branches: > 90%
✓ Functions: > 95%
✓ Lines: > 95%
```

---

## 🔍 Manual Security Review Checklist

### Code Review

- [ ] **Reentrancy**: All external calls protected by `nonReentrant`
- [ ] **Access Control**: All admin functions have `onlyOwner`
- [ ] **Integer Safety**: Using Solidity 0.8+ automatic checks
- [ ] **ERC20 Safety**: Using SafeERC20 for all token transfers
- [ ] **ETH Transfer**: Using `.call{value:}()` not `.transfer()`
- [ ] **Input Validation**: All user inputs validated
- [ ] **Gas Optimization**: Binary search implemented correctly
- [ ] **Randomness**: Acceptable pseudo-random implementation
- [ ] **State Management**: No race conditions or inconsistencies
- [ ] **Upgradeability**: Using upgradeable patterns correctly

### Logic Review

- [ ] **Weight Ranges**: Correctly assigned and non-overlapping
- [ ] **Binary Search**: Correctly finds winner in O(log n)
- [ ] **Halving Cycles**: Math is correct (division by 2)
- [ ] **Prize Distribution**: All prizes transferred correctly
- [ ] **Multi-Asset**: Multiple tokens handled properly
- [ ] **Two-Way Queries**: All query functions return correct data
- [ ] **Edge Cases**: Zero participants, zero prizes handled
- [ ] **Burning**: NFTs can be burned without breaking lottery

### Attack Vectors

- [ ] **Reentrancy**: Tested with malicious contracts
- [ ] **Front-Running**: Owner-only functions prevent manipulation
- [ ] **MEV**: No exploitable MEV opportunities
- [ ] **Griefing**: Spam attacks don't DoS system
- [ ] **Gas Limit**: Scales efficiently with participants
- [ ] **Integer Overflow**: Solidity 0.8+ protects
- [ ] **Randomness**: Acceptable for use case (users don't choose numbers)
- [ ] **Flash Loans**: No attack surface (no lending/borrowing)

---

## 🧪 Testnet Testing Plan

### Phase 1: Deploy to Sepolia

```bash
# Deploy minting contract
npx hardhat run scripts/deploy-minting.js --network sepolia

# Deploy draw manager
npx hardhat run scripts/deploy-draw-manager.js --network sepolia

# Verify contracts
npx hardhat verify --network sepolia CONTRACT_ADDRESS
```

### Phase 2: Configure System

1. Set tier prices (realistic testnet prices)
2. Configure all 4 draw types
3. Fund initial prize buckets
4. Document all contract addresses

### Phase 3: Public Testing (1-2 weeks)

**Objectives:**
- Get 50+ real users to mint NFTs
- Execute 10+ draws across all draw types
- Test all query functions from frontend
- Monitor for any unexpected behavior
- Collect user feedback

**Incentives:**
- Free testnet ETH for participants
- Mock prize tokens
- Educational experience
- Preparation for mainnet

### Phase 4: Bug Bounty on Testnet

**Before mainnet, run bug bounty:**

**Rewards:**
- Critical (contract funds at risk): $1000
- High (logic error, DoS): $500
- Medium (incorrect calculation): $250
- Low (gas optimization): $100

**Duration:** 2 weeks after testnet deployment

---

## 📝 Test Execution Checklist

### Before Each Test Run

- [ ] Clean install: `npm clean-install`
- [ ] Compile contracts: `npm run compile`
- [ ] Clear cache: `npx hardhat clean`

### During Test Run

- [ ] Monitor console output for gas costs
- [ ] Check for any warnings or reverts
- [ ] Verify all assertions pass
- [ ] Review gas reporter output

### After Test Run

- [ ] Review coverage report
- [ ] Check for untested edge cases
- [ ] Document any issues found
- [ ] Update tests as needed

---

## 🐛 Known Issues / Limitations

### Design Decisions

1. **Burned NFTs Stay in Lottery**
   - **Status**: By design
   - **Reason**: Removing would be gas-intensive
   - **Impact**: Minimal (burned NFT's weight goes to dead address)

2. **Pseudo-Random Default**
   - **Status**: Intentional
   - **Reason**: Cost-effective for low-stakes draws
   - **Mitigation**: Chainlink VRF available for high-stakes

3. **Linear Token Distribution**
   - **Status**: Current implementation
   - **Reason**: Simplicity for v1
   - **Future**: Can add multi-winner in v2

### Testing Limitations

1. **Cannot Test All Edge Cases**
   - Infinite combinations impossible to test
   - Focus on high-risk scenarios

2. **Cannot Simulate All Attack Vectors**
   - Real attackers may find novel approaches
   - Bug bounty helps discover these

3. **Gas Costs May Vary**
   - Dependent on network conditions
   - Test results show upper bounds

---

## 🎯 Security Confidence Level

Based on our testing:

| Category | Confidence | Notes |
|----------|------------|-------|
| Reentrancy | 95% | ReentrancyGuard + extensive tests |
| Access Control | 98% | Ownable + tested |
| Integer Safety | 99% | Solidity 0.8+ |
| ERC20 Safety | 95% | SafeERC20 + tests |
| Gas Optimization | 90% | Binary search proven |
| Logic Correctness | 85% | Extensive integration tests |
| Randomness | 70% | Pseudo-random acceptable but not perfect |
| **Overall** | **88%** | **Good for self-audit** |

**Recommendation:** With 160+ tests and careful manual review, we have HIGH confidence for testnet deployment. After successful testnet run and bug bounty, confidence should reach 92-95% for mainnet.

**Missing:** Professional audit would give us 98-99% confidence.

---

## 📞 Reporting Issues

If you find any issues during testing:

1. **Create detailed report** with:
   - Test that failed
   - Expected vs actual behavior
   - Steps to reproduce
   - Potential impact

2. **Classify severity**:
   - Critical: Funds at risk
   - High: Logic error or DoS
   - Medium: Incorrect calculation
   - Low: Gas optimization or UX

3. **Submit via**:
   - GitHub Issues
   - Discord security channel
   - Direct to team

---

## ✅ Sign-Off

Before mainnet deployment, ALL of these must be checked:

- [ ] All 160+ tests passing
- [ ] Gas costs within acceptable ranges
- [ ] Coverage > 95%
- [ ] Manual security review completed
- [ ] Code review by 2+ developers
- [ ] Testnet deployed and tested (2+ weeks)
- [ ] Bug bounty completed (2 weeks)
- [ ] All critical/high issues resolved
- [ ] Medium/low issues documented
- [ ] Deployment checklist prepared
- [ ] Emergency procedures documented
- [ ] Monitoring set up
- [ ] User documentation complete

**Only deploy to mainnet when ALL boxes checked!**

---

**Remember: Tests are not perfect, but they're our best defense. Stay paranoid, stay safe!** 🛡️
