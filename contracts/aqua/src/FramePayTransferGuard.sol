// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Per-transaction assertions signed into an EOA's transfer call.
/// @dev These are not persistent wallet permissions: the owner can sign different limits next time.
contract FramePayTransferGuard {
    using SafeERC20 for IERC20;
    error InvalidRecipient();
    error AmountAboveLimit();
    error Expired();
    error ReceivedBelowMinimum();
    error NativeTransferFailed();
    event GuardedTransfer(address indexed sender, address indexed recipient, address indexed token, uint256 amount);

    function _check(address recipient, uint256 amount, uint256 maximum, uint256 deadline) private view {
        if (recipient == address(0) || recipient == address(this) || recipient == msg.sender) revert InvalidRecipient();
        if (amount == 0 || amount > maximum) revert AmountAboveLimit();
        if (block.timestamp > deadline) revert Expired();
    }

    /// @notice Transfer tokens subject to an amount cap, deadline and minimum recipient balance increase.
    function transferToken(address token, address recipient, uint256 amount, uint256 maximum, uint256 minimumReceived, uint256 deadline) external {
        _check(recipient, amount, maximum, deadline);
        uint256 beforeBalance = IERC20(token).balanceOf(recipient);
        IERC20(token).safeTransferFrom(msg.sender, recipient, amount);
        uint256 afterBalance = IERC20(token).balanceOf(recipient);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance < minimumReceived) revert ReceivedBelowMinimum();
        emit GuardedTransfer(msg.sender, recipient, token, amount);
    }

    /// @notice Transfer native test ETH subject to an amount cap and deadline; sponsorship pays gas only.
    function transferNative(address payable recipient, uint256 maximum, uint256 deadline) external payable {
        _check(recipient, msg.value, maximum, deadline);
        (bool ok,) = recipient.call{value: msg.value}("");
        if (!ok) revert NativeTransferFailed();
        emit GuardedTransfer(msg.sender, recipient, address(0), msg.value);
    }
}
