// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./ILotteryData.sol";

/**
 * @title LotteryDrawManager
 * @dev Manages lottery draws with time-based rounds (weekly, monthly) and configurable randomness
 * @notice This contract reads participant data from the minting contract and handles prize distribution
 */
contract LotteryDrawManager is Ownable, ReentrancyGuard, Pausable {

    // Randomness mode
    enum RandomnessMode {
        PSEUDO_RANDOM,  // Uses block.prevrandao (acceptable since users don't choose numbers)
        CHAINLINK_VRF   // Uses Chainlink VRF for provably fair randomness
    }

    // Round type
    enum RoundType {
        WEEKLY,
        MONTHLY,
        CUSTOM
    }

    // Round information
    struct Round {
        uint256 roundId;
        RoundType roundType;
        uint256 startTime;
        uint256 endTime;
        uint256 prizePool;
        address winner;
        uint256 winningLottoID;
        uint256 winningNumber;
        bool drawn;
        uint256 participantCountAtDraw;
        uint256 totalWeightAtDraw;
    }

    // State variables
    ILotteryData public mintingContract;
    RandomnessMode public randomnessMode;

    // Round management
    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    uint256 public weeklyPrizeAmount;
    uint256 public monthlyPrizeAmount;

    // Chainlink VRF (to be implemented when mode is CHAINLINK_VRF)
    address public vrfCoordinator;
    bytes32 public keyHash;
    uint64 public subscriptionId;
    mapping(uint256 => uint256) public vrfRequestToRound;  // VRF request ID to round ID

    // Events
    event RoundCreated(uint256 indexed roundId, RoundType roundType, uint256 startTime, uint256 endTime, uint256 prizePool);
    event RoundDrawn(uint256 indexed roundId, address indexed winner, uint256 lottoID, uint256 winningNumber, uint256 prize);
    event RandomnessModeChanged(RandomnessMode oldMode, RandomnessMode newMode);
    event PrizeAmountSet(RoundType roundType, uint256 amount);
    event VRFConfigUpdated(address vrfCoordinator, bytes32 keyHash, uint64 subscriptionId);

    /**
     * @dev Constructor
     * @param _mintingContract Address of the minting contract
     * @param _randomnessMode Initial randomness mode
     */
    constructor(
        address _mintingContract,
        RandomnessMode _randomnessMode
    ) {
        require(_mintingContract != address(0), "Invalid minting contract address");
        mintingContract = ILotteryData(_mintingContract);
        randomnessMode = _randomnessMode;
        currentRoundId = 0;
    }

    /**
     * @dev Sets the randomness mode
     * @param _mode The new randomness mode
     */
    function setRandomnessMode(RandomnessMode _mode) external onlyOwner {
        RandomnessMode oldMode = randomnessMode;
        randomnessMode = _mode;
        emit RandomnessModeChanged(oldMode, _mode);
    }

    /**
     * @dev Sets prize amounts for different round types
     * @param _roundType The round type
     * @param _amount The prize amount in wei
     */
    function setPrizeAmount(RoundType _roundType, uint256 _amount) external onlyOwner {
        require(_amount > 0, "Prize amount must be greater than 0");

        if (_roundType == RoundType.WEEKLY) {
            weeklyPrizeAmount = _amount;
        } else if (_roundType == RoundType.MONTHLY) {
            monthlyPrizeAmount = _amount;
        }

        emit PrizeAmountSet(_roundType, _amount);
    }

    /**
     * @dev Configures Chainlink VRF settings
     * @param _vrfCoordinator VRF Coordinator address
     * @param _keyHash Key hash for VRF
     * @param _subscriptionId Subscription ID
     */
    function setVRFConfig(
        address _vrfCoordinator,
        bytes32 _keyHash,
        uint64 _subscriptionId
    ) external onlyOwner {
        require(_vrfCoordinator != address(0), "Invalid VRF coordinator");
        vrfCoordinator = _vrfCoordinator;
        keyHash = _keyHash;
        subscriptionId = _subscriptionId;
        emit VRFConfigUpdated(_vrfCoordinator, _keyHash, _subscriptionId);
    }

    /**
     * @dev Creates a new lottery round
     * @param _roundType Type of round (weekly, monthly, custom)
     * @param _duration Duration in seconds (for custom rounds)
     * @param _prizePool Prize pool for this round (for custom rounds, or 0 to use default)
     */
    function createRound(
        RoundType _roundType,
        uint256 _duration,
        uint256 _prizePool
    ) external onlyOwner returns (uint256) {
        uint256 startTime = block.timestamp;
        uint256 endTime;
        uint256 prizeAmount;

        // Determine end time and prize based on round type
        if (_roundType == RoundType.WEEKLY) {
            endTime = startTime + 7 days;
            prizeAmount = _prizePool > 0 ? _prizePool : weeklyPrizeAmount;
            require(prizeAmount > 0, "Weekly prize amount not set");
        } else if (_roundType == RoundType.MONTHLY) {
            endTime = startTime + 30 days;
            prizeAmount = _prizePool > 0 ? _prizePool : monthlyPrizeAmount;
            require(prizeAmount > 0, "Monthly prize amount not set");
        } else {
            require(_duration > 0, "Custom duration must be greater than 0");
            require(_prizePool > 0, "Custom prize pool must be greater than 0");
            endTime = startTime + _duration;
            prizeAmount = _prizePool;
        }

        currentRoundId++;

        rounds[currentRoundId] = Round({
            roundId: currentRoundId,
            roundType: _roundType,
            startTime: startTime,
            endTime: endTime,
            prizePool: prizeAmount,
            winner: address(0),
            winningLottoID: 0,
            winningNumber: 0,
            drawn: false,
            participantCountAtDraw: 0,
            totalWeightAtDraw: 0
        });

        emit RoundCreated(currentRoundId, _roundType, startTime, endTime, prizeAmount);
        return currentRoundId;
    }

    /**
     * @dev Draws the lottery for a specific round
     * @param _roundId The round ID to draw
     */
    function drawRound(uint256 _roundId) external onlyOwner nonReentrant whenNotPaused {
        Round storage round = rounds[_roundId];
        require(round.roundId == _roundId, "Round does not exist");
        require(!round.drawn, "Round already drawn");
        require(block.timestamp >= round.endTime, "Round not ended yet");

        // Get participant data from minting contract
        uint256 participantCount = mintingContract.getParticipantCount();
        uint256 totalWeight = mintingContract.totalWeight();

        require(participantCount > 0, "No participants");
        require(totalWeight > 0, "No weight");

        // Store snapshot
        round.participantCountAtDraw = participantCount;
        round.totalWeightAtDraw = totalWeight;

        // Generate random number based on mode
        uint256 randomNumber;
        if (randomnessMode == RandomnessMode.PSEUDO_RANDOM) {
            randomNumber = _generatePseudoRandom(totalWeight, _roundId);
            _completeDrawing(_roundId, randomNumber);
        } else {
            // For Chainlink VRF, we request random number and complete in callback
            _requestChainlinkVRF(_roundId);
            // Drawing will be completed in fulfillRandomWords callback
            return;
        }
    }

    /**
     * @dev Generates pseudo-random number using block data
     * @param _maxValue Maximum value for random number
     * @param _roundId Round ID for additional entropy
     * @return Random number between 0 and _maxValue-1
     */
    function _generatePseudoRandom(uint256 _maxValue, uint256 _roundId) internal view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(
            block.timestamp,
            block.prevrandao,  // Post-merge randomness
            msg.sender,
            _roundId,
            _maxValue,
            blockhash(block.number - 1)
        ))) % _maxValue;
    }

    /**
     * @dev Requests random number from Chainlink VRF
     * @param _roundId Round ID to associate with the request
     */
    function _requestChainlinkVRF(uint256 _roundId) internal {
        require(vrfCoordinator != address(0), "VRF not configured");
        // TODO: Implement Chainlink VRF request
        // This is a placeholder - actual implementation requires VRFConsumerBaseV2
        // uint256 requestId = COORDINATOR.requestRandomWords(...)
        // vrfRequestToRound[requestId] = _roundId;
        revert("Chainlink VRF not yet implemented - use PSEUDO_RANDOM mode");
    }

    /**
     * @dev Completes the drawing process with a random number
     * @param _roundId The round ID
     * @param _randomNumber The random number to use for selection
     */
    function _completeDrawing(uint256 _roundId, uint256 _randomNumber) internal {
        Round storage round = rounds[_roundId];

        // Select winner using weighted selection
        address winner = _selectWinner(_randomNumber, round.totalWeightAtDraw);

        // Find the winning lottoID
        uint256 winningLottoID = _findWinningLottoID(winner, _randomNumber);

        // Update round
        round.winner = winner;
        round.winningLottoID = winningLottoID;
        round.winningNumber = _randomNumber;
        round.drawn = true;

        // Transfer prize to winner
        if (round.prizePool > 0 && address(this).balance >= round.prizePool) {
            (bool success, ) = payable(winner).call{value: round.prizePool}("");
            require(success, "Prize transfer failed");
        }

        emit RoundDrawn(_roundId, winner, winningLottoID, _randomNumber, round.prizePool);
    }

    /**
     * @dev Selects winner based on random number and weighted ranges
     * @param _randomNumber Random number within [0, totalWeight)
     * @param _totalWeight Total weight at time of draw
     * @return Address of the winner
     */
    function _selectWinner(uint256 _randomNumber, uint256 _totalWeight) internal view returns (address) {
        require(_randomNumber < _totalWeight, "Invalid random number");

        // Linear search through participants to find winner
        uint256 participantCount = mintingContract.getParticipantCount();

        for (uint256 i = 0; i < participantCount; i++) {
            (
                address owner,
                ,  // lottoID
                uint256 weightStart,
                uint256 weightEnd,
                   // tier
            ) = mintingContract.participants(i);

            if (_randomNumber >= weightStart && _randomNumber < weightEnd) {
                return owner;
            }
        }

        revert("Winner not found");
    }

    /**
     * @dev Finds the winning lottoID for a given winner and random number
     * @param _winner The winner's address
     * @param _randomNumber The winning random number
     * @return The winning lottoID
     */
    function _findWinningLottoID(address _winner, uint256 _randomNumber) internal view returns (uint256) {
        uint256 participantCount = mintingContract.getParticipantCount();

        for (uint256 i = 0; i < participantCount; i++) {
            (
                address owner,
                uint256 lottoID,
                uint256 weightStart,
                uint256 weightEnd,
                   // tier
            ) = mintingContract.participants(i);

            if (owner == _winner && _randomNumber >= weightStart && _randomNumber < weightEnd) {
                return lottoID;
            }
        }

        return 0;  // Should not happen
    }

    /**
     * @dev Returns round information
     * @param _roundId The round ID
     */
    function getRound(uint256 _roundId) external view returns (Round memory) {
        return rounds[_roundId];
    }

    /**
     * @dev Allows owner to fund the contract for prizes
     */
    receive() external payable {}

    /**
     * @dev Withdraws excess funds (not allocated to active rounds)
     * @param _amount Amount to withdraw
     */
    function withdrawFunds(uint256 _amount) external onlyOwner nonReentrant {
        require(_amount <= address(this).balance, "Insufficient balance");
        (bool success, ) = payable(owner()).call{value: _amount}("");
        require(success, "Withdrawal failed");
    }

    /**
     * @dev Emergency pause function
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Returns the current randomness mode as a string
     */
    function getRandomnessMode() external view returns (string memory) {
        if (randomnessMode == RandomnessMode.PSEUDO_RANDOM) {
            return "PSEUDO_RANDOM";
        } else {
            return "CHAINLINK_VRF";
        }
    }
}
