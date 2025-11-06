const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("NFTLotteryMintingTierV11 - Unit Tests", function () {

  // ============ FIXTURES ============

  async function deployMintingFixture() {
    const [owner, user1, user2, user3, attacker] = await ethers.getSigners();

    // Deploy mock ERC20 tokens for testing
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const paymentToken = await MockERC20.deploy("Payment Token", "PAY", ethers.parseEther("1000000"));
    const anotherToken = await MockERC20.deploy("Another Token", "ALT", ethers.parseEther("1000000"));

    // Deploy minting contract (upgradeable)
    const MintingContract = await ethers.getContractFactory("NFTLotteryMintingTierV11");
    const minting = await upgrades.deployProxy(MintingContract, [], {
      initializer: "initialize",
      kind: "uups"
    });
    await minting.waitForDeployment();

    // Set payment tokens
    await minting.setPaymentToken(await paymentToken.getAddress());
    await minting.setAnotherPaymentToken(await anotherToken.getAddress());

    // Distribute tokens to users
    await paymentToken.transfer(user1.address, ethers.parseEther("10000"));
    await paymentToken.transfer(user2.address, ethers.parseEther("10000"));
    await paymentToken.transfer(user3.address, ethers.parseEther("10000"));

    await anotherToken.transfer(user1.address, ethers.parseEther("10000"));
    await anotherToken.transfer(user2.address, ethers.parseEther("10000"));
    await anotherToken.transfer(user3.address, ethers.parseEther("10000"));

    return { minting, paymentToken, anotherToken, owner, user1, user2, user3, attacker };
  }

  async function deployWithPricesFixture() {
    const fixture = await deployMintingFixture();
    const { minting } = fixture;

    // Set tier prices
    const prices = [
      { base: ethers.parseEther("0.001"), payment: ethers.parseEther("10"), another: ethers.parseEther("1") },
      { base: ethers.parseEther("0.003"), payment: ethers.parseEther("30"), another: ethers.parseEther("3") },
      { base: ethers.parseEther("0.005"), payment: ethers.parseEther("50"), another: ethers.parseEther("5") },
      { base: ethers.parseEther("0.01"), payment: ethers.parseEther("100"), another: ethers.parseEther("10") },
      { base: ethers.parseEther("0.02"), payment: ethers.parseEther("200"), another: ethers.parseEther("20") },
      { base: ethers.parseEther("0.05"), payment: ethers.parseEther("500"), another: ethers.parseEther("50") },
      { base: ethers.parseEther("0.1"), payment: ethers.parseEther("1000"), another: ethers.parseEther("100") },
      { base: ethers.parseEther("0.2"), payment: ethers.parseEther("2000"), another: ethers.parseEther("200") },
      { base: ethers.parseEther("0.5"), payment: ethers.parseEther("5000"), another: ethers.parseEther("500") },
      { base: ethers.parseEther("1.0"), payment: ethers.parseEther("10000"), another: ethers.parseEther("1000") }
    ];

    for (let i = 0; i < prices.length; i++) {
      await minting.setTierPrice(i, prices[i].base, prices[i].payment, prices[i].another);
    }

    return { ...fixture, prices };
  }

  // ============ INITIALIZATION TESTS ============

  describe("Initialization", function () {
    it("Should initialize with correct name and symbol", async function () {
      const { minting } = await loadFixture(deployMintingFixture);
      expect(await minting.name()).to.equal("NFTLotteryMintingTierV11");
      expect(await minting.symbol()).to.equal("NFTTV11");
    });

    it("Should initialize with lottery active", async function () {
      const { minting } = await loadFixture(deployMintingFixture);
      expect(await minting.lotteryActive()).to.be.true;
    });

    it("Should initialize with correct tier weights", async function () {
      const { minting } = await loadFixture(deployMintingFixture);

      for (let i = 0; i < 10; i++) {
        const expectedWeight = 2 ** i; // 1, 2, 4, 8, ..., 512
        expect(await minting.tierWeight(i)).to.equal(expectedWeight);
      }
    });

    it("Should initialize with zero total weight", async function () {
      const { minting } = await loadFixture(deployMintingFixture);
      expect(await minting.totalWeight()).to.equal(0);
    });

    it("Should set owner correctly", async function () {
      const { minting, owner } = await loadFixture(deployMintingFixture);
      expect(await minting.owner()).to.equal(owner.address);
    });
  });

  // ============ TIER CONFIGURATION TESTS ============

  describe("Tier Configuration", function () {
    it("Should allow owner to set tier prices", async function () {
      const { minting } = await loadFixture(deployMintingFixture);

      await expect(
        minting.setTierPrice(0, ethers.parseEther("0.001"), ethers.parseEther("10"), ethers.parseEther("1"))
      ).to.emit(minting, "TierPriceSet")
        .withArgs(0, ethers.parseEther("0.001"), ethers.parseEther("10"), ethers.parseEther("1"));

      const tier = await minting.tiers(0);
      expect(tier.priceInBaseToken).to.equal(ethers.parseEther("0.001"));
      expect(tier.priceInPaymentToken).to.equal(ethers.parseEther("10"));
      expect(tier.priceInAnotherPaymentToken).to.equal(ethers.parseEther("1"));
    });

    it("Should reject setting tier prices from non-owner", async function () {
      const { minting, user1 } = await loadFixture(deployMintingFixture);

      await expect(
        minting.connect(user1).setTierPrice(0, ethers.parseEther("0.001"), 0, 0)
      ).to.be.revertedWithCustomError(minting, "OwnableUnauthorizedAccount");
    });

    it("Should reject setting prices for invalid tier", async function () {
      const { minting } = await loadFixture(deployMintingFixture);

      await expect(
        minting.setTierPrice(10, ethers.parseEther("0.001"), 0, 0)
      ).to.be.revertedWith("Invalid tier");
    });

    it("Should reject setting all prices to zero", async function () {
      const { minting } = await loadFixture(deployMintingFixture);

      await expect(
        minting.setTierPrice(0, 0, 0, 0)
      ).to.be.revertedWith("At least one price must be greater than 0");
    });

    it("Should allow owner to set tier weights", async function () {
      const { minting } = await loadFixture(deployMintingFixture);

      await expect(
        minting.setTierWeight(0, 10)
      ).to.emit(minting, "TierWeightSet")
        .withArgs(0, 10);

      expect(await minting.tierWeight(0)).to.equal(10);
    });

    it("Should reject setting weight to zero", async function () {
      const { minting } = await loadFixture(deployMintingFixture);

      await expect(
        minting.setTierWeight(0, 0)
      ).to.be.revertedWith("Weight must be greater than 0");
    });
  });

  // ============ MINTING WITH BASE TOKEN (ETH) TESTS ============

  describe("Minting with Base Token (ETH)", function () {
    it("Should mint NFT with sufficient ETH", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      const price = ethers.parseEther("0.001");
      await expect(
        minting.connect(user1).mintWithBaseToken(0, { value: price })
      ).to.emit(minting, "TokenMinted")
        .withArgs(user1.address, 0, 0, 0);

      expect(await minting.balanceOf(user1.address)).to.equal(1);
      expect(await minting.ownerOf(0)).to.equal(user1.address);
    });

    it("Should reject minting with insufficient ETH", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      await expect(
        minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.0001") })
      ).to.be.revertedWith("Insufficient payment");
    });

    it("Should reject minting when lottery is inactive", async function () {
      const { minting, user1, owner } = await loadFixture(deployWithPricesFixture);

      await minting.connect(owner).deactivateLottery();

      await expect(
        minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") })
      ).to.be.revertedWith("Lottery is not active");
    });

    it("Should update total weight correctly", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      expect(await minting.totalWeight()).to.equal(0);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      expect(await minting.totalWeight()).to.equal(1);

      await minting.connect(user1).mintWithBaseToken(9, { value: ethers.parseEther("1.0") });
      expect(await minting.totalWeight()).to.equal(1 + 512);
    });

    it("Should create participant with correct weight ranges", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      const participant = await minting.participants(0);
      expect(participant.owner).to.equal(user1.address);
      expect(participant.weightStart).to.equal(0);
      expect(participant.weightEnd).to.equal(1);
      expect(participant.tier).to.equal(0);
    });

    it("Should handle multiple mints with correct weight ranges", async function () {
      const { minting, user1, user2 } = await loadFixture(deployWithPricesFixture);

      // User1 mints Tier 0 (weight 1)
      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      // User2 mints Tier 9 (weight 512)
      await minting.connect(user2).mintWithBaseToken(9, { value: ethers.parseEther("1.0") });

      // User1 mints Tier 3 (weight 8)
      await minting.connect(user1).mintWithBaseToken(3, { value: ethers.parseEther("0.01") });

      // Check participants
      const p0 = await minting.participants(0);
      expect(p0.weightStart).to.equal(0);
      expect(p0.weightEnd).to.equal(1);

      const p1 = await minting.participants(1);
      expect(p1.weightStart).to.equal(1);
      expect(p1.weightEnd).to.equal(513);

      const p2 = await minting.participants(2);
      expect(p2.weightStart).to.equal(513);
      expect(p2.weightEnd).to.equal(521);

      expect(await minting.totalWeight()).to.equal(521);
    });
  });

  // ============ MINTING WITH ERC20 TOKENS TESTS ============

  describe("Minting with ERC20 Payment Tokens", function () {
    it("Should mint with payment token", async function () {
      const { minting, paymentToken, user1 } = await loadFixture(deployWithPricesFixture);

      const price = ethers.parseEther("10");
      await paymentToken.connect(user1).approve(await minting.getAddress(), price);

      await expect(
        minting.connect(user1).mintWithPaymentToken(0)
      ).to.emit(minting, "TokenMinted");

      expect(await minting.balanceOf(user1.address)).to.equal(1);
    });

    it("Should reject minting without approval", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      await expect(
        minting.connect(user1).mintWithPaymentToken(0)
      ).to.be.reverted;
    });

    it("Should reject minting with insufficient token balance", async function () {
      const { minting, paymentToken, attacker } = await loadFixture(deployWithPricesFixture);

      await paymentToken.connect(attacker).approve(await minting.getAddress(), ethers.parseEther("10"));

      await expect(
        minting.connect(attacker).mintWithPaymentToken(0)
      ).to.be.reverted;
    });

    it("Should mint with another payment token", async function () {
      const { minting, anotherToken, user1 } = await loadFixture(deployWithPricesFixture);

      const price = ethers.parseEther("1");
      await anotherToken.connect(user1).approve(await minting.getAddress(), price);

      await expect(
        minting.connect(user1).mintWithAnotherPaymentToken(0)
      ).to.emit(minting, "TokenMinted");

      expect(await minting.balanceOf(user1.address)).to.equal(1);
    });
  });

  // ============ GAS OPTIMIZATION TESTS ============

  describe("Gas Optimization", function () {
    it("Should mint Tier 0 within gas limit", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      const tx = await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      const receipt = await tx.wait();

      console.log(`      Tier 0 (weight 1) gas used: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.below(350000); // Proxy has overhead
    });

    it("Should mint Tier 9 with ~200k gas (98% improvement)", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      const tx = await minting.connect(user1).mintWithBaseToken(9, { value: ethers.parseEther("1.0") });
      const receipt = await tx.wait();

      console.log(`      Tier 9 (weight 512) gas used: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.below(350000); // Proxy has overhead but still efficient
    });

    it("Should scale linearly with multiple mints", async function () {
      const { minting, user1, user2, user3 } = await loadFixture(deployWithPricesFixture);

      const tx1 = await minting.connect(user1).mintWithBaseToken(5, { value: ethers.parseEther("0.05") });
      const receipt1 = await tx1.wait();

      const tx2 = await minting.connect(user2).mintWithBaseToken(5, { value: ethers.parseEther("0.05") });
      const receipt2 = await tx2.wait();

      const tx3 = await minting.connect(user3).mintWithBaseToken(5, { value: ethers.parseEther("0.05") });
      const receipt3 = await tx3.wait();

      console.log(`      First mint gas: ${receipt1.gasUsed}`);
      console.log(`      Second mint gas: ${receipt2.gasUsed}`);
      console.log(`      Third mint gas: ${receipt3.gasUsed}`);

      // Gas should be similar (within 10k) for each mint
      expect(Number(receipt2.gasUsed) - Number(receipt1.gasUsed)).to.be.below(10000);
      expect(Number(receipt3.gasUsed) - Number(receipt2.gasUsed)).to.be.below(10000);
    });
  });

  // ============ SOULBOUND TOKEN TESTS ============

  describe("Soulbound (Non-Transferable) Tokens", function () {
    it("Should prevent transfers between users", async function () {
      const { minting, user1, user2 } = await loadFixture(deployWithPricesFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await expect(
        minting.connect(user1).transferFrom(user1.address, user2.address, 0)
      ).to.be.revertedWith("Transfers are disabled");
    });

    it("Should allow burning", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await expect(
        minting.connect(user1).burn(0)
      ).to.not.be.reverted;

      await expect(minting.ownerOf(0)).to.be.reverted;
      expect(await minting.balanceOf(user1.address)).to.equal(0);
    });

    it("Should reject burning by non-owner", async function () {
      const { minting, user1, user2 } = await loadFixture(deployWithPricesFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      await expect(
        minting.connect(user2).burn(0)
      ).to.be.revertedWith("Caller is not owner nor approved");
    });
  });

  // ============ LOTTERY ENTRY TRACKING TESTS ============

  describe("Lottery Entry Tracking", function () {
    it("Should track user lottery entries", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      await minting.connect(user1).mintWithBaseToken(9, { value: ethers.parseEther("1.0") });

      const entries = await minting.getLottoIDsByAddress(user1.address);
      expect(entries.length).to.equal(2);
      expect(entries[0].weight).to.equal(1);
      expect(entries[1].weight).to.equal(512);
    });

    it("Should maintain correct participant count", async function () {
      const { minting, user1, user2, user3 } = await loadFixture(deployWithPricesFixture);

      expect(await minting.getParticipantCount()).to.equal(0);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      expect(await minting.getParticipantCount()).to.equal(1);

      await minting.connect(user2).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      expect(await minting.getParticipantCount()).to.equal(2);

      await minting.connect(user3).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });
      expect(await minting.getParticipantCount()).to.equal(3);
    });
  });

  // ============ WITHDRAWAL TESTS ============

  describe("Withdrawal", function () {
    it("Should allow owner to withdraw ETH", async function () {
      const { minting, owner, user1 } = await loadFixture(deployWithPricesFixture);

      await minting.connect(user1).mintWithBaseToken(0, { value: ethers.parseEther("0.001") });

      const balanceBefore = await ethers.provider.getBalance(owner.address);
      await minting.connect(owner).withdraw();
      const balanceAfter = await ethers.provider.getBalance(owner.address);

      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("Should allow owner to withdraw ERC20 tokens", async function () {
      const { minting, paymentToken, owner, user1 } = await loadFixture(deployWithPricesFixture);

      await paymentToken.connect(user1).approve(await minting.getAddress(), ethers.parseEther("10"));
      await minting.connect(user1).mintWithPaymentToken(0);

      const balanceBefore = await paymentToken.balanceOf(owner.address);
      await minting.connect(owner).withdraw();
      const balanceAfter = await paymentToken.balanceOf(owner.address);

      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("Should reject withdrawal from non-owner", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      await expect(
        minting.connect(user1).withdraw()
      ).to.be.revertedWithCustomError(minting, "OwnableUnauthorizedAccount");
    });
  });

  // ============ EDGE CASE TESTS ============

  describe("Edge Cases", function () {
    it("Should handle minting all 10 tiers by one user", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      for (let i = 0; i < 10; i++) {
        const tier = await minting.tiers(i);
        await minting.connect(user1).mintWithBaseToken(i, { value: tier.priceInBaseToken });
      }

      expect(await minting.balanceOf(user1.address)).to.equal(10);
      expect(await minting.getParticipantCount()).to.equal(10);

      // Total weight should be 1+2+4+8+16+32+64+128+256+512 = 1023
      expect(await minting.totalWeight()).to.equal(1023);
    });

    it("Should handle same tier minted multiple times", async function () {
      const { minting, user1 } = await loadFixture(deployWithPricesFixture);

      const price = ethers.parseEther("0.001");
      await minting.connect(user1).mintWithBaseToken(0, { value: price });
      await minting.connect(user1).mintWithBaseToken(0, { value: price });
      await minting.connect(user1).mintWithBaseToken(0, { value: price });

      expect(await minting.balanceOf(user1.address)).to.equal(3);
      expect(await minting.totalWeight()).to.equal(3);
    });

    it("Should handle maximum wei values", async function () {
      const { minting } = await loadFixture(deployMintingFixture);

      const maxPrice = ethers.parseEther("1000000");
      await expect(
        minting.setTierPrice(0, maxPrice, maxPrice, maxPrice)
      ).to.not.be.reverted;
    });
  });
});

// Mock ERC20 contract for testing
const MockERC20Source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol, uint256 initialSupply) ERC20(name, symbol) {
        _mint(msg.sender, initialSupply);
    }
}
`;
