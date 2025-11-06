// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title RewardPoints
 * @dev ERC20 token that can ONLY be used for NFT lottery tickets and game bets (UUPS Upgradeable)
 *      Can only be minted by the RewardPointsManager contract
 *      Non-transferable to prevent secondary markets
 */
contract RewardPoints is Initializable, ERC20Upgradeable, OwnableUpgradeable, UUPSUpgradeable {

    // Authorized contracts that can accept reward points as payment
    mapping(address => bool) public authorizedSpenders;

    // The RewardPointsManager contract (only one that can mint)
    address public rewardManager;

    event AuthorizedSpenderAdded(address indexed spender);
    event AuthorizedSpenderRemoved(address indexed spender);
    event RewardManagerSet(address indexed manager);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the contract
     */
    function initialize() public initializer {
        __ERC20_init("HODL Reward Points", "HPOINTS");
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
    }

    /**
     * @dev Set the reward manager (can only be set once for security)
     */
    function setRewardManager(address _manager) external onlyOwner {
        require(rewardManager == address(0), "Manager already set");
        require(_manager != address(0), "Invalid manager address");
        rewardManager = _manager;
        emit RewardManagerSet(_manager);
    }

    /**
     * @dev Add authorized spender (NFT minter, game contracts, etc.)
     */
    function addAuthorizedSpender(address _spender) external onlyOwner {
        require(_spender != address(0), "Invalid spender");
        authorizedSpenders[_spender] = true;
        emit AuthorizedSpenderAdded(_spender);
    }

    /**
     * @dev Remove authorized spender
     */
    function removeAuthorizedSpender(address _spender) external onlyOwner {
        authorizedSpenders[_spender] = false;
        emit AuthorizedSpenderRemoved(_spender);
    }

    /**
     * @dev Check if address is authorized spender
     */
    function isAuthorizedSpender(address _spender) external view returns (bool) {
        return authorizedSpenders[_spender];
    }

    /**
     * @dev Get all reward point info for dashboard
     */
    function getTokenInfo() external view returns (
        string memory tokenName,
        string memory tokenSymbol,
        uint8 tokenDecimals,
        address manager,
        address tokenOwner
    ) {
        return (
            name(),
            symbol(),
            decimals(),
            rewardManager,
            owner()
        );
    }

    /**
     * @dev Mint reward points - only callable by RewardManager
     */
    function mint(address _to, uint256 _amount) external {
        require(msg.sender == rewardManager, "Only reward manager can mint");
        _mint(_to, _amount);
    }

    /**
     * @dev Burn reward points when used for purchases
     */
    function burnFrom(address _from, uint256 _amount) external {
        require(authorizedSpenders[msg.sender], "Not authorized spender");
        _burn(_from, _amount);
    }

    /**
     * @dev Override transfer to make non-transferable (soulbound)
     *      Only minting (from zero address) and burning (to zero address) allowed
     */
    function _update(address from, address to, uint256 amount) internal override {
        require(
            from == address(0) || to == address(0) || authorizedSpenders[to],
            "Reward points are non-transferable"
        );
        super._update(from, to, amount);
    }

    /**
     * @dev Required by UUPS - only owner can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
