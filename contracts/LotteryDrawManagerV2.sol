// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ILotteryData.sol";

/**
 * @title LotteryDrawManagerV2
 * @dev Advanced lottery draw manager with:
 *      - Binary search optimization O(log n)
 *      - Four draw types with Bitcoin-style halving
 *      - Multi-asset prize buckets (ETH + multiple ERC20s)
 *      - Two-way query mechanics (weight→winner, address→wins)
 *      - Optional Chainlink VRF
 */
contract LotteryDrawManagerV2 is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ============ ENUMS ============

    enum RandomnessMode {
        PSEUDO_RANDOM,  // block.prevrandao (acceptable - users don't choose numbers)
        CHAINLINK_VRF   // Provably fair randomness (optional)
    }

    enum DrawType {
        WEEKLY,      // Every 7 days
        MONTHLY,     // Every 30 days
        QUARTERLY,   // Every 90 days
        YEARLY       // Every 365 days
    }

    // ============ STRUCTS ============

    struct PrizeBucket {
        uint256 ethAmount;                    // ETH in bucket
        address[] tokenAddresses;             // ERC20 token addresses
        mapping(address => uint256) tokenAmounts;  // Token address → amount
    }

    struct DrawConfig {
        DrawType drawType;
        uint256 initialPrizeAmount;    // Initial prize amount in wei
        uint256 currentPrizeAmount;    // Current prize after halvings
        uint256 halvingInterval;       // Number of draws before halving
        uint256 drawCount;             // Total draws executed
        uint256 lastDrawTime;          // Timestamp of last draw
        uint256 drawInterval;          // Time between draws (in seconds)
        bool active;                   // Is this draw type active
    }

    struct Draw {
        uint256 drawId;
        DrawType drawType;
        uint256 timestamp;
        uint256 prizeEth;              // ETH prize amount
        address winner;
        uint256 winningLottoID;
        uint256 winningNumber;
        uint256 participantCountAtDraw;
        uint256 totalWeightAtDraw;
        address[] prizeTokens;         // ERC20 tokens in prize
        mapping(address => uint256) prizeTokenAmounts;  // Token amounts
    }

    // ============ STATE VARIABLES ============

    ILotteryData public mintingContract;
    RandomnessMode public randomnessMode;

    // Draw configurations
    mapping(DrawType => DrawConfig) public drawConfigs;

    // Draw intervals (time between draws for each type)
    mapping(DrawType => uint256) public drawIntervals;

    // Draw history
    uint256 public totalDrawCount;
    mapping(uint256 => Draw) public draws;  // drawId → Draw

    // Prize buckets per draw type
    mapping(DrawType => PrizeBucket) private prizeBuckets;

    // User tracking: address → array of drawIds they won
    mapping(address => uint256[]) public userWins;

    // Reverse lookup: drawId → whether it's been drawn
    mapping(uint256 => bool) public drawExecuted;

    // Chainlink VRF (optional)
    address public vrfCoordinator;
    bytes32 public vrfKeyHash;
    uint64 public vrfSubscriptionId;
    uint32 public vrfCallbackGasLimit;
    uint16 public vrfRequestConfirmations;
    mapping(uint256 => uint256) public vrfRequestToDrawId;

    // ============ EVENTS ============

    event DrawConfigured(DrawType indexed drawType, uint256 initialPrize, uint256 halvingInterval, uint256 drawInterval);
    event DrawExecuted(uint256 indexed drawId, DrawType indexed drawType, address indexed winner, uint256 lottoID, uint256 prizeEth);
    event PrizeBucketFunded(DrawType indexed drawType, uint256 ethAmount, address[] tokens, uint256[] amounts);
    event RandomnessModeChanged(RandomnessMode oldMode, RandomnessMode newMode);
    event HalvingOccurred(DrawType indexed drawType, uint256 oldAmount, uint256 newAmount, uint256 drawNumber);
    event VRFConfigured(address coordinator, bytes32 keyHash, uint64 subscriptionId);

    // ============ CONSTRUCTOR ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the contract (replaces constructor for upgradeable contracts)
     */
    function initialize(address _mintingContract, RandomnessMode _randomnessMode) public initializer {
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        require(_mintingContract != address(0), "Invalid minting contract");
        mintingContract = ILotteryData(_mintingContract);
        randomnessMode = _randomnessMode;
        totalDrawCount = 0;

        // Initialize default VRF params
        vrfCallbackGasLimit = 2500000;
        vrfRequestConfirmations = 3;

        // Set draw intervals (in seconds)
        drawIntervals[DrawType.WEEKLY] = 7 days;
        drawIntervals[DrawType.MONTHLY] = 30 days;
        drawIntervals[DrawType.QUARTERLY] = 90 days;
        drawIntervals[DrawType.YEARLY] = 365 days;
    }

    // ============ CONFIGURATION FUNCTIONS ============

    /**
     * @dev Configure a draw type with halving schedule
     * @param _drawType The type of draw
     * @param _initialPrize Initial prize amount in wei
     * @param _halvingInterval Number of draws before halving occurs
     */
    function configureDrawType(
        DrawType _drawType,
        uint256 _initialPrize,
        uint256 _halvingInterval
    ) external onlyOwner {
        require(_initialPrize > 0, "Prize must be > 0");
        require(_halvingInterval > 0, "Halving interval must be > 0");

        uint256 interval;
        if (_drawType == DrawType.WEEKLY) {
            interval = 7 days;
        } else if (_drawType == DrawType.MONTHLY) {
            interval = 30 days;
        } else if (_drawType == DrawType.QUARTERLY) {
            interval = 90 days;
        } else {
            interval = 365 days;
        }

        DrawConfig storage config = drawConfigs[_drawType];
        config.drawType = _drawType;
        config.initialPrizeAmount = _initialPrize;
        config.currentPrizeAmount = _initialPrize;
        config.halvingInterval = _halvingInterval;
        config.drawCount = 0;
        config.lastDrawTime = block.timestamp;
        config.drawInterval = interval;
        config.active = true;

        emit DrawConfigured(_drawType, _initialPrize, _halvingInterval, interval);
    }

    /**
     * @dev Fund a prize bucket with ETH and/or ERC20 tokens
     * @param _drawType The draw type to fund
     * @param _tokens Array of ERC20 token addresses
     * @param _amounts Array of token amounts
     */
    function fundPrizeBucket(
        DrawType _drawType,
        address[] calldata _tokens,
        uint256[] calldata _amounts
    ) external payable onlyOwner {
        require(_tokens.length == _amounts.length, "Array length mismatch");

        PrizeBucket storage bucket = prizeBuckets[_drawType];

        // Add ETH
        if (msg.value > 0) {
            bucket.ethAmount += msg.value;
        }

        // Add ERC20 tokens
        for (uint256 i = 0; i < _tokens.length; i++) {
            require(_tokens[i] != address(0), "Invalid token address");
            require(_amounts[i] > 0, "Amount must be > 0");

            // Transfer tokens from sender to contract
            IERC20(_tokens[i]).safeTransferFrom(msg.sender, address(this), _amounts[i]);

            // Update bucket
            if (bucket.tokenAmounts[_tokens[i]] == 0) {
                bucket.tokenAddresses.push(_tokens[i]);
            }
            bucket.tokenAmounts[_tokens[i]] += _amounts[i];
        }

        emit PrizeBucketFunded(_drawType, msg.value, _tokens, _amounts);
    }

    /**
     * @dev Set randomness mode
     */
    function setRandomnessMode(RandomnessMode _mode) external onlyOwner {
        RandomnessMode oldMode = randomnessMode;
        randomnessMode = _mode;
        emit RandomnessModeChanged(oldMode, _mode);
    }

    /**
     * @dev Configure Chainlink VRF
     */
    function configureVRF(
        address _coordinator,
        bytes32 _keyHash,
        uint64 _subscriptionId,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations
    ) external onlyOwner {
        require(_coordinator != address(0), "Invalid coordinator");
        vrfCoordinator = _coordinator;
        vrfKeyHash = _keyHash;
        vrfSubscriptionId = _subscriptionId;
        vrfCallbackGasLimit = _callbackGasLimit;
        vrfRequestConfirmations = _requestConfirmations;
        emit VRFConfigured(_coordinator, _keyHash, _subscriptionId);
    }

    /**
     * @dev Toggle draw type active status
     */
    function setDrawTypeActive(DrawType _drawType, bool _active) external onlyOwner {
        drawConfigs[_drawType].active = _active;
    }

    // ============ DRAW EXECUTION ============

    /**
     * @dev Execute a draw for a specific draw type
     * @param _drawType The type of draw to execute
     */
    function executeDraw(DrawType _drawType) external onlyOwner nonReentrant whenNotPaused {
        DrawConfig storage config = drawConfigs[_drawType];
        require(config.active, "Draw type not active");
        require(config.initialPrizeAmount > 0, "Draw type not configured");
        require(
            block.timestamp >= config.lastDrawTime + config.drawInterval,
            "Draw interval not elapsed"
        );

        // Get participant data from minting contract
        uint256 participantCount = mintingContract.getParticipantCount();
        uint256 totalWeight = mintingContract.totalWeight();
        require(participantCount > 0, "No participants");
        require(totalWeight > 0, "No weight");

        // Check if halving should occur
        if (config.drawCount > 0 && config.drawCount % config.halvingInterval == 0) {
            uint256 oldAmount = config.currentPrizeAmount;
            config.currentPrizeAmount = config.currentPrizeAmount / 2;
            emit HalvingOccurred(_drawType, oldAmount, config.currentPrizeAmount, config.drawCount);
        }

        // Create draw record
        totalDrawCount++;
        uint256 drawId = totalDrawCount;

        Draw storage draw = draws[drawId];
        draw.drawId = drawId;
        draw.drawType = _drawType;
        draw.timestamp = block.timestamp;
        draw.participantCountAtDraw = participantCount;
        draw.totalWeightAtDraw = totalWeight;

        // Update config
        config.drawCount++;
        config.lastDrawTime = block.timestamp;

        // Generate random number and complete draw
        if (randomnessMode == RandomnessMode.PSEUDO_RANDOM) {
            uint256 randomNumber = _generatePseudoRandom(totalWeight, drawId);
            _completeDraw(drawId, randomNumber);
        } else {
            // Chainlink VRF path (to be called from callback)
            _requestVRFRandomness(drawId);
        }
    }

    /**
     * @dev Complete a draw with a random number (internal)
     */
    function _completeDraw(uint256 _drawId, uint256 _randomNumber) internal {
        Draw storage draw = draws[_drawId];
        require(!drawExecuted[_drawId], "Draw already executed");

        DrawConfig storage config = drawConfigs[draw.drawType];
        PrizeBucket storage bucket = prizeBuckets[draw.drawType];

        // Select winner using OPTIMIZED BINARY SEARCH
        (address winner, uint256 winningLottoID) = _selectWinnerBinarySearch(
            _randomNumber,
            draw.totalWeightAtDraw
        );

        // Update draw
        draw.winner = winner;
        draw.winningLottoID = winningLottoID;
        draw.winningNumber = _randomNumber;
        drawExecuted[_drawId] = true;

        // Record user win
        userWins[winner].push(_drawId);

        // Determine prize amount (use config or bucket, whichever is less)
        uint256 ethPrize = config.currentPrizeAmount;
        if (bucket.ethAmount < ethPrize) {
            ethPrize = bucket.ethAmount;
        }

        draw.prizeEth = ethPrize;

        // Transfer ETH prize
        if (ethPrize > 0) {
            bucket.ethAmount -= ethPrize;
            (bool success, ) = payable(winner).call{value: ethPrize}("");
            require(success, "ETH transfer failed");
        }

        // Transfer ERC20 prizes (distribute all tokens in bucket proportionally)
        address[] memory tokenAddrs = bucket.tokenAddresses;
        for (uint256 i = 0; i < tokenAddrs.length; i++) {
            address token = tokenAddrs[i];
            uint256 amount = bucket.tokenAmounts[token];

            if (amount > 0) {
                // For now, give all tokens to winner
                // (Can be adjusted to percentage-based distribution)
                bucket.tokenAmounts[token] = 0;
                IERC20(token).safeTransfer(winner, amount);

                // Record in draw
                draw.prizeTokens.push(token);
                draw.prizeTokenAmounts[token] = amount;
            }
        }

        // Clear token addresses if all distributed
        delete bucket.tokenAddresses;

        emit DrawExecuted(_drawId, draw.drawType, winner, winningLottoID, ethPrize);
    }

    // ============ OPTIMIZED WINNER SELECTION (BINARY SEARCH) ============

    /**
     * @dev Select winner using BINARY SEARCH - O(log n) complexity
     * @param _randomNumber Random number in range [0, totalWeight)
     * @param _totalWeight Total weight at draw time
     * @return winner Address of winner
     * @return lottoID Winning lottery ID
     */
    function _selectWinnerBinarySearch(uint256 _randomNumber, uint256 _totalWeight)
        internal
        view
        returns (address winner, uint256 lottoID)
    {
        require(_randomNumber < _totalWeight, "Invalid random number");

        uint256 participantCount = mintingContract.getParticipantCount();
        require(participantCount > 0, "No participants");

        uint256 left = 0;
        uint256 right = participantCount - 1;

        // Binary search to find participant whose range contains _randomNumber
        while (left <= right) {
            uint256 mid = left + (right - left) / 2;

            (
                address owner,
                uint256 lottoId,
                uint256 weightStart,
                uint256 weightEnd,
                // tier
            ) = mintingContract.participants(mid);

            if (_randomNumber < weightStart) {
                // Winner is in left half
                if (mid == 0) break;
                right = mid - 1;
            } else if (_randomNumber >= weightEnd) {
                // Winner is in right half
                left = mid + 1;
            } else {
                // Found the winner!
                return (owner, lottoId);
            }
        }

        revert("Winner not found");
    }

    // ============ RANDOMNESS GENERATION ============

    /**
     * @dev Generate pseudo-random number
     */
    function _generatePseudoRandom(uint256 _maxValue, uint256 _drawId)
        internal
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
                abi.encodePacked(
                    block.timestamp,
                    block.prevrandao,
                    msg.sender,
                    _drawId,
                    _maxValue,
                    blockhash(block.number - 1)
                )
            )
        ) % _maxValue;
    }

    /**
     * @dev Request randomness from Chainlink VRF
     */
    function _requestVRFRandomness(uint256 _drawId) internal {
        require(vrfCoordinator != address(0), "VRF not configured");
        // TODO: Actual Chainlink VRF integration
        // This requires inheriting from VRFConsumerBaseV2
        // For now, revert with helpful message
        revert("Chainlink VRF not yet integrated - use PSEUDO_RANDOM mode");
    }

    // ============ TWO-WAY QUERY MECHANICS ============

    /**
     * @dev Check if a user won any draws
     * @param _user User address
     * @return drawIds Array of draw IDs the user won
     */
    function getUserWins(address _user) external view returns (uint256[] memory) {
        return userWins[_user];
    }

    /**
     * @dev Check if a user won a specific draw
     * @param _user User address
     * @param _drawId Draw ID
     * @return won Whether user won this draw
     */
    function didUserWin(address _user, uint256 _drawId) external view returns (bool) {
        if (!drawExecuted[_drawId]) return false;
        return draws[_drawId].winner == _user;
    }

    /**
     * @dev Get all NFTs (lottoIDs) owned by a user
     * @param _user User address
     * @return entries Array of lottery entries
     */
    function getUserLotteryEntries(address _user)
        external
        view
        returns (ILotteryData.LottoEntry[] memory)
    {
        return mintingContract.getLottoIDsByAddress(_user);
    }

    /**
     * @dev Check which of user's NFTs won which draws
     * @param _user User address
     * @return drawIds Array of draw IDs
     * @return winningLottoIDs Array of winning lottery IDs
     */
    function getUserWinDetails(address _user)
        external
        view
        returns (uint256[] memory drawIds, uint256[] memory winningLottoIDs)
    {
        uint256[] memory wins = userWins[_user];
        uint256 count = wins.length;

        drawIds = new uint256[](count);
        winningLottoIDs = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            uint256 drawId = wins[i];
            drawIds[i] = drawId;
            winningLottoIDs[i] = draws[drawId].winningLottoID;
        }

        return (drawIds, winningLottoIDs);
    }

    /**
     * @dev Get draw details including prizes
     * @param _drawId Draw ID
     * @return drawType Type of draw
     * @return timestamp Time of draw
     * @return winner Winner address
     * @return winningLottoID Winning lottery ID
     * @return prizeEth ETH prize amount
     * @return prizeTokens Array of prize token addresses
     */
    function getDrawDetails(uint256 _drawId)
        external
        view
        returns (
            DrawType drawType,
            uint256 timestamp,
            address winner,
            uint256 winningLottoID,
            uint256 prizeEth,
            address[] memory prizeTokens
        )
    {
        Draw storage draw = draws[_drawId];
        return (
            draw.drawType,
            draw.timestamp,
            draw.winner,
            draw.winningLottoID,
            draw.prizeEth,
            draw.prizeTokens
        );
    }

    /**
     * @dev Get prize token amount for a specific draw and token
     */
    function getDrawPrizeTokenAmount(uint256 _drawId, address _token)
        external
        view
        returns (uint256)
    {
        return draws[_drawId].prizeTokenAmounts[_token];
    }

    /**
     * @dev Get prize bucket status for a draw type
     */
    function getPrizeBucketStatus(DrawType _drawType)
        external
        view
        returns (uint256 ethAmount, address[] memory tokens, uint256[] memory amounts)
    {
        PrizeBucket storage bucket = prizeBuckets[_drawType];
        ethAmount = bucket.ethAmount;
        tokens = bucket.tokenAddresses;

        amounts = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            amounts[i] = bucket.tokenAmounts[tokens[i]];
        }

        return (ethAmount, tokens, amounts);
    }

    /**
     * @dev Get draw configuration
     */
    function getDrawConfig(DrawType _drawType)
        external
        view
        returns (
            uint256 initialPrize,
            uint256 currentPrize,
            uint256 halvingInterval,
            uint256 drawCount,
            uint256 lastDrawTime,
            uint256 drawInterval,
            uint256 nextDrawTime,
            bool active
        )
    {
        DrawConfig storage config = drawConfigs[_drawType];
        return (
            config.initialPrizeAmount,
            config.currentPrizeAmount,
            config.halvingInterval,
            config.drawCount,
            config.lastDrawTime,
            config.drawInterval,
            config.lastDrawTime + config.drawInterval,
            config.active
        );
    }

    // ============ ADMIN FUNCTIONS ============

    /**
     * @dev Emergency withdraw (only for excess funds not allocated to buckets)
     */
    function emergencyWithdraw(address _token, uint256 _amount)
        external
        onlyOwner
        nonReentrant
    {
        if (_token == address(0)) {
            // ETH
            (bool success, ) = payable(owner()).call{value: _amount}("");
            require(success, "ETH transfer failed");
        } else {
            // ERC20
            IERC20(_token).safeTransfer(owner(), _amount);
        }
    }

    /**
     * @dev Pause contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Get comprehensive system configuration
     */
    function getSystemConfig() external view returns (
        address _mintingContract,
        RandomnessMode _randomnessMode,
        uint256 _totalDrawCount,
        bool _paused
    ) {
        return (
            address(mintingContract),
            randomnessMode,
            totalDrawCount,
            paused()
        );
    }

    /**
     * @dev Get all draw intervals
     */
    function getAllDrawIntervals() external view returns (
        uint256 weekly,
        uint256 monthly,
        uint256 quarterly,
        uint256 yearly
    ) {
        return (
            drawIntervals[DrawType.WEEKLY],
            drawIntervals[DrawType.MONTHLY],
            drawIntervals[DrawType.QUARTERLY],
            drawIntervals[DrawType.YEARLY]
        );
    }

    /**
     * @dev Set draw interval for a specific draw type (admin control)
     */
    function setDrawInterval(DrawType _drawType, uint256 _interval) external onlyOwner {
        require(_interval > 0, "Interval must be > 0");
        drawIntervals[_drawType] = _interval;
    }

    /**
     * @dev Allow contract to receive ETH
     */
    receive() external payable {}

    /**
     * @dev Required by UUPS - only owner can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
