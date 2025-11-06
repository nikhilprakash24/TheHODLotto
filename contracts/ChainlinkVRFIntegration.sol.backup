// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@chainlink/contracts/src/v0.8/vrf/VRFConsumerBaseV2.sol";
import "@chainlink/contracts/src/v0.8/interfaces/VRFCoordinatorV2Interface.sol";
import "./LotteryDrawManagerV2.sol";

/**
 * @title ChainlinkVRFIntegration
 * @dev Extension of LotteryDrawManagerV2 with full Chainlink VRF support
 * @notice Use this version when you want provably fair randomness
 *
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Deploy VRFCoordinatorV2 (or use existing)
 * 2. Create subscription on Chainlink VRF
 * 3. Fund subscription with LINK
 * 4. Deploy this contract with subscription ID
 * 5. Add this contract as consumer to subscription
 */
contract LotteryDrawManagerV2WithVRF is VRFConsumerBaseV2 {

    // Inherit from LotteryDrawManagerV2 storage
    // NOTE: This is a pattern example. In production, you would either:
    // A) Make LotteryDrawManagerV2 inherit from VRFConsumerBaseV2, OR
    // B) Use this as a separate oracle contract that callbacks to DrawManager

    VRFCoordinatorV2Interface public COORDINATOR;

    // VRF configuration
    uint64 public subscriptionId;
    bytes32 public keyHash;
    uint32 public callbackGasLimit = 2500000;
    uint16 public requestConfirmations = 3;
    uint32 public numWords = 1;

    // Mapping from VRF request ID to draw ID
    mapping(uint256 => uint256) public vrfRequestToDrawId;

    // Reference to main draw manager
    LotteryDrawManagerV2 public drawManager;

    // Events
    event VRFRequested(uint256 indexed requestId, uint256 indexed drawId);
    event VRFFulfilled(uint256 indexed requestId, uint256 indexed drawId, uint256 randomNumber);

    /**
     * @dev Constructor
     * @param _vrfCoordinator Address of VRF Coordinator
     * @param _subscriptionId Chainlink subscription ID
     * @param _keyHash Key hash for VRF
     * @param _drawManager Address of main draw manager contract
     */
    constructor(
        address _vrfCoordinator,
        uint64 _subscriptionId,
        bytes32 _keyHash,
        address _drawManager
    ) VRFConsumerBaseV2(_vrfCoordinator) {
        COORDINATOR = VRFCoordinatorV2Interface(_vrfCoordinator);
        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        drawManager = LotteryDrawManagerV2(_drawManager);
    }

    /**
     * @dev Request random number from Chainlink VRF
     * @param _drawId Draw ID to associate with request
     * @return requestId VRF request ID
     */
    function requestRandomWords(uint256 _drawId) external returns (uint256 requestId) {
        // Only draw manager can request
        require(msg.sender == address(drawManager), "Only draw manager");

        // Request random words from VRF Coordinator
        requestId = COORDINATOR.requestRandomWords(
            keyHash,
            subscriptionId,
            requestConfirmations,
            callbackGasLimit,
            numWords
        );

        vrfRequestToDrawId[requestId] = _drawId;
        emit VRFRequested(requestId, _drawId);
        return requestId;
    }

    /**
     * @dev Callback function used by VRF Coordinator
     * @param _requestId VRF request ID
     * @param _randomWords Array of random numbers
     */
    function fulfillRandomWords(uint256 _requestId, uint256[] memory _randomWords)
        internal
        override
    {
        uint256 drawId = vrfRequestToDrawId[_requestId];
        uint256 randomNumber = _randomWords[0];

        emit VRFFulfilled(_requestId, drawId, randomNumber);

        // TODO: Callback to draw manager to complete draw
        // This requires draw manager to have a completeDraw() function
        // drawManager.completeDrawWithVRF(drawId, randomNumber);
    }

    /**
     * @dev Update VRF configuration
     */
    function updateVRFConfig(
        uint64 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations
    ) external {
        require(msg.sender == address(drawManager), "Only draw manager");
        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;
    }
}

/**
 * @title Chainlink VRF Integration Guide
 *
 * NETWORK CONFIGURATIONS:
 *
 * Ethereum Mainnet:
 * - Coordinator: 0x271682DEB8C4E0901D1a1550aD2e64D568E69909
 * - Key Hash: 0x8af398995b04c28e9951adb9721ef74c74f93e6a478f39e7e0777be13527e7ef
 * - Fee: 2.5 LINK
 *
 * Sepolia Testnet:
 * - Coordinator: 0x8103B0A8A00be2DDC778e6e7eaa21791Cd364625
 * - Key Hash: 0x474e34a077df58807dbe9c96d3c009b23b3c6d0cce433e59bbf5b34f823bc56c
 * - Fee: 0.25 LINK
 *
 * Polygon Mainnet:
 * - Coordinator: 0xAE975071Be8F8eE67addBC1A82488F1C24858067
 * - Key Hash: 0xd729dc84e21ae57ffb6be0053bf2b0668aa2aaf300a2a7b2ddf7dc0bb6e875a8
 * - Fee: 0.0001 LINK
 *
 * SETUP STEPS:
 * 1. Go to vrf.chain.link
 * 2. Create subscription
 * 3. Fund with LINK tokens
 * 4. Deploy LotteryDrawManagerV2WithVRF
 * 5. Add contract as consumer
 * 6. Set randomness mode to CHAINLINK_VRF in main contract
 *
 * COST ESTIMATES:
 * - Ethereum: ~$50-100 per draw (2.5 LINK @ $20/LINK + gas)
 * - Polygon: ~$0.01-0.05 per draw (0.0001 LINK + gas)
 * - Sepolia: FREE (testnet LINK)
 */
