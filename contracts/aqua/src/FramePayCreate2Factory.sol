// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Deploy large contracts inside a frame with an explicit state-gas budget.
contract FramePayCreate2Factory {
    error DeploymentFailed();
    event Deployed(address indexed account, address indexed deployer, bytes32 salt);

    /// @notice Deploy initcode under a caller-scoped salt; constructor arguments are part of initcode.
    function deploy(bytes memory initcode, bytes32 salt) external returns (address account) {
        bytes32 scopedSalt = keccak256(abi.encode(msg.sender, salt));
        assembly ("memory-safe") { account := create2(0, add(initcode, 32), mload(initcode), scopedSalt) }
        if (account == address(0)) revert DeploymentFailed();
        emit Deployed(account, msg.sender, salt);
    }
}
