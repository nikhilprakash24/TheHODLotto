// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRewardPoints {
    function mint(address to, uint256 amount) external;
}

/**
 * @title RewardPointsManager
 * @dev Epoch-based staking system for reward points (UUPS Upgradeable)
 *      - Users must explicitly stake() to start earning
 *      - Rewards calculated based on completed epochs (daily or configurable)
 *      - SELLING PENALTY: Uses current (lower) balance for ALL epochs
 *      - BUYING MORE: 20% of epochs use new amount, 80% use old amount
 *      - Auto-claim when restaking
 *      - No balance history stored - simple and gas efficient
 */
contract RewardPointsManager is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{

    // The token users must stake to earn rewards (e.g., HODL token)
    IERC20 public stakingToken;

    // The reward points token (minted by this contract)
    IRewardPoints public rewardPoints;

    // Base reward rate per token per epoch (in wei units for precision)
    // Example: 1e18 = 1 reward point per token per epoch
    uint256 public baseRewardRate;

    // Multiplier basis points divisor (10000 = 100%)
    uint256 public constant MULTIPLIER_DIVISOR = 10000;

    // New token credit percentage in basis points (2000 = 20%)
    uint256 public newTokenCreditBasisPoints;

    // Minimum claim interval to prevent spam (default: 1 hour)
    uint256 public minClaimInterval;

    // Epoch duration (default: 1 day)
    uint256 public epochDuration;

    // Multiplier tiers (index = tier, value = multiplier in basis points)
    // Example: [10000, 15000, 20000] = [1x, 1.5x, 2x]
    uint256[] public multiplierTiers;

    // Minimum balance thresholds for each multiplier tier
    // Example: [0, 1000e18, 10000e18] = tier 0 for any balance, tier 1 for 1000+, tier 2 for 10000+
    uint256[] public tierThresholds;

    // User stake data
    struct UserStake {
        uint256 stakedBalance;        // Amount staked
        uint256 stakeTimestamp;       // When they staked
        uint256 lastClaimTimestamp;   // Last time they claimed
        uint256 totalClaimed;         // Total reward points claimed
    }

    mapping(address => UserStake) public userStakes;

    // Events
    event Staked(address indexed user, uint256 amount, uint256 timestamp);
    event Restaked(address indexed user, uint256 oldAmount, uint256 newAmount, uint256 rewardsClaimed, uint256 timestamp);
    event RewardsClaimed(address indexed user, uint256 amount, uint256 epochsCompleted);
    event BaseRewardRateUpdated(uint256 oldRate, uint256 newRate);
    event EpochDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event NewTokenCreditUpdated(uint256 oldCredit, uint256 newCredit);
    event MultiplierTierUpdated(uint256 tier, uint256 multiplier, uint256 threshold);
    event MultiplierTierRemoved(uint256 tier);
    event StakingTokenSet(address indexed token);
    event RewardPointsSet(address indexed token);
    event MinClaimIntervalUpdated(uint256 oldInterval, uint256 newInterval);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the contract (replaces constructor for upgradeable contracts)
     */
    function initialize(
        address _stakingToken,
        address _rewardPoints,
        uint256 _baseRewardRate
    ) public initializer {
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        require(_stakingToken != address(0), "Invalid staking token");
        require(_rewardPoints != address(0), "Invalid reward points");

        stakingToken = IERC20(_stakingToken);
        rewardPoints = IRewardPoints(_rewardPoints);
        baseRewardRate = _baseRewardRate;
        minClaimInterval = 1 hours;         // Default: 1 hour
        epochDuration = 1 days;             // Default: 1 day
        newTokenCreditBasisPoints = 2000;  // Default: 20%

        // Initialize with default 1x multiplier
        multiplierTiers.push(10000); // 10000 basis points = 1x
        tierThresholds.push(0);      // Tier 0 starts at 0 balance
    }

    /**
     * @dev Users must explicitly stake to start earning rewards
     *      This locks in their balance and starts the epoch timer
     */
    function stake() external nonReentrant whenNotPaused {
        address user = msg.sender;
        uint256 currentBalance = stakingToken.balanceOf(user);
        require(currentBalance > 0, "No tokens to stake");

        UserStake storage userStake = userStakes[user];

        // If already staked, this is a restake - handle differently
        if (userStake.stakedBalance > 0) {
            _restake(user, currentBalance);
            return;
        }

        // First time staking
        userStake.stakedBalance = currentBalance;
        userStake.stakeTimestamp = block.timestamp;
        userStake.lastClaimTimestamp = block.timestamp;

        emit Staked(user, currentBalance, block.timestamp);
    }

    /**
     * @dev Internal function to handle restaking when user stakes again
     *      Automatically claims existing rewards, then updates stake
     *      Uses 20%/80% split when buying more tokens:
     *      - 80% of rewards calculated with OLD balance
     *      - 20% of rewards calculated with NEW balance
     */
    function _restake(address user, uint256 newBalance) internal {
        UserStake storage userStake = userStakes[user];
        uint256 oldBalance = userStake.stakedBalance;

        // Calculate rewards with 20%/80% split if they bought more
        uint256 rewards = _calculateRestakeRewards(user, oldBalance, newBalance);

        if (rewards > 0) {
            userStake.totalClaimed += rewards;
            rewardPoints.mint(user, rewards);
        }

        // Update stake with new balance
        userStake.stakedBalance = newBalance;
        userStake.stakeTimestamp = block.timestamp;
        userStake.lastClaimTimestamp = block.timestamp;

        emit Restaked(user, oldBalance, newBalance, rewards, block.timestamp);
    }

    /**
     * @dev Calculate rewards for restaking with 20%/80% split
     *      If newBalance > oldBalance: 80% uses oldBalance, 20% uses newBalance
     *      If newBalance < oldBalance: Uses newBalance for ALL (selling penalty)
     */
    function _calculateRestakeRewards(
        address user,
        uint256 oldBalance,
        uint256 newBalance
    ) internal view returns (uint256) {
        UserStake storage userStake = userStakes[user];
        if (userStake.stakedBalance == 0) return 0;

        uint256 timeStaked = block.timestamp - userStake.lastClaimTimestamp;
        if (timeStaked == 0) return 0;

        // Calculate fractional epochs with 18 decimal precision
        uint256 fractionalEpochs = (timeStaked * 1e18) / epochDuration;

        // CASE 1: They SOLD tokens (newBalance < oldBalance)
        // Penalty: Use lower balance for ALL epochs
        if (newBalance < oldBalance) {
            uint256 multiplier = _getMultiplierForBalance(newBalance);
            return (fractionalEpochs * newBalance * baseRewardRate * multiplier) / (MULTIPLIER_DIVISOR * 1e18 * 1e18);
        }

        // CASE 2: They BOUGHT MORE tokens (newBalance > oldBalance)
        // 80% of epochs use old balance, 20% use new balance

        // 80% with old balance
        uint256 multiplierOld = _getMultiplierForBalance(oldBalance);
        uint256 rewardsOld = (fractionalEpochs * 8000 * oldBalance * baseRewardRate * multiplierOld) / (MULTIPLIER_DIVISOR * 10000 * 1e18 * 1e18);

        // 20% with new balance
        uint256 multiplierNew = _getMultiplierForBalance(newBalance);
        uint256 rewardsNew = (fractionalEpochs * 2000 * newBalance * baseRewardRate * multiplierNew) / (MULTIPLIER_DIVISOR * 10000 * 1e18 * 1e18);

        return rewardsOld + rewardsNew;
    }

    /**
     * @dev Users call this to claim their accumulated reward points
     *      Gas paid by user - no DoS risk for protocol
     */
    function claimRewards() external nonReentrant whenNotPaused {
        address user = msg.sender;
        UserStake storage userStake = userStakes[user];

        require(userStake.stakedBalance > 0, "No active stake");
        require(block.timestamp >= userStake.lastClaimTimestamp + minClaimInterval, "Claim too soon");

        uint256 rewards = _calculateRewards(user);
        require(rewards > 0, "No rewards to claim");

        // Update claim data
        userStake.lastClaimTimestamp = block.timestamp;
        userStake.totalClaimed += rewards;

        // Mint reward points
        rewardPoints.mint(user, rewards);

        uint256 epochsCompleted = (block.timestamp - userStake.stakeTimestamp) / epochDuration;
        emit RewardsClaimed(user, rewards, epochsCompleted);
    }

    /**
     * @dev Internal function to calculate rewards
     *      SELLING PENALTY: Uses current balance for all epochs if they sold
     *      BUYING MORE: Already handled by restake with auto-claim
     */
    function _calculateRewards(address user) internal view returns (uint256) {
        UserStake storage userStake = userStakes[user];
        if (userStake.stakedBalance == 0) return 0;

        uint256 timeStaked = block.timestamp - userStake.lastClaimTimestamp;
        if (timeStaked == 0) return 0;

        uint256 currentBalance = stakingToken.balanceOf(user);
        if (currentBalance == 0) return 0;

        // Calculate completed epochs (with fractional support for partial epochs)
        // Using 18 decimal precision for fractional epochs
        uint256 fractionalEpochs = (timeStaked * 1e18) / epochDuration;

        // SELLING PENALTY: Use current balance if they sold
        // This automatically penalizes them for ALL epochs
        uint256 effectiveBalance = currentBalance < userStake.stakedBalance
            ? currentBalance
            : userStake.stakedBalance;

        // Get multiplier based on effective balance
        uint256 multiplier = _getMultiplierForBalance(effectiveBalance);

        // Calculate rewards: fractionalEpochs × balance × baseRate × multiplier
        // baseRewardRate is per epoch, fractionalEpochs has 18 decimals
        uint256 rewards = (fractionalEpochs * effectiveBalance * baseRewardRate * multiplier) / (MULTIPLIER_DIVISOR * 1e18 * 1e18);

        return rewards;
    }

    /**
     * @dev View pending rewards for a user
     */
    function pendingRewards(address _user) external view returns (uint256) {
        return _calculateRewards(_user);
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

    /**
     * @dev Get current multiplier tier index for a user
     */
    function getUserTier(address _user) external view returns (uint256) {
        uint256 balance = stakingToken.balanceOf(_user);
        for (uint256 i = tierThresholds.length; i > 0; i--) {
            if (balance >= tierThresholds[i - 1]) {
                return i - 1;
            }
        }
        return 0;
    }

    /**
     * @dev Calculate epochs completed since staking
     */
    function getEpochsCompleted(address _user) external view returns (uint256) {
        UserStake storage userStake = userStakes[_user];
        if (userStake.stakeTimestamp == 0) return 0;
        return (block.timestamp - userStake.lastClaimTimestamp) / epochDuration;
    }

    /**
     * @dev Calculate fractional epochs with 18 decimal precision
     */
    function getFractionalEpochs(address _user) external view returns (uint256) {
        UserStake storage userStake = userStakes[_user];
        if (userStake.lastClaimTimestamp == 0) return 0;
        uint256 timeStaked = block.timestamp - userStake.lastClaimTimestamp;
        return (timeStaked * 1e18) / epochDuration;
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
     * @dev Update epoch duration (use with caution - affects all users)
     */
    function setEpochDuration(uint256 _duration) external onlyOwner {
        require(_duration > 0, "Epoch duration must be > 0");
        uint256 oldDuration = epochDuration;
        epochDuration = _duration;
        emit EpochDurationUpdated(oldDuration, _duration);
    }

    /**
     * @dev Update new token credit percentage
     */
    function setNewTokenCredit(uint256 _basisPoints) external onlyOwner {
        require(_basisPoints <= 10000, "Cannot exceed 100%");
        uint256 oldCredit = newTokenCreditBasisPoints;
        newTokenCreditBasisPoints = _basisPoints;
        emit NewTokenCreditUpdated(oldCredit, _basisPoints);
    }

    /**
     * @dev Update minimum claim interval
     */
    function setMinClaimInterval(uint256 _interval) external onlyOwner {
        uint256 oldInterval = minClaimInterval;
        minClaimInterval = _interval;
        emit MinClaimIntervalUpdated(oldInterval, _interval);
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
        require(_multiplier <= 100000, "Multiplier must be <= 10x (100000)");

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
     * @dev Remove the last multiplier tier
     */
    function removeLastTier() external onlyOwner {
        require(multiplierTiers.length > 1, "Cannot remove last tier");

        uint256 lastIndex = multiplierTiers.length - 1;
        multiplierTiers.pop();
        tierThresholds.pop();

        emit MultiplierTierRemoved(lastIndex);
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
     * @dev Get all tiers at once
     */
    function getAllTiers() external view returns (uint256[] memory multipliers, uint256[] memory thresholds) {
        return (multiplierTiers, tierThresholds);
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
     * @dev Update reward points token (use with extreme caution)
     */
    function setRewardPointsToken(address _token) external onlyOwner {
        require(_token != address(0), "Invalid token");
        rewardPoints = IRewardPoints(_token);
        emit RewardPointsSet(_token);
    }

    /**
     * @dev Get user stake details for dashboard
     */
    function getUserStakeData(address _user) external view returns (
        uint256 stakedBalance,
        uint256 stakeTimestamp,
        uint256 lastClaimTimestamp,
        uint256 totalClaimed,
        uint256 currentBalance,
        uint256 pendingReward,
        uint256 epochsCompleted,
        uint256 currentTier,
        uint256 currentMultiplier,
        bool hasSoldTokens
    ) {
        UserStake storage userStake = userStakes[_user];
        currentBalance = stakingToken.balanceOf(_user);
        currentMultiplier = this.getUserMultiplier(_user);
        currentTier = this.getUserTier(_user);
        pendingReward = this.pendingRewards(_user);
        hasSoldTokens = currentBalance < userStake.stakedBalance;

        if (userStake.stakeTimestamp > 0) {
            epochsCompleted = (block.timestamp - userStake.lastClaimTimestamp) / epochDuration;
        }

        return (
            userStake.stakedBalance,
            userStake.stakeTimestamp,
            userStake.lastClaimTimestamp,
            userStake.totalClaimed,
            currentBalance,
            pendingReward,
            epochsCompleted,
            currentTier,
            currentMultiplier,
            hasSoldTokens
        );
    }

    /**
     * @dev Get comprehensive system stats
     */
    function getSystemStats() external view returns (
        uint256 _baseRewardRate,
        uint256 _epochDuration,
        uint256 _newTokenCreditBasisPoints,
        uint256 _minClaimInterval,
        uint256 _tierCount,
        address _stakingToken,
        address _rewardPoints,
        bool _paused
    ) {
        return (
            baseRewardRate,
            epochDuration,
            newTokenCreditBasisPoints,
            minClaimInterval,
            multiplierTiers.length,
            address(stakingToken),
            address(rewardPoints),
            paused()
        );
    }

    /**
     * @dev Required by UUPS - only owner can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
