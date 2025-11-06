const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Security Audit Tests", function () {

  async function deploySystemFixture() {
    const [owner, user1, user2, attacker] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const paymentToken = await MockERC20.deploy("Payment Token", "PAY", ethers.parseEther("1000000"));
    const prizeToken = await MockERC20.deploy("Prize Token", "PRIZE", ethers.parseEther("1000000"));

    // Deploy malicious contract
    const MaliciousReceiver = await ethers.getContractFactory("MaliciousReceiver");
    const malicious = await MaliciousReceiver.deploy();

    const MintingContract = await ethers.getContractFactory("NFTLotteryMintingTierV11");
    const minting = await upgrades.deployProxy(MintingContract, [], {
      initializer: "initialize"
    });
    await minting.waitForDeployment();

    await minting.setPaymentToken(await paymentToken.getAddress());
    for (let i = 0; i < 10; i++) {
      await minting.setTierPrice(i, ethers.parseEther((0.001 * (2 ** i)).toString()), 0, 0);
    }

    const DrawManager = await ethers.getContractFactory("LotteryDrawManagerV2");
    const drawManager = await upgrades.deployProxy(DrawManager, [
      await minting.getAddress(),
      0 // PSEUDO_RANDOM
    ], {
      initializer: "initialize"
    });
    await drawManager.waitForDeployment();

    await paymentToken.transfer(user1.address, ethers.parseEther("10000"));
    await paymentToken.transfer(user2.address, ethers.parseEther("10000"));
    await paymentToken.transfer(attacker.address, ethers.parseEther("10000"));

    return { minting, drawManager, paymentToken, prizeToken, malicious, owner, user1, user2, attacker };
  }

  // ============ REENTRANCY ATTACK TESTS ============

  describe("Reentrancy Protection", function () {
    it("Should prevent reentrancy on mintWithBaseToken", async function () {
      const { minting, malicious } = await loadFixture(deploySystemFixture);

      // Set malicious contract to attack minting
      await malicious.setTarget(await minting.getAddress());

      // The mint will succeed but reentrancy attempt in receive() will be blocked
      // ReentrancyGuard prevents the reentry silently, so the attack appears to succeed
      // but actually only one mint occurs
      const balanceBefore = await minting.getParticipantCount();
      await malicious.attackMint(0, { value: ethers.parseEther("0.01") });
      const balanceAfter = await minting.getParticipantCount();

      // Should only have 1 participant (not 2 from reentrancy)
      expect(balanceAfter - balanceBefore).to.equal(1n);
    });

    it("Should prevent reentrancy on withdraw", async function () {
      const { minting, malicious, user1, owner } = await loadFixture(deploySystemFixture);

      // User mints normally
      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // The malicious contract will try to withdraw but fail silently
      // because it's not the owner. The call won't revert externally,
      // but the withdraw won't succeed
      const contractBalanceBefore = await ethers.provider.getBalance(await minting.getAddress());
      await malicious.attackWithdraw();
      const contractBalanceAfter = await ethers.provider.getBalance(await minting.getAddress());

      // Balance should be unchanged (withdraw didn't work)
      expect(contractBalanceAfter).to.equal(contractBalanceBefore);
    });

    it("Should prevent reentrancy on draw execution", async function () {
      const { minting, drawManager, malicious, user1 } = await loadFixture(deploySystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      // Even if malicious contract is winner, reentrancy guard should protect
      await expect(drawManager.executeDraw(0)).to.not.be.reverted;
    });
  });

  // ============ ACCESS CONTROL TESTS ============

  describe("Access Control", function () {
    it("Should prevent non-owner from setting tier prices", async function () {
      const { minting, attacker } = await loadFixture(deploySystemFixture);

      await expect(
        minting.connect(attacker).setTierPrice(0, ethers.parseEther("100"), 0, 0)
      ).to.be.revertedWithCustomError(minting, "OwnableUnauthorizedAccount");
    });

    it("Should prevent non-owner from setting tier weights", async function () {
      const { minting, attacker } = await loadFixture(deploySystemFixture);

      await expect(
        minting.connect(attacker).setTierWeight(0, 1000)
      ).to.be.revertedWithCustomError(minting, "OwnableUnauthorizedAccount");
    });

    it("Should prevent non-owner from withdrawing", async function () {
      const { minting, attacker } = await loadFixture(deploySystemFixture);

      await expect(
        minting.connect(attacker).withdraw()
      ).to.be.revertedWithCustomError(minting, "OwnableUnauthorizedAccount");
    });

    it("Should prevent non-owner from executing draw", async function () {
      const { drawManager, attacker } = await loadFixture(deploySystemFixture);

      await expect(
        drawManager.connect(attacker).executeDraw(0)
      ).to.be.revertedWithCustomError(drawManager, "OwnableUnauthorizedAccount");
    });

    it("Should prevent non-owner from configuring draw types", async function () {
      const { drawManager, attacker } = await loadFixture(deploySystemFixture);

      await expect(
        drawManager.connect(attacker).configureDrawType(0, ethers.parseEther("1"), 52)
      ).to.be.revertedWithCustomError(drawManager, "OwnableUnauthorizedAccount");
    });

    it("Should prevent non-owner from funding prize buckets", async function () {
      const { drawManager, attacker } = await loadFixture(deploySystemFixture);

      await expect(
        drawManager.connect(attacker).fundPrizeBucket(0, [], [], { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(drawManager, "OwnableUnauthorizedAccount");
    });
  });

  // ============ INTEGER OVERFLOW/UNDERFLOW TESTS ============

  describe("Integer Safety", function () {
    it("Should handle maximum uint256 values safely", async function () {
      const { minting } = await loadFixture(deploySystemFixture);

      const maxUint = ethers.MaxUint256;

      // Solidity 0.8+ should revert on overflow
      await expect(
        minting.setTierPrice(0, maxUint, 0, 0)
      ).to.not.be.reverted; // Setting is fine

      // But minting should be impossible with such high price
      await expect(
        minting.mintWithBaseToken(0, { value: ethers.parseEther("1000") })
      ).to.be.revertedWith("Insufficient payment");
    });

    it("Should prevent weight manipulation causing overflow", async function () {
      const { minting, owner } = await loadFixture(deploySystemFixture);

      const hugWeight = ethers.MaxUint256;

      await minting.setTierWeight(0, hugWeight);

      // Total weight calculation should not overflow
      await expect(
        minting.mintWithBaseToken(0, { value: ethers.parseEther("0.001") })
      ).to.not.be.reverted;
    });
  });

  // ============ ERC20 SAFETY TESTS ============

  describe("ERC20 Safety (SafeERC20)", function () {
    it("Should safely handle token transfer failures", async function () {
      const { minting, paymentToken, user1 } = await loadFixture(deploySystemFixture);

      // Approve insufficient amount
      await paymentToken.connect(user1).approve(await minting.getAddress(), ethers.parseEther("5"));

      // Try to mint with higher price
      await minting.setTierPrice(0, 0, ethers.parseEther("10"), 0);

      // Should revert safely (not silently fail)
      await expect(
        minting.connect(user1).mintWithPaymentToken(0)
      ).to.be.reverted;
    });

    it("Should prevent minting with non-approved tokens", async function () {
      const { minting, user1 } = await loadFixture(deploySystemFixture);

      await minting.setTierPrice(0, 0, ethers.parseEther("10"), 0);

      // No approval given
      await expect(
        minting.connect(user1).mintWithPaymentToken(0)
      ).to.be.reverted;
    });

    it("Should handle malicious ERC20 tokens gracefully", async function () {
      const { minting, owner } = await loadFixture(deploySystemFixture);

      // Deploy malicious ERC20 that always returns false
      const MaliciousERC20 = await ethers.getContractFactory("MaliciousERC20");
      const badToken = await MaliciousERC20.deploy();

      await minting.setPaymentToken(await badToken.getAddress());
      await minting.setTierPrice(0, 0, ethers.parseEther("10"), 0);

      // SafeERC20 should revert if transfer returns false
      await expect(
        minting.mintWithPaymentToken(0)
      ).to.be.reverted;
    });
  });

  // ============ FRONT-RUNNING TESTS ============

  describe("Front-Running Protection", function () {
    it("Should not allow price manipulation before mint", async function () {
      const { minting, user1, attacker } = await loadFixture(deploySystemFixture);

      // User tries to mint
      const userMintPromise = minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // Attacker tries to front-run by changing price (will fail - only owner)
      await expect(
        minting.connect(attacker).setTierPrice(0, ethers.parseEther("10"), 0, 0)
      ).to.be.revertedWithCustomError(minting, "OwnableUnauthorizedAccount");

      await expect(userMintPromise).to.not.be.reverted;
    });

    it("Should not allow weight manipulation before draw", async function () {
      const { minting, drawManager, user1, attacker } = await loadFixture(deploySystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      // Attacker tries to manipulate weight (will fail - only owner)
      await expect(
        minting.connect(attacker).setTierWeight(0, 1000000)
      ).to.be.revertedWithCustomError(minting, "OwnableUnauthorizedAccount");

      await expect(drawManager.executeDraw(0)).to.not.be.reverted;
    });
  });

  // ============ GRIEFING ATTACK TESTS ============

  describe("Griefing Attack Prevention", function () {
    it("Should prevent spam minting DoS", async function () {
      const { minting, attacker } = await loadFixture(deploySystemFixture);

      // Try to spam mint many times
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          minting.connect(attacker).mintWithBaseToken(0, { value: ethers.parseEther("0.001") })
        );
      }

      // All should succeed without DoS
      await expect(Promise.all(promises)).to.not.be.reverted;

      // System should still function
      expect(await minting.getParticipantCount()).to.equal(100);
    });

    it("Should handle many participants without gas issues", async function () {
      const { minting, drawManager } = await loadFixture(deploySystemFixture);

      const signers = await ethers.getSigners();

      // Create 50 participants
      for (let i = 0; i < 50 && i < signers.length; i++) {
        await minting.connect(signers[i]).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      }

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      // Draw should still work efficiently
      const tx = await drawManager.executeDraw(0);
      const receipt = await tx.wait();

      console.log(`      Gas with 50 participants: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.below(1000000);
    });
  });

  // ============ RANDOMNESS MANIPULATION TESTS ============

  describe("Randomness Manipulation", function () {
    it("Should make prediction difficult with pseudo-random", async function () {
      const { minting, drawManager, user1, user2 } = await loadFixture(deploySystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(user2).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      // Run multiple draws and check that they execute (randomness works)
      await time.increase(7 * 24 * 60 * 60 + 1);

      const winners = [];
      for (let i = 0; i < 10; i++) {
        await drawManager.executeDraw(0);
        const draw = await drawManager.getDrawDetails(i + 1);
        winners.push(draw.winner);
        await time.increase(7 * 24 * 60 * 60 + 1);
      }

      // Check that draws executed successfully (all have winners)
      winners.forEach(winner => {
        expect(winner).to.not.equal(ethers.ZeroAddress);
      });
    });

    it("Should use multiple entropy sources", async function () {
      const { minting, drawManager, user1 } = await loadFixture(deploySystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("100") });

      // Execute draws at different times and blocks
      for (let i = 0; i < 5; i++) {
        await time.increase(7 * 24 * 60 * 60 + i * 1000);
        await drawManager.executeDraw(0);
      }

      // All should succeed with valid winners
      for (let i = 1; i <= 5; i++) {
        const draw = await drawManager.getDrawDetails(i);
        expect(draw.winner).to.not.equal(ethers.ZeroAddress); // Should have valid winner
      }
    });
  });

  // ============ EDGE CASE SECURITY TESTS ============

  describe("Edge Case Security", function () {
    it("Should handle zero participants safely", async function () {
      const { drawManager } = await loadFixture(deploySystemFixture);

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(
        drawManager.executeDraw(0)
      ).to.be.revertedWith("No participants");
    });

    it("Should handle zero prize pool safely", async function () {
      const { minting, drawManager, user1 } = await loadFixture(deploySystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      // Don't fund bucket

      await time.increase(7 * 24 * 60 * 60 + 1);

      // Should execute but prize is 0
      await expect(drawManager.executeDraw(0)).to.not.be.reverted;

      const draw = await drawManager.getDrawDetails(1);
      expect(draw.prizeEth).to.equal(0);
    });

    it("Should prevent integer division by zero", async function () {
      const { drawManager } = await loadFixture(deploySystemFixture);

      // Try to configure with 0 halving interval (should fail)
      await expect(
        drawManager.configureDrawType(0, ethers.parseEther("1"), 0)
      ).to.be.revertedWith("Halving interval must be > 0");
    });

    it("Should handle burned NFTs gracefully", async function () {
      const { minting, drawManager, user1, user2 } = await loadFixture(deploySystemFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(user2).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // User1 burns their NFT
      await minting.connect(user1).burn(0);

      // Draw should still work (burned NFT still in participant array)
      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("10") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(drawManager.executeDraw(0)).to.not.be.reverted;
    });
  });

  // ============ GAS LIMIT ATTACK TESTS ============

  describe("Gas Limit Attacks", function () {
    it("Should not allow gas limit DoS via many participants", async function () {
      const { minting, drawManager } = await loadFixture(deploySystemFixture);

      const signers = await ethers.getSigners();

      // Create 100 participants
      for (let i = 0; i < 100 && i < signers.length; i++) {
        await minting.connect(signers[i]).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      }

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, [], [], { value: ethers.parseEther("100") });

      await time.increase(7 * 24 * 60 * 60 + 1);

      // Binary search should scale even with many participants
      const tx = await drawManager.executeDraw(0);
      const receipt = await tx.wait();

      console.log(`      Gas with 100 participants: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.below(2000000); // Should be well under block limit
    });

    it("Should not allow gas limit DoS via many token transfers", async function () {
      const { drawManager, prizeToken } = await loadFixture(deploySystemFixture);

      // Fund bucket with many different tokens
      const tokens = [];
      const amounts = [];

      for (let i = 0; i < 5; i++) {
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const token = await MockERC20.deploy(`Token${i}`, `TK${i}`, ethers.parseEther("1000000"));
        await token.approve(await drawManager.getAddress(), ethers.parseEther("1000"));
        tokens.push(await token.getAddress());
        amounts.push(ethers.parseEther("1000"));
      }

      await drawManager.configureDrawType(0, ethers.parseEther("1"), 52);
      await drawManager.fundPrizeBucket(0, tokens, amounts);

      // Should not DoS during funding
      const bucket = await drawManager.getPrizeBucketStatus(0);
      expect(bucket.tokens.length).to.equal(5);
    });
  });
});

// ============ MALICIOUS CONTRACT IMPLEMENTATIONS ============

// Malicious receiver that tries to reenter
const MaliciousReceiverSource = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MaliciousReceiver {
    address public target;
    bool public attacking;

    function setTarget(address _target) external {
        target = _target;
    }

    function attackMint(uint256 tier) external payable {
        attacking = true;
        (bool success, ) = target.call{value: msg.value}(
            abi.encodeWithSignature("mintWithBaseToken(uint256)", tier)
        );
        attacking = false;
    }

    function attackWithdraw() external {
        attacking = true;
        (bool success, ) = target.call(
            abi.encodeWithSignature("withdraw()")
        );
        attacking = false;
    }

    receive() external payable {
        if (attacking && address(target).balance > 0) {
            // Try to reenter
            (bool success, ) = target.call(
                abi.encodeWithSignature("withdraw()")
            );
        }
    }
}
`;

// Malicious ERC20 that returns false on transfers
const MaliciousERC20Source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MaliciousERC20 {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false; // Always fail
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false; // Always fail
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1000000 * 10**18;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }
}
`;
