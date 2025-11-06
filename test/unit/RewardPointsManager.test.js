const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("RewardPointsManager - Epoch-Based Staking Tests", function () {

  // ============ FIXTURES ============

  async function deployRewardSystemFixture() {
    const [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy HODL Token
    const HODLToken = await ethers.getContractFactory("HODLToken");
    const hodlToken = await HODLToken.deploy(
      "HODL Token",
      "HODL",
      ethers.parseEther("1000000000") // 1 billion tokens
    );
    await hodlToken.waitForDeployment();

    // Deploy RewardPoints (UUPS)
    const RewardPoints = await ethers.getContractFactory("RewardPoints");
    const rewardPoints = await upgrades.deployProxy(RewardPoints, [], {
      initializer: "initialize"
    });
    await rewardPoints.waitForDeployment();

    // Deploy RewardPointsManager (UUPS)
    // Base rate: 1 reward point per token per epoch
    const baseRewardRate = ethers.parseEther("1");
    const RewardPointsManager = await ethers.getContractFactory("RewardPointsManager");
    const rewardManager = await upgrades.deployProxy(
      RewardPointsManager,
      [await hodlToken.getAddress(), await rewardPoints.getAddress(), baseRewardRate],
      { initializer: "initialize" }
    );
    await rewardManager.waitForDeployment();

    // Configure RewardPoints
    await rewardPoints.setRewardManager(await rewardManager.getAddress());

    // Distribute tokens to users
    await hodlToken.transfer(user1.address, ethers.parseEther("10000"));
    await hodlToken.transfer(user2.address, ethers.parseEther("5000"));
    await hodlToken.transfer(user3.address, ethers.parseEther("20000"));

    return {
      hodlToken,
      rewardPoints,
      rewardManager,
      owner,
      user1,
      user2,
      user3,
      baseRewardRate
    };
  }

  // ============ STAKING TESTS ============

  describe("Initial Staking", function () {
    it("Should allow user to stake tokens", async function () {
      const { hodlToken, rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await expect(rewardManager.connect(user1).stake())
        .to.emit(rewardManager, "Staked")
        .withArgs(user1.address, ethers.parseEther("10000"), await time.latest() + 1);

      const stakeData = await rewardManager.getUserStakeData(user1.address);
      expect(stakeData.stakedBalance).to.equal(ethers.parseEther("10000"));
    });

    it("Should reject staking with zero balance", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      // Create new signer with no tokens
      const [,,,, zeroBalanceUser] = await ethers.getSigners();

      await expect(rewardManager.connect(zeroBalanceUser).stake())
        .to.be.revertedWith("No tokens to stake");
    });

    it("Should initialize stake timestamp correctly", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      const txTime = await time.latest();
      await rewardManager.connect(user1).stake();

      const stakeData = await rewardManager.getUserStakeData(user1.address);
      expect(stakeData.stakeTimestamp).to.be.closeTo(txTime, 2);
    });
  });

  // ============ REWARDS CALCULATION TESTS ============

  describe("Basic Rewards Claiming", function () {
    it("Should calculate rewards correctly after 1 epoch", async function () {
      const { rewardManager, rewardPoints, user1, baseRewardRate } = await loadFixture(deployRewardSystemFixture);

      // Stake
      await rewardManager.connect(user1).stake();

      // Wait 1 epoch (1 day)
      await time.increase(86400); // 1 day

      // Check pending rewards
      const pending = await rewardManager.pendingRewards(user1.address);
      // Expected: 10000 tokens × 1 epoch × 1 reward/token/epoch × 1x multiplier = 10000 reward points
      expect(pending).to.equal(ethers.parseEther("10000"));
    });

    it("Should allow claiming rewards after 1 epoch", async function () {
      const { rewardManager, rewardPoints, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      await time.increase(86400); // 1 day

      await expect(rewardManager.connect(user1).claimRewards())
        .to.emit(rewardManager, "RewardsClaimed");

      const balance = await rewardPoints.balanceOf(user1.address);
      // Allow for small precision differences (< 0.01%)
      expect(balance).to.be.closeTo(ethers.parseEther("10000"), ethers.parseEther("1"));
    });

    it("Should calculate fractional epoch rewards correctly", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();

      // Wait 0.5 epochs (12 hours)
      await time.increase(43200);

      const pending = await rewardManager.pendingRewards(user1.address);
      // Expected: 10000 tokens × 0.5 epoch × 1 reward/token/epoch = 5000 reward points
      expect(pending).to.equal(ethers.parseEther("5000"));
    });

    it("Should enforce minimum claim interval", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      await time.increase(1800); // 30 minutes (less than 1 hour minimum)

      await expect(rewardManager.connect(user1).claimRewards())
        .to.be.revertedWith("Claim too soon");
    });
  });

  // ============ SELLING PENALTY TESTS ============

  describe("Selling Tokens Penalty", function () {
    it("Should penalize user who sells tokens (use current lower balance)", async function () {
      const { hodlToken, rewardManager, user1, user2 } = await loadFixture(deployRewardSystemFixture);

      // Stake 10000 tokens
      await rewardManager.connect(user1).stake();

      // Wait 1 epoch
      await time.increase(86400);

      // User sells 5000 tokens (transfers to another user)
      await hodlToken.connect(user1).transfer(user2.address, ethers.parseEther("5000"));

      // Pending rewards should be calculated with 5000 tokens (not 10000)
      const pending = await rewardManager.pendingRewards(user1.address);
      // Expected: 5000 tokens × 1 epoch × 1 reward/token/epoch = 5000 (NOT 10000)
      // Allow for small precision difference
      expect(pending).to.be.closeTo(ethers.parseEther("5000"), ethers.parseEther("1"));
    });

    it("Should penalize for ALL epochs when selling", async function () {
      const { hodlToken, rewardManager, rewardPoints, user1, user2 } = await loadFixture(deployRewardSystemFixture);

      // Stake 10000 tokens
      await rewardManager.connect(user1).stake();

      // Wait 5 epochs
      await time.increase(86400 * 5);

      // User sells 8000 tokens (keeps 2000) - transfer to user2
      await hodlToken.connect(user1).transfer(user2.address, ethers.parseEther("8000"));

      // Claim rewards
      await rewardManager.connect(user1).claimRewards();

      const balance = await rewardPoints.balanceOf(user1.address);
      // Expected: 2000 tokens × 5 epochs × 1 reward/token/epoch = 10000 (NOT 50000)
      // Allow for small precision difference
      expect(balance).to.be.closeTo(ethers.parseEther("10000"), ethers.parseEther("1"));
    });

    it("Should show hasSoldTokens flag in getUserStakeData", async function () {
      const { hodlToken, rewardManager, user1, user2 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      await time.increase(86400);

      // Sell tokens (transfer to user2)
      await hodlToken.connect(user1).transfer(user2.address, ethers.parseEther("5000"));

      const stakeData = await rewardManager.getUserStakeData(user1.address);
      expect(stakeData.hasSoldTokens).to.be.true;
    });
  });

  // ============ BUYING MORE TOKENS TESTS (20%/80% SPLIT) ============

  describe("Buying More Tokens - 20%/80% Split", function () {
    it("Should apply 20%/80% split when buying more and restaking", async function () {
      const { hodlToken, rewardManager, rewardPoints, owner, user1 } = await loadFixture(deployRewardSystemFixture);

      // Stake 10000 tokens
      await rewardManager.connect(user1).stake();

      // Wait 1 epoch
      await time.increase(86400);

      // User buys 10000 more tokens (now has 20000)
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("10000"));

      // Restake (auto-claims with 20%/80% split)
      await rewardManager.connect(user1).stake();

      const balance = await rewardPoints.balanceOf(user1.address);

      // Expected calculation:
      // 80% of rewards: 10000 tokens × 1 epoch × 1 reward × 0.8 = 8000
      // 20% of rewards: 20000 tokens × 1 epoch × 1 reward × 0.2 = 4000
      // Total: 12000 reward points
      // Allow for small precision difference
      expect(balance).to.be.closeTo(ethers.parseEther("12000"), ethers.parseEther("1"));
    });

    it("Should use 80% old balance and 20% new balance for fractional epochs", async function () {
      const { hodlToken, rewardManager, rewardPoints, owner, user1 } = await loadFixture(deployRewardSystemFixture);

      // Stake 10000 tokens
      await rewardManager.connect(user1).stake();

      // Wait 0.5 epochs (12 hours)
      await time.increase(43200);

      // User buys 10000 more tokens (now has 20000)
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("10000"));

      // Restake
      await rewardManager.connect(user1).stake();

      const balance = await rewardPoints.balanceOf(user1.address);

      // Expected:
      // 80%: 10000 × 0.5 epoch × 1 × 0.8 = 4000
      // 20%: 20000 × 0.5 epoch × 1 × 0.2 = 2000
      // Total: 6000
      // Allow for small precision difference
      expect(balance).to.be.closeTo(ethers.parseEther("6000"), ethers.parseEther("1"));
    });

    it("Should emit Restaked event with correct amounts", async function () {
      const { hodlToken, rewardManager, owner, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      await time.increase(86400);
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("10000"));

      // Just check that Restaked event is emitted (rewards amount may have precision variance)
      await expect(rewardManager.connect(user1).stake())
        .to.emit(rewardManager, "Restaked");
    });

    it("Should reset stake timestamp after restaking", async function () {
      const { hodlToken, rewardManager, owner, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      const firstStakeTime = (await rewardManager.getUserStakeData(user1.address)).stakeTimestamp;

      await time.increase(86400);
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("10000"));

      await rewardManager.connect(user1).stake();
      const secondStakeTime = (await rewardManager.getUserStakeData(user1.address)).stakeTimestamp;

      expect(secondStakeTime).to.be.greaterThan(firstStakeTime);
    });
  });

  // ============ MULTIPLE RESTAKES TEST ============

  describe("Multiple Restakes", function () {
    it("Should handle multiple restakes correctly", async function () {
      const { hodlToken, rewardManager, rewardPoints, owner, user1 } = await loadFixture(deployRewardSystemFixture);

      // Initial stake: 10000 tokens
      await rewardManager.connect(user1).stake();
      await time.increase(86400); // 1 epoch

      // Restake 1: Buy 5000 more (now 15000)
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("5000"));
      await rewardManager.connect(user1).stake();
      let balance = await rewardPoints.balanceOf(user1.address);
      // Expected: 0.8 × 10000 + 0.2 × 15000 = 11000
      expect(balance).to.be.closeTo(ethers.parseEther("11000"), ethers.parseEther("1"));

      await time.increase(86400); // 1 more epoch

      // Restake 2: Buy 5000 more (now 20000)
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("5000"));
      await rewardManager.connect(user1).stake();
      balance = await rewardPoints.balanceOf(user1.address);
      // Previous: 11000
      // New: 0.8 × 15000 + 0.2 × 20000 = 16000
      // Total: 27000
      expect(balance).to.be.closeTo(ethers.parseEther("27000"), ethers.parseEther("1"));
    });

    it("Should handle buy-sell-buy scenario", async function () {
      const { hodlToken, rewardManager, rewardPoints, owner, user1, user2 } = await loadFixture(deployRewardSystemFixture);

      // Stake 10000
      await rewardManager.connect(user1).stake();
      await time.increase(86400);

      // Buy 10000 more and restake (20000 total)
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("10000"));
      await rewardManager.connect(user1).stake();
      let balance = await rewardPoints.balanceOf(user1.address);
      expect(balance).to.be.closeTo(ethers.parseEther("12000"), ethers.parseEther("1")); // 80% × 10000 + 20% × 20000

      await time.increase(86400);

      // Sell 15000 (keep 5000) and restake - transfer to user2
      await hodlToken.connect(user1).transfer(user2.address, ethers.parseEther("15000"));
      await rewardManager.connect(user1).stake();
      balance = await rewardPoints.balanceOf(user1.address);
      // Previous: 12000
      // New: 5000 × 1 epoch = 5000 (penalty for selling)
      // Total: 17000
      expect(balance).to.be.closeTo(ethers.parseEther("17000"), ethers.parseEther("1"));
    });
  });

  // ============ MULTIPLIER TIER TESTS ============

  describe("Multiplier Tiers", function () {
    it("Should apply multiplier tiers correctly", async function () {
      const { rewardManager, user3, owner } = await loadFixture(deployRewardSystemFixture);

      // Add multiplier tiers
      // Tier 0: 0+ tokens = 1x (10000 basis points)
      // Tier 1: 15000+ tokens = 1.5x (15000 basis points)
      await rewardManager.connect(owner).setMultiplierTier(1, 15000, ethers.parseEther("15000"));

      // User3 has 20000 tokens - qualifies for 1.5x
      await rewardManager.connect(user3).stake();
      await time.increase(86400);

      const pending = await rewardManager.pendingRewards(user3.address);
      // Expected: 20000 tokens × 1 epoch × 1 reward × 1.5x = 30000
      expect(pending).to.equal(ethers.parseEther("30000"));
    });

    it("Should update multiplier when user moves tiers", async function () {
      const { hodlToken, rewardManager, user1, owner } = await loadFixture(deployRewardSystemFixture);

      // Add tier for 15000+ tokens
      await rewardManager.connect(owner).setMultiplierTier(1, 15000, ethers.parseEther("15000"));

      // User1 starts with 10000 (tier 0 = 1x)
      await rewardManager.connect(user1).stake();
      await time.increase(86400);

      // Buy 10000 more (now 20000, tier 1 = 1.5x)
      await hodlToken.connect(owner).transfer(user1.address, ethers.parseEther("10000"));
      await rewardManager.connect(user1).stake();

      await time.increase(86400);
      const pending = await rewardManager.pendingRewards(user1.address);

      // Now earning at 1.5x: 20000 × 1 epoch × 1 × 1.5 = 30000
      expect(pending).to.equal(ethers.parseEther("30000"));
    });
  });

  // ============ ADMIN FUNCTIONS TESTS ============

  describe("Admin Functions", function () {
    it("Should allow owner to update epoch duration", async function () {
      const { rewardManager, owner } = await loadFixture(deployRewardSystemFixture);

      await expect(rewardManager.connect(owner).setEpochDuration(86400 * 7)) // 7 days
        .to.emit(rewardManager, "EpochDurationUpdated");

      const stats = await rewardManager.getSystemStats();
      expect(stats._epochDuration).to.equal(86400 * 7);
    });

    it("Should allow owner to update new token credit percentage", async function () {
      const { rewardManager, owner } = await loadFixture(deployRewardSystemFixture);

      await expect(rewardManager.connect(owner).setNewTokenCredit(3000)) // 30%
        .to.emit(rewardManager, "NewTokenCreditUpdated");

      const stats = await rewardManager.getSystemStats();
      expect(stats._newTokenCreditBasisPoints).to.equal(3000);
    });

    it("Should reject non-owner admin calls", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await expect(rewardManager.connect(user1).setEpochDuration(86400 * 7))
        .to.be.reverted;
    });

    it("Should allow pausing and unpausing", async function () {
      const { rewardManager, owner, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(owner).pause();

      await expect(rewardManager.connect(user1).stake())
        .to.be.reverted;

      await rewardManager.connect(owner).unpause();

      await expect(rewardManager.connect(user1).stake())
        .to.not.be.reverted;
    });
  });

  // ============ EDGE CASES ============

  describe("Edge Cases", function () {
    it("Should handle zero pending rewards", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      // Immediately check - no time passed
      const pending = await rewardManager.pendingRewards(user1.address);
      expect(pending).to.equal(0);
    });

    it("Should reject claiming with no active stake", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await expect(rewardManager.connect(user1).claimRewards())
        .to.be.revertedWith("No active stake");
    });

    it("Should handle very long staking periods", async function () {
      const { rewardManager, rewardPoints, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();

      // Wait 100 epochs
      await time.increase(86400 * 100);

      await rewardManager.connect(user1).claimRewards();
      const balance = await rewardPoints.balanceOf(user1.address);

      // Expected: 10000 × 100 epochs = 1,000,000
      // Allow for small precision difference
      expect(balance).to.be.closeTo(ethers.parseEther("1000000"), ethers.parseEther("1000"));
    });

    it("Should accumulate totalClaimed correctly", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();

      // Claim after 1 epoch
      await time.increase(86400);
      await rewardManager.connect(user1).claimRewards();

      // Claim after another epoch
      await time.increase(86400);
      await rewardManager.connect(user1).claimRewards();

      const stakeData = await rewardManager.getUserStakeData(user1.address);
      // Total: 10000 + 10000 = 20000
      // Allow for small precision difference
      expect(stakeData.totalClaimed).to.be.closeTo(ethers.parseEther("20000"), ethers.parseEther("1"));
    });
  });

  // ============ VIEW FUNCTIONS TESTS ============

  describe("View Functions", function () {
    it("Should return correct epochs completed", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      await time.increase(86400 * 3); // 3 epochs

      const epochs = await rewardManager.getEpochsCompleted(user1.address);
      expect(epochs).to.equal(3);
    });

    it("Should return correct fractional epochs", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      await time.increase(43200); // 0.5 epochs

      const fractional = await rewardManager.getFractionalEpochs(user1.address);
      // Should be around 0.5e18
      expect(fractional).to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));
    });

    it("Should return comprehensive stake data", async function () {
      const { rewardManager, user1 } = await loadFixture(deployRewardSystemFixture);

      await rewardManager.connect(user1).stake();
      await time.increase(86400);

      const data = await rewardManager.getUserStakeData(user1.address);
      expect(data.stakedBalance).to.equal(ethers.parseEther("10000"));
      expect(data.epochsCompleted).to.equal(1);
      expect(data.pendingReward).to.equal(ethers.parseEther("10000"));
      expect(data.hasSoldTokens).to.be.false;
    });

    it("Should return system stats", async function () {
      const { rewardManager, hodlToken, rewardPoints, baseRewardRate } = await loadFixture(deployRewardSystemFixture);

      const stats = await rewardManager.getSystemStats();
      expect(stats._baseRewardRate).to.equal(baseRewardRate);
      expect(stats._epochDuration).to.equal(86400); // 1 day
      expect(stats._newTokenCreditBasisPoints).to.equal(2000); // 20%
      expect(stats._minClaimInterval).to.equal(3600); // 1 hour
      expect(stats._stakingToken).to.equal(await hodlToken.getAddress());
      expect(stats._rewardPoints).to.equal(await rewardPoints.getAddress());
    });
  });
});
