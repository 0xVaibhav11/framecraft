// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @notice Passkey-owned wallet. Relayers carry signed batches; they have no spending authority.
/// @dev Local prototype: immutable single credential, no recovery or upgrade authority.
contract FramePayPasskeyWallet {
    struct Call { address target; uint256 value; bytes data; }
    struct Auth { WebAuthn.WebAuthnAuth assertion; uint256 originIndex; uint256 originLength; uint256 crossOriginIndex; }
    bytes32 public immutable qx;
    bytes32 public immutable qy;
    bytes32 public immutable rpIdHash;
    bytes32 public immutable originHash;
    bytes32 public immutable networkDomain;
    uint256 public nonce;
    bool private executing;
    bytes32 private constant DOMAIN = keccak256("FramePay.PasskeyWallet.v1");
    error InvalidConfiguration();
    error InvalidAuthorization();
    error InvalidBatch();
    error Expired();
    error WrongNonce();
    error CallFailed(uint256 index, bytes reason);
    event Executed(uint256 indexed nonce, bytes32 indexed challenge, address indexed relayer);

    constructor(bytes32 x, bytes32 y, bytes32 rp, bytes32 origin, bytes32 network) {
        if (!P256.isValidPublicKey(x, y) || rp == 0 || origin == 0 || network == 0) revert InvalidConfiguration();
        qx = x; qy = y; rpIdHash = rp; originHash = origin; networkDomain = network;
    }
    receive() external payable {}

    function challenge(Call[] calldata calls, uint256 sequence, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), networkDomain, sequence, deadline, keccak256(abi.encode(calls))));
    }
    function verify(Call[] calldata calls, uint256 sequence, uint256 deadline, Auth calldata auth) public view returns (bool) {
        if (sequence != nonce || block.timestamp > deadline || calls.length == 0 || calls.length > 32) return false;
        bytes calldata ad = auth.assertion.authenticatorData;
        bytes calldata cd = bytes(auth.assertion.clientDataJSON);
        if (ad.length < 37 || ad.length > 1024 || cd.length > 2048 || bytes32(ad[:32]) != rpIdHash) return false;
        // Check origin and cross-origin status in the exact browser-signed bytes (never reserialize JSON).
        if (!_matches(cd, auth.originIndex, bytes('"origin":"')) || auth.originLength == 0 || auth.originLength > 255) return false;
        uint256 start = auth.originIndex + 10;
        if (start + auth.originLength >= cd.length || cd[start + auth.originLength] != '"') return false;
        if (keccak256(cd[start:start + auth.originLength]) != originHash) return false;
        if (!_matches(cd, auth.crossOriginIndex, bytes('"crossOrigin":false'))) return false;
        return WebAuthn.verify(abi.encodePacked(challenge(calls, sequence, deadline)), auth.assertion, qx, qy, true);
    }
    function _matches(bytes calldata data, uint256 offset, bytes memory expected) private pure returns (bool) {
        if (offset > data.length || expected.length > data.length - offset) return false;
        return keccak256(data[offset:offset + expected.length]) == keccak256(expected);
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

contract FramePayPasskeyFactory {
    event WalletCreated(address indexed wallet, bytes32 indexed credentialSalt);
    function predict(bytes32 x, bytes32 y, bytes32 rp, bytes32 origin, bytes32 network, bytes32 salt) public view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(FramePayPasskeyWallet).creationCode, abi.encode(x, y, rp, origin, network)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }
    function createWallet(bytes32 x, bytes32 y, bytes32 rp, bytes32 origin, bytes32 network, bytes32 salt) external returns (address wallet) {
        wallet = predict(x, y, rp, origin, network, salt);
        if (wallet.code.length == 0) {
            wallet = address(new FramePayPasskeyWallet{salt: salt}(x, y, rp, origin, network));
            emit WalletCreated(wallet, salt);
        }
    }
}
