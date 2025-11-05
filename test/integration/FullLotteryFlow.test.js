const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Full Lottery Flow - Integration Tests", function () {

  async function deployCompleteSystemFixture() {
    const signers = await ethers.getSigners();
    const [owner, ...users] = signers;

    // Deploy tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const paymentToken = await MockERC20.deploy("Payment Token", "PAY", ethers.parseEther("10000000"));
    const prizeToken = await MockERC20.deploy("Prize Token", "PRIZE", ethers.parseEther("10000000"));

    // Deploy minting contract
    const MintingContract = await ethers.getContractFactory("NFTLotteryMintingTierV11");
    const minting = await upgrades.deployProxy(MintingContract, [], {
      initializer: "initialize"
    });
    await minting.waitForDeployment();

    // Set payment token and prices
    await minting.setPaymentToken(await paymentToken.getAddress());

    const prices = [
      0.001, 0.003, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0
    ];

    for (let i = 0; i < 10; i++) {
      await minting.setTierPrice(i, ethers.parseEther(prices[i].toString()), 0, 0);
    }

    // Deploy draw manager
    const DrawManager = await ethers.getContractFactory("LotteryDrawManagerV2");
    const drawManager = await DrawManager.deploy(
      await minting.getAddress(),
      0 // PSEUDO_RANDOM
    );
    await drawManager.waitForDeployment();

    // Configure all draw types
    await drawManager.configureDrawType(0, ethers.parseEther("1"), 52); // Weekly
    await drawManager.configureDrawType(1, ethers.parseEther("10"), 12); // Monthly
    await drawManager.configureDrawType(2, ethers.parseEther("50"), 4); // Quarterly
    await drawManager.configureDrawType(3, ethers.parseEther("500"), 4); // Yearly

    // Distribute tokens to users
    for (let i = 0; i < 20 && i < users.length; i++) {
      await paymentToken.transfer(users[i].address, ethers.parseEther("10000"));
    }

    return {
      minting,
      drawManager,
      paymentToken,
      prizeToken,
      owner,
      users: users.slice(0, 20)
    };
  }

  // ============ COMPLETE LIFECYCLE TESTS ============

  describe("Complete Lottery Lifecycle", function () {
    it("Should handle complete weekly lottery cycle", async function () {
      const { minting, drawManager, users, prizeToken, owner } = await loadFixture(deployCompleteSystemFixture);

      console.log("\n      === WEEKLY LOTTERY CYCLE ===");

      // Phase 1: Users mint NFTs
      console.log("      Phase 1: Minting NFTs");
      for (let i = 0; i < 10; i++) {
        const tier = i % 10;
        const price = await minting.tiers(tier);
        await minting.connect(users[i]).mintWithBaseToken(tier, { value: price.priceInBaseToken });
      }

      const participantCount = await minting.getParticipantCount();
      const totalWeight = await minting.totalWeight();
      console.log(`      Participants: ${participantCount}`);
      console.log(`      Total Weight: ${totalWeight}`);

      // Phase 2: Fund prize bucket
      console.log("      Phase 2: Funding prize bucket");
      const ethPrize = ethers.parseEther("2");
      const tokenPrize = ethers.parseEther("1000");

      await prizeToken.approve(await drawManager.getAddress(), tokenPrize);
      await drawManager.fundPrizeBucket(
        0, // WEEKLY
        [await prizeToken.getAddress()],
        [tokenPrize],
        { value: ethPrize }
      );

      // Phase 3: Wait for draw time
      console.log("      Phase 3: Waiting for draw interval");
      await time.increase(7 * 24 * 60 * 60 + 1);

      // Phase 4: Execute draw
      console.log("      Phase 4: Executing draw");
      const tx = await drawManager.executeDraw(0);
      const receipt = await tx.wait();
      console.log(`      Draw gas used: ${receipt.gasUsed}`);

      // Phase 5: Verify results
      console.log("      Phase 5: Verifying results");
      const draw = await drawManager.getDrawDetails(1);
      console.log(`      Winner: ${draw.winner}`);
      console.log(`      Prize ETH: ${ethers.formatEther(draw.prizeEth)}`);
      console.log(`      Prize Tokens: ${draw.prizeTokens.length}`);

      expect(draw.winner).to.not.equal(ethers.ZeroAddress);
      expect(draw.prizeEth).to.equal(ethPrize);

      // Phase 6: Verify winner received prizes
      const winner = draw.winner;
      const wins = await drawManager.getUserWins(winner);
      expect(wins.length).to.equal(1);
      expect(wins[0]).to.equal(1);

      console.log("      ✅ Weekly lottery completed successfully");
    });

    it("Should handle multiple concurrent draw types", async function () {
      const { minting, drawManager, users, owner } = await loadFixture(deployCompleteSystemFixture);

      console.log("\n      === CONCURRENT DRAWS TEST ===");

      // Mint NFTs
      for (let i = 0; i < 10; i++) {
        await minting.connect(users[i]).mintWithBaseToken(i, {
          value: (await minting.tiers(i)).priceInBaseToken
        });
      }

      // Fund all draw types
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") }); // Weekly
      await drawManager.fundPrizeBucket(1, [], [], { value: ethers.parseEther("50") }); // Monthly
      await drawManager.fundPrizeBucket(2, [], [], { value: ethers.parseEther("200") }); // Quarterly

      // Execute weekly draw (7 days)
      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);
      console.log("      ✅ Week 1 draw complete");

      // Execute another weekly draw
      await time.increase(7 * 24 * 60 * 60);
      await drawManager.executeDraw(0);
      console.log("      ✅ Week 2 draw complete");

      // Execute monthly draw (now 14+ days passed)
      await time.increase(16 * 24 * 60 * 60);
      await drawManager.executeDraw(1);
      console.log("      ✅ Monthly draw complete");

      // Execute quarterly draw
      await time.increase(76 * 24 * 60 * 60);
      await drawManager.executeDraw(2);
      console.log("      ✅ Quarterly draw complete");

      // Verify draw counts
      const weeklyConfig = await drawManager.getDrawConfig(0);
      const monthlyConfig = await drawManager.getDrawConfig(1);
      const quarterlyConfig = await drawManager.getDrawConfig(2);

      expect(weeklyConfig.drawCount).to.equal(2);
      expect(monthlyConfig.drawCount).to.equal(1);
      expect(quarterlyConfig.drawCount).to.equal(1);

      console.log("      ✅ All concurrent draws completed");
    });

    it("Should handle full halving cycle", async function () {
      const { minting, drawManager, users } = await loadFixture(deployCompleteSystemFixture);

      console.log("\n      === HALVING CYCLE TEST ===");

      // Mint participant
      await minting.connect(users[0]).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // Configure with halving every 2 draws
      await drawManager.configureDrawType(0, ethers.parseEther("100"), 2);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1000") });

      const expectedPrizes = [100, 100, 50, 50, 25, 25, 12.5, 12.5];

      for (let i = 0; i < 8; i++) {
        await time.increase(7 * 24 * 60 * 60 + 1);
        await drawManager.executeDraw(0);

        const config = await drawManager.getDrawConfig(0);
        const currentPrize = Number(ethers.formatEther(config.currentPrize));

        console.log(`      Draw ${i + 1}: Prize = ${currentPrize} ETH (expected: ${expectedPrizes[i]})`);
        expect(currentPrize).to.be.closeTo(expectedPrizes[i], 0.1);
      }

      console.log("      ✅ Halving cycle completed correctly");
    });
  });

  // ============ REAL-WORLD SCENARIO TESTS ============

  describe("Real-World Scenarios", function () {
    it("Should handle 100 users minting various tiers", async function () {
      const { minting, drawManager, users, owner } = await loadFixture(deployCompleteSystemFixture);

      console.log("\n      === 100 USER SCENARIO ===");

      // Mint NFTs from 20 available users (simulate 100 by minting multiple)
      let mintCount = 0;
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 20 && i < users.length; i++) {
          const tier = (round * 20 + i) % 10;
          const price = (await minting.tiers(tier)).priceInBaseToken;
          await minting.connect(users[i]).mintWithBaseToken(tier, { value: price });
          mintCount++;
        }
      }

      console.log(`      Total mints: ${mintCount}`);
      console.log(`      Participants: ${await minting.getParticipantCount()}`);
      console.log(`      Total Weight: ${await minting.totalWeight()}`);

      // Fund and execute draw
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("100") });
      await time.increase(7 * 24 * 60 * 60 + 1);

      const tx = await drawManager.executeDraw(0);
      const receipt = await tx.wait();

      console.log(`      Draw execution gas: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.below(1000000); // Should scale efficiently

      const draw = await drawManager.getDrawDetails(1);
      console.log(`      Winner: ${draw.winner}`);

      console.log("      ✅ Large-scale scenario handled");
    });

    it("Should handle whale vs many small players scenario", async function () {
      const { minting, drawManager, users } = await loadFixture(deployCompleteSystemFixture);

      console.log("\n      === WHALE VS SMALL PLAYERS ===");

      // Whale: Buy Tier 9 (weight 512) 5 times
      for (let i = 0; i < 5; i++) {
        await minting.connect(users[0]).mintWithBaseToken(9, { value: ethers.parseEther("1.0") });
      }

      // Small players: Buy Tier 0 (weight 1) 10 times each
      for (let i = 1; i < 11; i++) {
        for (let j = 0; j < 10; j++) {
          await minting.connect(users[i]).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
        }
      }

      const whaleWeight = 512 * 5; // 2560
      const smallPlayersWeight = 1 * 10 * 10; // 100
      const totalWeight = whaleWeight + smallPlayersWeight; // 2660

      console.log(`      Whale weight: ${whaleWeight} (${(whaleWeight / totalWeight * 100).toFixed(2)}%)`);
      console.log(`      Small players weight: ${smallPlayersWeight} (${(smallPlayersWeight / totalWeight * 100).toFixed(2)}%)`);

      // Run 20 draws and track wins
      await drawManager.configureDrawType(0, ethers.parseEther("0.1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("100") });

      let whaleWins = 0;
      let smallPlayerWins = 0;

      for (let i = 0; i < 20; i++) {
        await time.increase(7 * 24 * 60 * 60 + 1);
        await drawManager.executeDraw(0);

        const draw = await drawManager.getDrawDetails(i + 1);
        if (draw.winner === users[0].address) {
          whaleWins++;
        } else {
          smallPlayerWins++;
        }
      }

      console.log(`      Whale wins: ${whaleWins}/20 (${(whaleWins / 20 * 100).toFixed(1)}%)`);
      console.log(`      Small player wins: ${smallPlayerWins}/20 (${(smallPlayerWins / 20 * 100).toFixed(1)}%)`);

      // Whale should win significantly more
      expect(whaleWins).to.be.greaterThan(smallPlayerWins);
      console.log("      ✅ Weighted probability working correctly");
    });

    it("Should handle NFT sales funding next lottery", async function () {
      const { minting, drawManager, users, owner } = await loadFixture(deployCompleteSystemFixture);

      console.log("\n      === SELF-FUNDING LOTTERY ===");

      // Round 1: Initial lottery
      await drawManager.configureDrawType(0, ethers.parseEther("0.1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") });

      // Collect NFT sale revenue
      const revenueBefore = await ethers.provider.getBalance(owner.address);

      for (let i = 0; i < 10; i++) {
        await minting.connect(users[i]).mintWithBaseToken(5, { value: ethers.parseEther("0.05") });
      }

      // Withdraw revenue
      await minting.withdraw();
      const revenueAfter = await ethers.provider.getBalance(owner.address);
      const revenue = revenueAfter - revenueBefore;

      console.log(`      NFT sales revenue: ${ethers.formatEther(revenue)} ETH`);

      // Fund next round with revenue
      await drawManager.fundPrizeBucket(0, [], [], { value: revenue / 2n });

      console.log(`      Funded next round with ${ethers.formatEther(revenue / 2n)} ETH`);
      console.log("      ✅ Self-funding cycle demonstrated");
    });
  });

  // ============ USER EXPERIENCE FLOW TESTS ============

  describe("User Experience Flows", function () {
    it("Should track complete user journey", async function () {
      const { minting, drawManager, users } = await loadFixture(deployCompleteSystemFixture);

      const user = users[0];

      console.log("\n      === USER JOURNEY ===");

      // Step 1: User mints NFTs
      console.log("      Step 1: User mints 3 NFTs");
      await minting.connect(user).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(user).mintWithBaseToken(5, { value: ethers.parseEther("0.05") });
      await minting.connect(user).mintWithBaseToken(9, { value: ethers.parseEther("1.0") });

      // Step 2: Check user's entries
      const entries = await drawManager.getUserLotteryEntries(user.address);
      console.log(`      Step 2: User has ${entries.length} lottery entries`);
      expect(entries.length).to.equal(3);

      // Step 3: Execute draws
      await drawManager.configureDrawType(0, ethers.parseEther("0.1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      for (let i = 0; i < 5; i++) {
        await time.increase(7 * 24 * 60 * 60 + 1);
        await drawManager.executeDraw(0);
      }

      console.log("      Step 3: 5 draws completed");

      // Step 4: Check if user won
      const wins = await drawManager.getUserWins(user.address);
      console.log(`      Step 4: User won ${wins.length} draws`);

      // Step 5: Get win details
      if (wins.length > 0) {
        const [drawIds, lottoIDs] = await drawManager.getUserWinDetails(user.address);
        console.log(`      Step 5: Win details retrieved`);
        for (let i = 0; i < drawIds.length; i++) {
          const draw = await drawManager.getDrawDetails(drawIds[i]);
          console.log(`        - Draw ${drawIds[i]}: NFT #${lottoIDs[i]} won ${ethers.formatEther(draw.prizeEth)} ETH`);
        }
      }

      console.log("      ✅ Complete user journey tracked");
    });

    it("Should allow user to check specific draw results", async function () {
      const { minting, drawManager, users } = await loadFixture(deployCompleteSystemFixture);

      // Setup
      await minting.connect(users[0]).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(users[1]).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("0.1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") });

      await time.increase(7 * 24 * 60 * 60 + 1);
      await drawManager.executeDraw(0);

      // Check results
      const draw = await drawManager.getDrawDetails(1);
      const winner = draw.winner;

      // Winner should see they won
      expect(await drawManager.didUserWin(winner, 1)).to.be.true;

      // Non-winner should see they lost
      const loser = winner === users[0].address ? users[1].address : users[0].address;
      expect(await drawManager.didUserWin(loser, 1)).to.be.false;
    });
  });

  // ============ EMERGENCY AND RECOVERY TESTS ============

  describe("Emergency Scenarios", function () {
    it("Should handle pause during active lottery", async function () {
      const { minting, drawManager, users } = await loadFixture(deployCompleteSystemFixture);

      await minting.connect(users[0]).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      // Pause before draw
      await drawManager.pause();

      await time.increase(7 * 24 * 60 * 60 + 1);

      // Draw should fail
      await expect(
        drawManager.executeDraw(0)
      ).to.be.revertedWith("Pausable: paused");

      // Unpause and draw should work
      await drawManager.unpause();
      await expect(drawManager.executeDraw(0)).to.not.be.reverted;
    });

    it("Should handle emergency fund withdrawal", async function () {
      const { drawManager, owner } = await loadFixture(deployCompleteSystemFixture);

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      const balanceBefore = await ethers.provider.getBalance(owner.address);

      await drawManager.emergencyWithdraw(ethers.ZeroAddress, ethers.parseEther("5"));

      const balanceAfter = await ethers.provider.getBalance(owner.address);
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });
  });

  // ============ PERFORMANCE BENCHMARKING ============

  describe("Performance Benchmarks", function () {
    it("Should benchmark gas costs across all operations", async function () {
      const { minting, drawManager, users, prizeToken } = await loadFixture(deployCompleteSystemFixture);

      console.log("\n      === GAS BENCHMARKS ===");

      // Mint benchmarks
      const mintTxs = [];
      for (let i = 0; i < 10; i++) {
        const tx = await minting.connect(users[0]).mintWithBaseToken(i, {
          value: (await minting.tiers(i)).priceInBaseToken
        });
        const receipt = await tx.wait();
        mintTxs.push({ tier: i, gas: receipt.gasUsed });
      }

      console.log("      Minting gas costs:");
      mintTxs.forEach(({ tier, gas }) => {
        console.log(`        Tier ${tier} (weight ${2 ** tier}): ${gas} gas`);
      });

      // Draw execution benchmark
      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);
      const drawTx = await drawManager.executeDraw(0);
      const drawReceipt = await drawTx.wait();

      console.log(`      Draw execution: ${drawReceipt.gasUsed} gas`);

      console.log("      ✅ Performance benchmarks complete");
    });
  });
});
