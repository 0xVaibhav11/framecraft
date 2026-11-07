// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Permissionless, finite test-token faucet. Anyone can request a grant for a smart wallet.
contract PrivateDemoFaucet {
    using SafeERC20 for IERC20;
    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;
    uint256 public constant GRANT = 1_000 ether;
    uint256 public constant COOLDOWN = 1 days;
    mapping(address => uint256) public nextClaimAt;

    event Claimed(address indexed wallet, uint256 amountA, uint256 amountB);
    error WalletRequired();
    error CooldownActive(uint256 nextClaim);

    constructor(IERC20 a, IERC20 b) {
        require(address(a) != address(0) && address(b) != address(0) && a != b);
        tokenA = a;
        tokenB = b;
    }

    function claim(address wallet) external {
        if (wallet.code.length == 0) revert WalletRequired();
        if (block.timestamp < nextClaimAt[wallet]) revert CooldownActive(nextClaimAt[wallet]);
        nextClaimAt[wallet] = block.timestamp + COOLDOWN;
        tokenA.safeTransfer(wallet, GRANT);
        tokenB.safeTransfer(wallet, GRANT);
        emit Claimed(wallet, GRANT, GRANT);
    }
}
