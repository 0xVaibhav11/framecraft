// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ZKNOX_ethfalcon} from "@ethfalcon/ZKNOX_ethfalcon.sol";

/// @notice ETHFalcon is the sole spending authority; passkey PRF unlocks its key offchain.
/// @dev Experimental ETHFalcon-512 (Keccak variant), not an audited production wallet.
/// @dev Local prototype: immutable Falcon owner, no recovery or upgrade authority.
contract FramePayQuantumWallet {
    struct Call { address target; uint256 value; bytes data; }
    struct Auth { bytes falconSalt; uint256[] falconSignature; }
    bytes32 public immutable networkDomain;
    ZKNOX_ethfalcon public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    bytes32 public immutable falconKeyHash;
    uint256[] private falconKey;
    uint256 public nonce;
    bool private executing;
    bytes32 private constant DOMAIN = keccak256("FramePay.QuantumWallet.v1");
    error InvalidConfiguration();
    error InvalidAuthorization();
    error InvalidBatch();
    error Expired();
    error WrongNonce();
    error CallFailed(uint256 index, bytes reason);
    event Executed(uint256 indexed nonce, bytes32 indexed challenge, address indexed relayer);

    constructor(bytes32 network, address verifier_, uint256[] memory key) {
        if (network == 0) revert InvalidConfiguration();
        if (verifier_.code.length == 0 || key.length != 32) revert InvalidConfiguration();
        uint256 nonzero;
        for (uint256 i; i < 32; ++i) {
            for (uint256 j; j < 16; ++j) {
                uint256 coefficient = (key[i] >> (16 * j)) & 0xffff;
                if (coefficient >= 12289) revert InvalidConfiguration();
            }
            nonzero |= key[i];
        }
        if (nonzero == 0) revert InvalidConfiguration();
        verifier = ZKNOX_ethfalcon(verifier_); verifierCodeHash = verifier_.codehash;
        falconKey = key; falconKeyHash = keccak256(abi.encode(key));
        networkDomain = network;
    }
    receive() external payable {}

    function challenge(Call[] calldata calls, uint256 sequence, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), networkDomain, sequence, deadline, keccak256(abi.encode(calls))));
    }
    function verify(Call[] calldata calls, uint256 sequence, uint256 deadline, Auth calldata auth) public view returns (bool) {
        if (sequence != nonce || block.timestamp > deadline || calls.length == 0 || calls.length > 32) return false;
        bytes32 digest = challenge(calls, sequence, deadline);
        if (auth.falconSalt.length != 40 || auth.falconSignature.length != 32 || address(verifier).codehash != verifierCodeHash) return false;
        try verifier.verify(abi.encodePacked(digest), auth.falconSalt, auth.falconSignature, falconKey) returns (bool valid) { return valid; }
        catch { return false; }
    }
    function execute(Call[] calldata calls, uint256 sequence, uint256 deadline, Auth calldata auth) external {
        if (executing || calls.length == 0 || calls.length > 32) revert InvalidBatch();
        if (sequence != nonce) revert WrongNonce();
        if (block.timestamp > deadline) revert Expired();
        if (!verify(calls, sequence, deadline, auth)) revert InvalidAuthorization();
        bytes32 digest = challenge(calls, sequence, deadline);
        executing = true;
        nonce = sequence + 1;
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].target == address(0) || calls[i].target == address(this)) revert InvalidBatch();
            (bool ok, bytes memory reason) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, reason);
        }
        executing = false;
        emit Executed(sequence, digest, msg.sender);
    }
}

contract FramePayQuantumFactory {
    address public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    event WalletCreated(address indexed wallet, bytes32 indexed credentialSalt, bytes32 indexed falconKeyHash);
    constructor(address verifier_) {
        require(verifier_.code.length != 0, "Missing verifier");
        verifier = verifier_; verifierCodeHash = verifier_.codehash;
    }
    function predict(bytes32 network, bytes32 salt, uint256[] memory key) public view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(FramePayQuantumWallet).creationCode, abi.encode(network, verifier, key)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }
    function createWallet(bytes32 network, bytes32 salt, uint256[] memory key) external returns (address wallet) {
        require(verifier.codehash == verifierCodeHash, "Verifier changed");
        wallet = predict(network, salt, key);
        if (wallet.code.length == 0) {
            wallet = address(new FramePayQuantumWallet{salt: salt}(network, verifier, key));
            emit WalletCreated(wallet, salt, keccak256(abi.encode(key)));
        }
    }
}
