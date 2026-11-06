// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FramePayPrivateSwapVM} from "../src/FramePayPrivateSwapVM.sol";
import {PrivateTestToken} from "../src/PrivateTestToken.sol";
import {Aqua} from "../src/OfficialAqua.sol";
import {IRailgun} from "framepay/IRailgun.sol";

interface RealVm {
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function ffi(string[] calldata) external returns (bytes memory);
    function projectRoot() external view returns (string memory);
    function toString(address) external pure returns (string memory);
    function warp(uint256) external;
    function envOr(string calldata, bool) external returns (bool);
    function skip(bool) external;
}

/// Original RAILGUN creation artifacts and genuine Groth16 proofs; no verifier mock or state overrides.
contract RealRailgunTest {
    RealVm constant vm = RealVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function input(string memory hash) internal view returns (bytes memory) {
        return vm.parseJsonBytes(
            vm.readFile(string.concat(vm.projectRoot(), "/../../config/private/railgun/", hash, ".json")), ".input"
        );
    }

    function create(bytes memory code) internal returns (address deployed) {
        assembly ("memory-safe") { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "artifact deployment failed");
    }

    function relocate(bytes memory code, bytes20 oldAddress, bytes20 newAddress) internal pure {
        uint256 count;
        for (uint256 i; i + 20 <= code.length; ++i) {
            bytes20 at;
            assembly ("memory-safe") { at := mload(add(add(code, 32), i)) }
            if (at == oldAddress) {
                for (uint256 j; j < 20; ++j) {
                    code[i + j] = newAddress[j];
                }
                count++;
            }
        }
        require(count == 1, "one Poseidon reference expected");
    }

    function callOK(address target, bytes memory data) internal {
        (bool ok, bytes memory reason) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
    }

    function rootOf(address pool) internal view returns (bytes32) {
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("merkleRoot()"));
        require(ok, "root read");
        return abi.decode(data, (bytes32));
    }

    function testRealProofTransferAndAtomicSwap() public {
        vm.skip(!vm.envOr("FRAMEPAY_REAL_PROOFS", false));
        vm.warp(100);
        bytes memory proxyCode = input("0x13954e0d1af4c619efbd502299e78e116d1309b2b85c15ac6fe09838bb8622aa");
        address owner = address(this);
        assembly ("memory-safe") { mstore(add(proxyCode, mload(proxyCode)), owner) }
        address pool = create(proxyCode);
        address t3 = create(input("0x22f522952985c00705187839388aa76c80a7684f186f29a47c05bba3a17765e6"));
        address t4 = create(input("0x1e7e34c103de436502520ee4d38b9ad1879645c8baf0547ab092bb034cfef679"));
        bytes memory implementation = input("0x12e5f2bb0d2d3bf66ba4ad115da3605a5e46103c4ad208baf3662b039f661d97");
        relocate(implementation, bytes20(0xF5fE83643dd42d408c19B938866fA441C6c52563), bytes20(t3));
        relocate(implementation, bytes20(0xafd3fC0396f793B35e433BBE0E1160329BF0ABD3), bytes20(t4));
        callOK(pool, abi.encodeWithSignature("upgrade(address)", create(implementation)));
        callOK(pool, abi.encodeWithSignature("unpause()"));
        callOK(
            pool,
            abi.encodeWithSignature(
                "initializeRailgunLogic(address,uint120,uint120,uint256,address)", owner, 25, 25, 25, owner
            )
        );
        string memory fixture = string.concat(vm.projectRoot(), "/../../packages/privacy/scripts/proof-fixture.ts");
        string[] memory keyCommand = new string[](3);
        keyCommand[0] = "node";
        keyCommand[1] = fixture;
        keyCommand[2] = "verification-key";
        callOK(pool, vm.ffi(keyCommand));
        PrivateTestToken a = new PrivateTestToken("A", "A", owner);
        PrivateTestToken b = new PrivateTestToken("B", "B", owner);
        FramePayPrivateSwapVM router = new FramePayPrivateSwapVM(address(new Aqua()), address(a), owner, pool);
        a.approve(pool, type(uint256).max);
        b.approve(pool, type(uint256).max);
        string[] memory command = new string[](6);
        command[0] = "node";
        command[1] = fixture;
        command[2] = vm.toString(address(a));
        command[3] = vm.toString(address(b));
        command[4] = vm.toString(address(router));
        command[5] = vm.toString(pool);
        (bytes memory shield, bytes memory transfer, bytes memory swap, bytes32 initialRoot, bytes32 transferRoot) =
            abi.decode(vm.ffi(command), (bytes, bytes, bytes, bytes32, bytes32));
        callOK(pool, shield);
        require(rootOf(pool) == initialRoot, "offchain shield tree matches real pool");
        uint256 backingA = a.balanceOf(pool);
        uint256 backingB = b.balanceOf(pool);
        require(backingA == 9975 ether && backingB == 9975 ether, "real shield fee");
        callOK(pool, transfer);
        require(rootOf(pool) == transferRoot, "offchain transact tree matches real pool");
        (bool replay,) = pool.call(transfer);
        require(!replay, "transfer replay rejected");
        bytes memory swapArguments = new bytes(swap.length - 4);
        for (uint256 i; i < swapArguments.length; ++i) {
            swapArguments[i] = swap[i + 4];
        }
        (IRailgun.Transaction[] memory legs, bytes32 tradeId, uint64 deadline, bytes32 payment0, bytes32 payment1) =
            abi.decode(swapArguments, (IRailgun.Transaction[], bytes32, uint64, bytes32, bytes32));
        IRailgun.Transaction[] memory isolated = new IRailgun.Transaction[](1);
        isolated[0] = legs[0];
        (bool isolatedOK,) = pool.call(abi.encodeCall(IRailgun.transact, (isolated)));
        require(!isolatedOK, "adapter-bound leg cannot execute alone");
        // Corrupt the actual second Groth16 proof. A later valid swap proves rollback.
        legs[1].proof.a.x += 1;
        bytes memory badSwap =
            abi.encodeWithSelector(router.privateSwap.selector, legs, tradeId, deadline, payment0, payment1);
        (bool invalid,) = address(router).call(badSwap);
        require(!invalid, "corrupt swap rejected");
        callOK(address(router), swap);
        (replay,) = address(router).call(swap);
        require(!replay, "swap replay rejected");
        require(a.balanceOf(pool) == backingA && b.balanceOf(pool) == backingB, "no public token movement");
    }
}
