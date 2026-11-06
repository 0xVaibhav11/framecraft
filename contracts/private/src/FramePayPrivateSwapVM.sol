// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/f9f4acfed0ffa321c2108efe05ecf7a5e0bd8abc/LICENSES/SwapVM-1.1.txt
import {SwapVM} from "swap-vm/contracts/SwapVM.sol";
import {Context} from "swap-vm/contracts/libs/VM.sol";
import {Opcode} from "swap-vm/contracts/libs/OpcodeList.sol";
import {StaticBalances} from "swap-vm/contracts/instructions/Balances.sol";
import {XYCSwap} from "swap-vm/contracts/instructions/XYCSwap.sol";
import {FramePayPrivateSettlement} from "framepay/FramePayPrivateSettlement.sol";

/// @notice Real SwapVM with a private settlement entry point that bypasses Aqua.
contract FramePayPrivateSwapVM is SwapVM, FramePayPrivateSettlement {
    error UnsupportedOpcode();

    constructor(address aqua, address weth, address owner, address railgun)
        SwapVM(aqua, weth, owner, "FramePay PrivateSwapVM", "1")
        FramePayPrivateSettlement(railgun)
    {}

    // The restricted public instruction set keeps runtime code below EIP-170.
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal pure override {
        if (opcode == uint256(Opcode.StaticBalances)) StaticBalances.exec(ctx, args);
        else if (opcode == uint256(Opcode.XYCSwap)) XYCSwap.exec(ctx, args);
        else revert UnsupportedOpcode();
    }
}
