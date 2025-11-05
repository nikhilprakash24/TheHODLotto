// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title ILotteryData
 * @dev Interface for reading lottery data from the minting contract
 */
interface ILotteryData {
    // Struct definitions (must match minting contract)
    struct Participant {
        address owner;
        uint256 lottoID;
        uint256 weightStart;
        uint256 weightEnd;
        uint256 tier;
    }

    struct LottoEntry {
        uint256 lottoID;
        uint256 weight;
    }

    // View functions
    function participants(uint256 index) external view returns (
        address owner,
        uint256 lottoID,
        uint256 weightStart,
        uint256 weightEnd,
        uint256 tier
    );

    function getParticipantCount() external view returns (uint256);
    function totalWeight() external view returns (uint256);
    function lotteryActive() external view returns (bool);
    function getLottoIDsByAddress(address user) external view returns (LottoEntry[] memory);
    function lottoIDIndexer(uint256 lottoID) external view returns (address);

    // State management functions (only callable by authorized contracts)
    function deactivateLottery() external;
    function activateLottery() external;
}
