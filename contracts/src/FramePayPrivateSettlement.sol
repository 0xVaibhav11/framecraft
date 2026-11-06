// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity ^0.8.30;

import {IRailgun} from "./IRailgun.sol";

/// @notice Atomic, proof-bound settlement of two private RAILGUN payments.
/// @dev Pricing is agreed offchain. This does not enforce a persistent AMM invariant.
abstract contract FramePayPrivateSettlement {
    IRailgun public immutable RAILGUN;
    bytes32 public constant SWAP_DOMAIN = keccak256("FramePay.PrivateSwap.v1");

    error WrongLegCount();
    error UnshieldForbidden();
    error WrongAdapter();
    error WrongConditions();
    error MissingCounterpayment();
    error Expired();
    error InvalidRailgun();

    constructor(address railgun) {
        if (railgun == address(0) || railgun.code.length == 0) revert InvalidRailgun();
        RAILGUN = IRailgun(railgun);
    }

    function conditions(bytes32 tradeId, uint64 deadline, bytes32 payment0, bytes32 payment1)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                SWAP_DOMAIN, block.chainid, address(this), address(RAILGUN), tradeId, deadline, payment0, payment1
            )
        );
    }

    function privateSwap(
        IRailgun.Transaction[] calldata legs,
        bytes32 tradeId,
        uint64 deadline,
        bytes32 payment0,
        bytes32 payment1
    ) external {
        if (legs.length != 2) revert WrongLegCount();
        if (block.timestamp > deadline) revert Expired();
        bytes32 expected = conditions(tradeId, deadline, payment0, payment1);
        for (uint256 i; i < 2; ++i) {
            if (legs[i].boundParams.unshield != 0) revert UnshieldForbidden();
            if (legs[i].boundParams.adaptContract != address(this)) revert WrongAdapter();
            if (legs[i].boundParams.adaptParams != expected) revert WrongConditions();
        }
        if (
            payment0 == payment1 || !_contains(legs[0].commitments, payment0)
                || !_contains(legs[1].commitments, payment1)
        ) revert MissingCounterpayment();
        // Pool verifies BOTH proofs and spends BOTH sets of notes in one call.
        // No catching failures, external DEX calls, token movement, or plaintext swap event.
        RAILGUN.transact(legs);
    }

    function _contains(bytes32[] calldata items, bytes32 required) private pure returns (bool) {
        for (uint256 i; i < items.length; ++i) {
            if (items[i] == required) return true;
        }
        return false;
    }
}
