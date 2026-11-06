// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {FramePayPaymaster} from "../src/FramePayPaymaster.sol";

interface Vm {
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function chainId(uint256) external;
}

// Ordinary test EVMs do not implement frame opcodes: replace helpers to exercise policy boundaries.
contract FramePayPaymasterTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    FramePayPaymaster pm;
    function setUp() public {
        vm.chainId(1337);
        vm.deal(address(this), 1 ether);
        pm = new FramePayPaymaster{value: 0.01 ether}(0.001 ether);
        vm.etch(pm.approveHelper(), address(new MockApproval()).code);
    }
    function mockCost(uint256 cost) private { vm.etch(pm.txParamHelper(), address(new MockCost(cost)).code); }
    function testWithinBudgetApprovesPayment() public {
        mockCost(0.0001 ether);
        vm.prank(address(0xaa));
        (bool ok,) = address(pm).call("");
        require(ok, "must approve payment only");
    }
    function testExcessCostReverts() public {
        mockCost(0.001 ether + 1);
        vm.prank(address(0xaa));
        (bool ok,) = address(pm).call(""); require(!ok, "over budget");
    }
    function testZeroCostReverts() public {
        mockCost(0);
        vm.prank(address(0xaa));
        (bool ok,) = address(pm).call(""); require(!ok, "zero cost");
    }
    function testUnrecognizedContextReverts() public {
        mockCost(1);
        (bool ok,) = address(pm).call(""); require(!ok, "ordinary call");
    }
    function testMissingIntrospectionReverts() public {
        vm.etch(pm.txParamHelper(), hex"00");
        vm.prank(address(0xaa));
        (bool ok,) = address(pm).call(""); require(!ok, "missing max cost");
    }
    function testApprovalFailureReverts() public {
        mockCost(1); vm.etch(pm.approveHelper(), hex"60006000fd");
        vm.prank(address(0xaa));
        (bool ok,) = address(pm).call(""); require(!ok, "approval failure");
    }
    function testConstructorBounds() public {
        vm.expectRevert(FramePayPaymaster.InvalidBudget.selector);
        new FramePayPaymaster(0);
        vm.expectRevert(FramePayPaymaster.InvalidBudget.selector);
        new FramePayPaymaster{value: 0.01 ether + 1}(1);
        vm.expectRevert(FramePayPaymaster.InvalidBudget.selector);
        new FramePayPaymaster(0.001 ether + 1);
        vm.chainId(1);
        vm.expectRevert(FramePayPaymaster.WrongChain.selector);
        new FramePayPaymaster(1);
    }
}
contract MockCost {
    uint256 immutable cost;
    constructor(uint256 value) { cost = value; }
    fallback() external { require(abi.decode(msg.data, (uint256)) == 6); bytes memory value = abi.encode(cost); assembly { return(add(value, 32), 32) } }
}
contract MockApproval {
    fallback() external { require(abi.decode(msg.data, (uint256)) == 1, "payment scope only"); }
}
