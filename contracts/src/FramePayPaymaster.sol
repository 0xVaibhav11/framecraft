// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Open sponsorship for disposable chain-1337 test funds, with an immutable per-transaction cost ceiling.
/// Anyone can consume the funded budget. This is not a production authorizer or a token-fee paymaster.
contract FramePayPaymaster {
    uint256 public immutable maxTransactionCost;
    address public immutable approveHelper;
    address public immutable txParamHelper;

    error WrongChain();
    error InvalidBudget();
    error HelperDeploymentFailed();
    error InvalidFrameContext();
    error InvalidIntrospection();
    error SponsorshipLimitExceeded();

    constructor(uint256 maximumCost) payable {
        if (block.chainid != 1337) revert WrongChain();
        if (maximumCost == 0 || maximumCost > 0.001 ether || msg.value > 0.01 ether) revert InvalidBudget();
        maxTransactionCost = maximumCost;
        // Unmodified MIT-licensed creation bytes from @forshtat/hegota-support@0.0.1
        // contracts/generated/HelperCode.sol, ERC8421_WORKSHOP. Build script checks their provenance.
        // APPROVE must run by delegatecall so the payer remains this contract.
        approveHelper = _deploy(hex"6007600d60003960076000f3fe600035600080aa");
        txParamHelper = _deploy(hex"600c600d600039600c6000f3fe600035b060005260206000f3");
    }

    function _deploy(bytes memory code) private returns (address helper) {
        assembly ("memory-safe") { helper := create(0, add(code, 32), mload(code)) }
        if (helper == address(0)) revert HelperDeploymentFailed();
    }

    fallback() external payable {
        // VERIFY frames use the profile's native entry-point caller.
        if (msg.sender != address(0xaa) || msg.value != 0) revert InvalidFrameContext();
        // TXPARAM 0x06 is the ethrex profile's MAX_COST extension, not a portable EIP guarantee.
        (bool readOk, bytes memory result) = txParamHelper.staticcall(abi.encode(uint256(6)));
        if (!readOk || result.length != 32) revert InvalidIntrospection();
        uint256 maximumCost = abi.decode(result, (uint256));
        if (maximumCost == 0 || maximumCost > maxTransactionCost) revert SponsorshipLimitExceeded();
        (bool approved, bytes memory reason) = approveHelper.delegatecall(abi.encode(uint256(1))); // PAYMENT
        if (!approved) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
    }
}
