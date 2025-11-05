const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("LotteryDrawManagerV2 - Unit Tests", function () {

  // ============ FIXTURES ============

  async function deployFullSystemFixture() {
    const [owner, user1, user2, user3, user4, user5] = await ethers.getSigners();

    // Deploy mock ERC20 tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const paymentToken = await MockERC20.deploy("Payment Token", "PAY", ethers.parseEther("1000000"));
    const prizeToken1 = await MockERC20.deploy("Prize Token 1", "PZ1", ethers.parseEther("1000000"));
    const prizeToken2 = await MockERC20.deploy("Prize Token 2", "PZ2", ethers.parseEther("1000000"));

    // Deploy minting contract
    const MintingContract = await ethers.getContractFactory("NFTLotteryMintingTierV11");
    const minting = await upgrades.deployProxy(MintingContract, [], {
      initializer: "initialize"
    });
    await minting.waitForDeployment();

    // Set payment token and prices
    await minting.setPaymentToken(await paymentToken.getAddress());

    for (let i = 0; i < 10; i++) {
      const price = ethers.parseEther((0.001 * (2 ** i)).toString());
      await minting.setTierPrice(i, price, 0, 0);
    }

    // Deploy draw manager
    const DrawManager = await ethers.getContractFactory("LotteryDrawManagerV2");
    const drawManager = await DrawManager.deploy(
      await minting.getAddress(),
      0 // PSEUDO_RANDOM
    );
    await drawManager.waitForDeployment();

    // Distribute tokens
    for (const user of [user1, user2, user3, user4, user5]) {
      await paymentToken.transfer(user.address, ethers.parseEther("10000"));
    }

    return {
      minting,
      drawManager,
      paymentToken,
      prizeToken1,
      prizeToken2,
      owner,
      user1,
      user2,
      user3,
      user4,
      user5
    };
  }

  async function deployWithParticipantsFixture() {
    const fixture = await deployFullSystemFixture();
    const { minting, user1, user2, user3 } = fixture;

    // User1: Mint Tier 0 (weight 1)
    await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

    // User2: Mint Tier 9 (weight 512)
    await minting.connect(user2).mintWithBaseToken(9, { value: ethers.parseEther("0.512") });

    // User3: Mint Tier 3 (weight 8)
    await minting.connect(user3).mintWithBaseToken(3, { value: ethers.parseEther("0.008") });

    return fixture;
  }

  // ============ INITIALIZATION TESTS ============

  describe("Initialization", function () {
    it("Should initialize with correct minting contract", async function () {
      const { drawManager, minting } = await loadFixture(deployFullSystemFixture);
      expect(await drawManager.mintingContract()).to.equal(await minting.getAddress());
    });

    it("Should initialize with PSEUDO_RANDOM mode", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);
      expect(await drawManager.randomnessMode()).to.equal(0); // PSEUDO_RANDOM
    });

    it("Should initialize with zero total draw count", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);
      expect(await drawManager.totalDrawCount()).to.equal(0);
    });

    it("Should allow owner to configure draw types", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      await expect(
        drawManager.configureDrawType(0, ethers.parseEther("1"), 52) // WEEKLY
      ).to.emit(drawManager, "DrawConfigured")
        .withArgs(0, ethers.parseEther("1"), 52, 7 * 24 * 60 * 60);
    });
  });

  // ============ DRAW CONFIGURATION TESTS ============

  describe("Draw Configuration", function () {
    it("Should configure all four draw types", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      // Weekly: 1 ETH, halve every 52 draws
      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);

      // Monthly: 10 ETH, halve every 12 draws
      await drawManager.configureDrawType(1, ethers.parseEther("10"), 12);

      // Quarterly: 50 ETH, halve every 4 draws
      await drawManager.configureDrawType(2, ethers.parseEther("50"), 4);

      // Yearly: 500 ETH, halve every 4 draws
      await drawManager.configureDrawType(3, ethers.parseEther("500"), 4);

      // Verify configurations
      const weekly = await drawManager.getDrawConfig(0);
      expect(weekly.initialPrize).to.equal(ethers.parseEther("1"));
      expect(weekly.currentPrize).to.equal(ethers.parseEther("1"));
      expect(weekly.halvingInterval).to.equal(52);
      expect(weekly.drawInterval).to.equal(7 * 24 * 60 * 60);
      expect(weekly.active).to.be.true;
    });

    it("Should reject zero initial prize", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      await expect(
        drawManager.configureDrawType(0, 0, 52)
      ).to.be.revertedWith("Prize must be > 0");
    });

    it("Should reject zero halving interval", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      await expect(
        drawManager.configureDrawType(0, ethers.parseEther("1"), 0)
      ).to.be.revertedWith("Halving interval must be > 0");
    });

    it("Should reject configuration from non-owner", async function () {
      const { drawManager, user1 } = await loadFixture(deployFullSystemFixture);

      await expect(
        drawManager.connect(user1).configureDrawType(0, ethers.parseEther("1"), 52)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  // ============ PRIZE BUCKET FUNDING TESTS ============

  describe("Prize Bucket Funding", function () {
    it("Should fund bucket with ETH", async function () {
      const { drawManager, owner } = await loadFixture(deployFullSystemFixture);

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);

      await expect(
        drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") })
      ).to.emit(drawManager, "PrizeBucketFunded");

      const bucket = await drawManager.getPrizeBucketStatus(0);
      expect(bucket.ethAmount).to.equal(ethers.parseEther("10"));
    });

    it("Should fund bucket with ERC20 tokens", async function () {
      const { drawManager, prizeToken1, owner } = await loadFixture(deployFullSystemFixture);

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);

      const amount = ethers.parseEther("1000");
      await prizeToken1.approve(await drawManager.getAddress(), amount);

      await expect(
        drawManager.fundPrizeBucket(
          0,
          [await prizeToken1.getAddress()],
          [amount]
        )
      ).to.emit(drawManager, "PrizeBucketFunded");

      const bucket = await drawManager.getPrizeBucketStatus(0);
      expect(bucket.tokens[0]).to.equal(await prizeToken1.getAddress());
      expect(bucket.amounts[0]).to.equal(amount);
    });

    it("Should fund bucket with ETH + multiple ERC20 tokens", async function () {
      const { drawManager, prizeToken1, prizeToken2, owner } = await loadFixture(deployFullSystemFixture);

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);

      const amount1 = ethers.parseEther("1000");
      const amount2 = ethers.parseEther("2000");

      await prizeToken1.approve(await drawManager.getAddress(), amount1);
      await prizeToken2.approve(await drawManager.getAddress(), amount2);

      await drawManager.fundPrizeBucket(
        0,
        [await prizeToken1.getAddress(), await prizeToken2.getAddress()],
        [amount1, amount2],
        { value: ethers.parseEther("5") }
      );

      const bucket = await drawManager.getPrizeBucketStatus(0);
      expect(bucket.ethAmount).to.equal(ethers.parseEther("5"));
      expect(bucket.tokens.length).to.equal(2);
    });

    it("Should reject funding with mismatched array lengths", async function () {
      const { drawManager, prizeToken1 } = await loadFixture(deployFullSystemFixture);

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);

      await expect(
        drawManager.fundPrizeBucket(
          0,
          [await prizeToken1.getAddress()],
          [ethers.parseEther("1000"), ethers.parseEther("2000")]
        )
      ).to.be.revertedWith("Array length mismatch");
    });
  });

  // ============ BINARY SEARCH WINNER SELECTION TESTS ============

  describe("Binary Search Winner Selection", function () {
    it("Should select winner correctly with binary search", async function () {
      const { drawManager, minting, user1, user2, user3 } = await loadFixture(deployWithParticipantsFixture);

      // Configure and fund
      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      // Fast forward time
      await time.increase(7 * 24 * 60 * 60 + 1);

      // Execute draw
      const tx = await drawManager.executeDraw(0);
      const receipt = await tx.wait();

      console.log(`      Draw execution gas: ${receipt.gasUsed}`);

      // Check draw was executed
      const draw = await drawManager.getDrawDetails(1);
      expect(draw.winner).to.be.oneOf([user1.address, user2.address, user3.address]);
    });

    it("Should respect weighted probabilities", async function () {
      const { drawManager, minting, user1, user2 } = await loadFixture(deployFullSystemFixture);

      // User1: Tier 0 (weight 1)
      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // User2: Tier 9 (weight 512)
      await minting.connect(user2).mintWithBaseToken(9, { value: ethers.parseEther("0.512") });

      // Configure
      await drawManager.configureDrawType(0, ethers.parseEther("0.01"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") });

      // Run 10 draws and count wins
      let user1Wins = 0;
      let user2Wins = 0;

      for (let i = 0; i < 10; i++) {
        await time.increase(7 * 24 * 60 * 60 + 1);
        await drawManager.executeDraw(0);

        const draw = await drawManager.getDrawDetails(i + 1);
        if (draw.winner === user1.address) user1Wins++;
        if (draw.winner === user2.address) user2Wins++;
      }

      console.log(`      User1 (weight 1) wins: ${user1Wins}`);
      console.log(`      User2 (weight 512) wins: ${user2Wins}`);

      // User2 should win significantly more (512/513 = 99.8%)
      expect(user2Wins).to.be.greaterThan(user1Wins);
    });

    it("Should handle edge case: winner at start of range", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      // Single participant
      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("0.01"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("0.1") });

      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);

      const draw = await drawManager.getDrawDetails(1);
      expect(draw.winner).to.equal(user1.address);
    });
  });

  // ============ HALVING CYCLE TESTS ============

  describe("Halving Cycles", function () {
    it("Should halve prize after configured interval", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      // Mint participant
      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // Configure with halving every 2 draws
      await drawManager.configureDrawType(0, ethers.parseEther("1"), 2);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("100") });

      let config = await drawManager.getDrawConfig(0);
      expect(config.currentPrize).to.equal(ethers.parseEther("1"));

      // Draw 1
      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);
      config = await drawManager.getDrawConfig(0);
      expect(config.currentPrize).to.equal(ethers.parseEther("1"));

      // Draw 2
      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);
      config = await drawManager.getDrawConfig(0);
      expect(config.currentPrize).to.equal(ethers.parseEther("1"));

      // Draw 3 - should trigger halving
      await time.increase(7 * 24 * 60 * 60 + 1);
      await expect(drawManager.executeDraw(0))
        .to.emit(drawManager, "HalvingOccurred")
        .withArgs(0, ethers.parseEther("1"), ethers.parseEther("0.5"), 2);

      config = await drawManager.getDrawConfig(0);
      expect(config.currentPrize).to.equal(ethers.parseEther("0.5"));
    });

    it("Should continue halving on subsequent intervals", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // Halve every 2 draws
      await drawManager.configureDrawType(0, ethers.parseEther("1000"), 2);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10000") });

      const expectedPrizes = [1000, 1000, 500, 500, 250, 250, 125, 125];

      for (let i = 0; i < 8; i++) {
        await time.increase(7 * 24 * 60 * 60 + 1);
        await drawManager.executeDraw(0);

        const config = await drawManager.getDrawConfig(0);
        expect(Number(ethers.formatEther(config.currentPrize))).to.be.closeTo(expectedPrizes[i], 0.1);
      }
    });
  });

  // ============ TWO-WAY QUERY MECHANICS TESTS ============

  describe("Two-Way Query Mechanics", function () {
    it("Should track user wins correctly", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("0.01"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") });

      // Execute 3 draws
      for (let i = 0; i < 3; i++) {
        await time.increase(7 * 24 * 60 * 60 + 1);
        await drawManager.executeDraw(0);
      }

      // Check user wins
      const wins = await drawManager.getUserWins(user1.address);
      expect(wins.length).to.equal(3);
    });

    it("Should check if user won specific draw", async function () {
      const { drawManager, minting, user1, user2 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(user2).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("0.01"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") });

      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);

      const draw = await drawManager.getDrawDetails(1);
      const winner = draw.winner;

      expect(await drawManager.didUserWin(winner, 1)).to.be.true;

      const loser = winner === user1.address ? user2.address : user1.address;
      expect(await drawManager.didUserWin(loser, 1)).to.be.false;
    });

    it("Should get user win details (drawIds + lottoIDs)", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      // User mints 2 NFTs
      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(user1).mintWithBaseToken(3, { value: ethers.parseEther("0.008") });

      await drawManager.configureDrawType(0, ethers.parseEther("0.01"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") });

      // Execute draws
      for (let i = 0; i < 2; i++) {
        await time.increase(7 * 24 * 60 * 60 + 1);
        await drawManager.executeDraw(0);
      }

      const [drawIds, lottoIDs] = await drawManager.getUserWinDetails(user1.address);
      expect(drawIds.length).to.equal(2);
      expect(lottoIDs.length).to.equal(2);
    });

    it("Should get user's lottery entries", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(user1).mintWithBaseToken(9, { value: ethers.parseEther("0.512") });

      const entries = await drawManager.getUserLotteryEntries(user1.address);
      expect(entries.length).to.equal(2);
      expect(entries[0].weight).to.equal(1);
      expect(entries[1].weight).to.equal(512);
    });
  });

  // ============ RANDOMNESS MODE TESTS ============

  describe("Randomness Mode", function () {
    it("Should allow owner to switch randomness mode", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      await expect(
        drawManager.setRandomnessMode(1) // CHAINLINK_VRF
      ).to.emit(drawManager, "RandomnessModeChanged")
        .withArgs(0, 1);

      expect(await drawManager.randomnessMode()).to.equal(1);
    });

    it("Should reject mode change from non-owner", async function () {
      const { drawManager, user1 } = await loadFixture(deployFullSystemFixture);

      await expect(
        drawManager.connect(user1).setRandomnessMode(1)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should work with PSEUDO_RANDOM mode", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.setRandomnessMode(0); // PSEUDO_RANDOM
      await drawManager.configureDrawType(0, ethers.parseEther("0.01"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") });

      await time.increase(7 * 24 * 60 * 60 + 1);
      await expect(drawManager.executeDraw(0)).to.not.be.reverted;
    });
  });

  // ============ MULTI-ASSET PRIZE DISTRIBUTION TESTS ============

  describe("Multi-Asset Prize Distribution", function () {
    it("Should distribute ETH prize to winner", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      const balanceBefore = await ethers.provider.getBalance(user1.address);

      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("Should distribute ERC20 tokens to winner", async function () {
      const { drawManager, minting, prizeToken1, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("0.01"), 52);

      const tokenAmount = ethers.parseEther("1000");
      await prizeToken1.approve(await drawManager.getAddress(), tokenAmount);
      await drawManager.fundPrizeBucket(0, [await prizeToken1.getAddress()], [tokenAmount]);

      const balanceBefore = await prizeToken1.balanceOf(user1.address);

      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);

      const balanceAfter = await prizeToken1.balanceOf(user1.address);
      expect(balanceAfter - balanceBefore).to.equal(tokenAmount);
    });

    it("Should distribute ETH + multiple ERC20 tokens", async function () {
      const { drawManager, minting, prizeToken1, prizeToken2, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("0.5"), 52);

      const amount1 = ethers.parseEther("1000");
      const amount2 = ethers.parseEther("2000");

      await prizeToken1.approve(await drawManager.getAddress(), amount1);
      await prizeToken2.approve(await drawManager.getAddress(), amount2);

      await drawManager.fundPrizeBucket(
        0,
        [await prizeToken1.getAddress(), await prizeToken2.getAddress()],
        [amount1, amount2],
        { value: ethers.parseEther("1") }
      );

      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);

      const draw = await drawManager.getDrawDetails(1);
      expect(draw.prizeTokens.length).to.equal(2);
      expect(await drawManager.getDrawPrizeTokenAmount(1, await prizeToken1.getAddress())).to.equal(amount1);
      expect(await drawManager.getDrawPrizeTokenAmount(1, await prizeToken2.getAddress())).to.equal(amount2);
    });
  });

  // ============ EDGE CASE AND ERROR TESTS ============

  describe("Edge Cases and Errors", function () {
    it("Should reject draw when no participants", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(
        drawManager.executeDraw(0)
      ).to.be.revertedWith("No participants");
    });

    it("Should reject draw before interval elapsed", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await expect(
        drawManager.executeDraw(0)
      ).to.be.revertedWith("Draw interval not elapsed");
    });

    it("Should reject draw when not configured", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(
        drawManager.executeDraw(0)
      ).to.be.revertedWith("Draw type not configured");
    });

    it("Should reject draw when inactive", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.setDrawTypeActive(0, false);

      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(
        drawManager.executeDraw(0)
      ).to.be.revertedWith("Draw type not active");
    });

    it("Should handle prize pool smaller than configured amount", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("10"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") }); // Less than configured

      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);

      const draw = await drawManager.getDrawDetails(1);
      expect(draw.prizeEth).to.equal(ethers.parseEther("1")); // Should use actual bucket amount
    });
  });

  // ============ GAS OPTIMIZATION TESTS ============

  describe("Gas Optimization", function () {
    it("Should execute draw with 10 participants efficiently", async function () {
      const { drawManager, minting, user1, user2, user3, user4, user5, owner } = await loadFixture(deployFullSystemFixture);

      // Create 10 participants
      const users = [user1, user2, user3, user4, user5];
      for (const user of users) {
        await minting.connect(user).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
        await minting.connect(user).mintWithBaseToken(5, { value: ethers.parseEther("0.032") });
      }

      await drawManager.configureDrawType(0, ethers.parseEther("0.1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      const tx = await drawManager.executeDraw(0);
      const receipt = await tx.wait();

      console.log(`      Draw with 10 participants gas: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.below(500000);
    });

    it("Should scale efficiently with more participants", async function () {
      const { drawManager, minting, owner } = await loadFixture(deployFullSystemFixture);

      // Create 50 participants
      const signers = await ethers.getSigners();
      for (let i = 0; i < 50 && i < signers.length; i++) {
        const user = signers[i];
        await minting.connect(user).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      }

      await drawManager.configureDrawType(0, ethers.parseEther("0.1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      const tx = await drawManager.executeDraw(0);
      const receipt = await tx.wait();

      console.log(`      Draw with 50 participants gas: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.below(1000000);
    });
  });

  // ============ PAUSABILITY TESTS ============

  describe("Pausability", function () {
    it("Should allow owner to pause", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      await expect(drawManager.pause()).to.not.be.reverted;
      expect(await drawManager.paused()).to.be.true;
    });

    it("Should reject draws when paused", async function () {
      const { drawManager, minting, user1 } = await loadFixture(deployFullSystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await drawManager.pause();
      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(
        drawManager.executeDraw(0)
      ).to.be.revertedWith("Pausable: paused");
    });

    it("Should allow owner to unpause", async function () {
      const { drawManager } = await loadFixture(deployFullSystemFixture);

      await drawManager.pause();
      await expect(drawManager.unpause()).to.not.be.reverted;
      expect(await drawManager.paused()).to.be.false;
    });
  });
});
