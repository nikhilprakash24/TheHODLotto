// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRewardPoints {
    function mint(address to, uint256 amount) external;
}

/**
 * @title RewardPointsManager
 * @dev Manages reward points accrual for token holders
 *      - Users earn reward points for holding the HODL token
 *      - Rate = baseRate × multiplier (based on configurable tiers)
 *      - Users claim at their discretion (they pay gas, no DoS risk)
 *      - Simplified math: uses minimum balance between last claim and now
 *      - No balance history stored - encourages holding
 */
contract RewardPointsManager is Ownable, ReentrancyGuard, Pausable {

    // The token users must hold to earn rewards (e.g., HODL token)
    IERC20 public stakingToken;

    // The reward points token (minted by this contract)
    IRewardPoints public rewardPoints;

    // Base reward rate per token per second (in wei units for precision)
    // Example: 1e18 = 1 reward point per token per second
    uint256 public baseRewardRate;

    // Multiplier tiers (index = tier, value = multiplier in basis points)
    // Example: [10000, 15000, 20000] = [1x, 1.5x, 2x]
    uint256[] public multiplierTiers;

    // Minimum balance thresholds for each multiplier tier
    // Example: [0, 1000e18, 10000e18] = tier 0 for any balance, tier 1 for 1000+, tier 2 for 10000+
    uint256[] public tierThresholds;

    // User claim data
    struct UserClaim {
        uint256 lastClaimTime;        // Last time user claimed
        uint256 balanceAtLastClaim;   // Balance at last claim (for min calculation)
        uint256 totalClaimed;          // Total reward points claimed
    }

    mapping(address => UserClaim) public userClaims;

    // Events
    event RewardsClaimed(address indexed user, uint256 amount, uint256 timeElapsed);
    event BaseRewardRateUpdated(uint256 oldRate, uint256 newRate);
    event MultiplierTierUpdated(uint256 tier, uint256 multiplier, uint256 threshold);
    event StakingTokenSet(address indexed token);
    event RewardPointsSet(address indexed token);

    constructor(
        address _stakingToken,
        address _rewardPoints,
        uint256 _baseRewardRate
    ) Ownable(msg.sender) {
        require(_stakingToken != address(0), "Invalid staking token");
        require(_rewardPoints != address(0), "Invalid reward points");

        stakingToken = IERC20(_stakingToken);
        rewardPoints = IRewardPoints(_rewardPoints);
        baseRewardRate = _baseRewardRate;

        // Initialize with default 1x multiplier
        multiplierTiers.push(10000); // 10000 basis points = 1x
        tierThresholds.push(0);      // Tier 0 starts at 0 balance
    }

    /**
     * @dev Users call this to claim their accumulated reward points
     *      Gas paid by user - no DoS risk for protocol
     */
    function claimRewards() external nonReentrant whenNotPaused {
        address user = msg.sender;
        uint256 currentBalance = stakingToken.balanceOf(user);
        require(currentBalance > 0, "No tokens to earn rewards");

        UserClaim storage claim = userClaims[user];

        // First time claiming - initialize
        if (claim.lastClaimTime == 0) {
            claim.lastClaimTime = block.timestamp;
            claim.balanceAtLastClaim = currentBalance;
            emit RewardsClaimed(user, 0, 0);
            return;
        }

        uint256 timeElapsed = block.timestamp - claim.lastClaimTime;
        require(timeElapsed > 0, "No time elapsed since last claim");

        // Use MINIMUM balance (current vs last claim) to discourage selling
        // This is the key gas optimization - no balance history needed!
        uint256 effectiveBalance = currentBalance < claim.balanceAtLastClaim
            ? currentBalance
            : claim.balanceAtLastClaim;

        // Calculate rewards: time × balance × baseRate × multiplier
        uint256 multiplier = _getMultiplierForBalance(effectiveBalance);
        uint256 rewards = (timeElapsed * effectiveBalance * baseRewardRate * multiplier) / (10000 * 1e18);

        require(rewards > 0, "No rewards to claim");

        // Update claim data
        claim.lastClaimTime = block.timestamp;
        claim.balanceAtLastClaim = currentBalance;
        claim.totalClaimed += rewards;

        // Mint reward points
        rewardPoints.mint(user, rewards);

        emit RewardsClaimed(user, rewards, timeElapsed);
    }

    /**
     * @dev View pending rewards for a user
     */
    function pendingRewards(address _user) external view returns (uint256) {
        uint256 currentBalance = stakingToken.balanceOf(_user);
        if (currentBalance == 0) return 0;

        UserClaim storage claim = userClaims[_user];
        if (claim.lastClaimTime == 0) return 0;

        uint256 timeElapsed = block.timestamp - claim.lastClaimTime;
        if (timeElapsed == 0) return 0;

        uint256 effectiveBalance = currentBalance < claim.balanceAtLastClaim
            ? currentBalance
            : claim.balanceAtLastClaim;

        uint256 multiplier = _getMultiplierForBalance(effectiveBalance);
        return (timeElapsed * effectiveBalance * baseRewardRate * multiplier) / (10000 * 1e18);
    }

    /**
     * @dev Get multiplier tier for a given balance
     */
    function _getMultiplierForBalance(uint256 _balance) internal view returns (uint256) {
        // Find highest tier the balance qualifies for
        for (uint256 i = tierThresholds.length; i > 0; i--) {
            if (_balance >= tierThresholds[i - 1]) {
                return multiplierTiers[i - 1];
            }
        }
        return multiplierTiers[0]; // Default to lowest tier
    }

    /**
     * @dev Get current multiplier for a user
     */
    function getUserMultiplier(address _user) external view returns (uint256) {
        uint256 balance = stakingToken.balanceOf(_user);
        return _getMultiplierForBalance(balance);
    }

    // ============ ADMIN FUNCTIONS ============

    /**
     * @dev Update base reward rate
     */
    function setBaseRewardRate(uint256 _newRate) external onlyOwner {
        uint256 oldRate = baseRewardRate;
        baseRewardRate = _newRate;
        emit BaseRewardRateUpdated(oldRate, _newRate);
    }

    /**
     * @dev Add or update a multiplier tier
     */
    function setMultiplierTier(
        uint256 _tierIndex,
        uint256 _multiplier,
        uint256 _threshold
    ) external onlyOwner {
        require(_multiplier >= 10000, "Multiplier must be >= 1x (10000)");

        if (_tierIndex >= multiplierTiers.length) {
            multiplierTiers.push(_multiplier);
            tierThresholds.push(_threshold);
        } else {
            multiplierTiers[_tierIndex] = _multiplier;
            tierThresholds[_tierIndex] = _threshold;
        }

        emit MultiplierTierUpdated(_tierIndex, _multiplier, _threshold);
    }

    /**
     * @dev Get number of tiers
     */
    function getTierCount() external view returns (uint256) {
        return multiplierTiers.length;
    }

    /**
     * @dev Get tier details
     */
    function getTier(uint256 _index) external view returns (uint256 multiplier, uint256 threshold) {
        require(_index < multiplierTiers.length, "Invalid tier index");
        return (multiplierTiers[_index], tierThresholds[_index]);
    }

    /**
     * @dev Emergency pause
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Update staking token (use with extreme caution)
     */
    function setStakingToken(address _token) external onlyOwner {
        require(_token != address(0), "Invalid token");
        stakingToken = IERC20(_token);
        emit StakingTokenSet(_token);
    }

    /**
     * @dev Get user claim details
     */
    function getUserClaimData(address _user) external view returns (
        uint256 lastClaimTime,
        uint256 balanceAtLastClaim,
        uint256 totalClaimed,
        uint256 currentBalance,
        uint256 pendingReward
    ) {
        UserClaim storage claim = userClaims[_user];
        currentBalance = stakingToken.balanceOf(_user);

        if (claim.lastClaimTime == 0 || currentBalance == 0) {
            return (claim.lastClaimTime, claim.balanceAtLastClaim, claim.totalClaimed, currentBalance, 0);
        }

        uint256 timeElapsed = block.timestamp - claim.lastClaimTime;
        uint256 effectiveBalance = currentBalance < claim.balanceAtLastClaim
            ? currentBalance
            : claim.balanceAtLastClaim;
        uint256 multiplier = _getMultiplierForBalance(effectiveBalance);
        pendingReward = (timeElapsed * effectiveBalance * baseRewardRate * multiplier) / (10000 * 1e18);

        return (
            claim.lastClaimTime,
            claim.balanceAtLastClaim,
            claim.totalClaimed,
            currentBalance,
            pendingReward
        );
    }
}
