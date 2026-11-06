// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IRailgun} from "../src/IRailgun.sol";
import {FramePayPrivateSettlement} from "../src/FramePayPrivateSettlement.sol";

interface PrivateVm {
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes4) external;
}

contract SettlementHarness is FramePayPrivateSettlement {
    constructor(address pool) FramePayPrivateSettlement(pool) {}
}

/// Unit-test model only. Real cryptographic verification is covered by private:demo.
contract RailgunSettlementModel is IRailgun {
    mapping(bytes32 => bool) public spent;
    uint256 public calls;
    error InvalidProof();
    error AlreadySpent();

    function transact(Transaction[] calldata legs) external {
        calls++;
        for (uint256 i; i < legs.length; ++i) {
            require(legs[i].boundParams.adaptContract == msg.sender, "adapter");
            if (legs[i].proof.a.x != 1) revert InvalidProof();
            bytes32 nullifier = legs[i].nullifiers[0];
            if (spent[nullifier]) revert AlreadySpent();
            spent[nullifier] = true;
        }
    }
}

contract FramePayPrivateSettlementTest {
    PrivateVm constant vm = PrivateVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    RailgunSettlementModel pool;
    SettlementHarness settlement;
    bytes32 constant TRADE = bytes32(uint256(123));
    bytes32 constant PAYMENT0 = bytes32(uint256(456));
    bytes32 constant PAYMENT1 = bytes32(uint256(789));
    uint64 constant DEADLINE = 1000;

    function setUp() public {
        vm.warp(100);
        vm.chainId(1337);
        pool = new RailgunSettlementModel();
        settlement = new SettlementHarness(address(pool));
    }

    function legs() internal view returns (IRailgun.Transaction[] memory result) {
        result = new IRailgun.Transaction[](2);
        bytes32 params = settlement.conditions(TRADE, DEADLINE, PAYMENT0, PAYMENT1);
        for (uint256 i; i < 2; ++i) {
            result[i].proof.a.x = 1;
            result[i].boundParams.adaptContract = address(settlement);
            result[i].boundParams.adaptParams = params;
            result[i].nullifiers = new bytes32[](1);
            result[i].nullifiers[0] = bytes32(i + 1);
            result[i].commitments = new bytes32[](2);
            result[i].commitments[1] = i == 0 ? PAYMENT0 : PAYMENT1;
        }
    }

    function settle(IRailgun.Transaction[] memory payments) internal {
        settlement.privateSwap(payments, TRADE, DEADLINE, PAYMENT0, PAYMENT1);
    }

    function testBothLegsSettleInOnePoolCall() public {
        settle(legs());
        require(
            pool.calls() == 1 && pool.spent(bytes32(uint256(1))) && pool.spent(bytes32(uint256(2))), "atomic payment"
        );
    }

    function testInvalidSecondProofRollsBackFirstSpend() public {
        IRailgun.Transaction[] memory payments = legs();
        payments[1].proof.a.x = 0;
        vm.expectRevert(RailgunSettlementModel.InvalidProof.selector);
        settle(payments);
        require(
            pool.calls() == 0 && !pool.spent(bytes32(uint256(1))) && !pool.spent(bytes32(uint256(2))), "rolled back"
        );
        payments[1].proof.a.x = 1;
        settle(payments);
    }

    function testReplayReverts() public {
        settle(legs());
        IRailgun.Transaction[] memory payments = legs();
        vm.expectRevert(RailgunSettlementModel.AlreadySpent.selector);
        settle(payments);
    }

    function testMissingAndExtraLegsRevert() public {
        vm.expectRevert(FramePayPrivateSettlement.WrongLegCount.selector);
        settle(new IRailgun.Transaction[](1));
        vm.expectRevert(FramePayPrivateSettlement.WrongLegCount.selector);
        settle(new IRailgun.Transaction[](3));
    }

    function testUnshieldForbiddenOnEitherLeg() public {
        for (uint256 i; i < 2; ++i) {
            IRailgun.Transaction[] memory payments = legs();
            payments[i].boundParams.unshield = 1;
            vm.expectRevert(FramePayPrivateSettlement.UnshieldForbidden.selector);
            settle(payments);
        }
    }

    function testWrongAdapterOnEitherLeg() public {
        for (uint256 i; i < 2; ++i) {
            IRailgun.Transaction[] memory payments = legs();
            payments[i].boundParams.adaptContract = address(0);
            vm.expectRevert(FramePayPrivateSettlement.WrongAdapter.selector);
            settle(payments);
        }
    }

    function testWrongConditionsOnEitherLeg() public {
        for (uint256 i; i < 2; ++i) {
            IRailgun.Transaction[] memory payments = legs();
            payments[i].boundParams.adaptParams = bytes32(0);
            vm.expectRevert(FramePayPrivateSettlement.WrongConditions.selector);
            settle(payments);
        }
    }

    function testMissingCounterpayment() public {
        IRailgun.Transaction[] memory payments = legs();
        payments[1].commitments[1] = bytes32(0);
        vm.expectRevert(FramePayPrivateSettlement.MissingCounterpayment.selector);
        settle(payments);
    }

    function testIdenticalPaymentsRejected() public {
        IRailgun.Transaction[] memory payments = legs();
        bytes32 params = settlement.conditions(TRADE, DEADLINE, PAYMENT0, PAYMENT0);
        for (uint256 i; i < 2; ++i) {
            payments[i].boundParams.adaptParams = params;
            payments[i].commitments[1] = PAYMENT0;
        }
        vm.expectRevert(FramePayPrivateSettlement.MissingCounterpayment.selector);
        settlement.privateSwap(payments, TRADE, DEADLINE, PAYMENT0, PAYMENT0);
    }

    function testDeadlineInclusiveAndExpiredRejected() public {
        vm.warp(DEADLINE);
        settle(legs());
        vm.warp(DEADLINE + 1);
        IRailgun.Transaction[] memory payments = legs();
        vm.expectRevert(FramePayPrivateSettlement.Expired.selector);
        settle(payments);
    }

    function testDomainBindsChainAdapterAndPool() public {
        bytes32 expected = settlement.conditions(TRADE, DEADLINE, PAYMENT0, PAYMENT1);
        require(
            expected
                == keccak256(
                    abi.encode(
                        keccak256("FramePay.PrivateSwap.v1"),
                        uint256(1337),
                        address(settlement),
                        address(pool),
                        TRADE,
                        DEADLINE,
                        PAYMENT0,
                        PAYMENT1
                    )
                ),
            "ABI domain"
        );
        vm.chainId(1338);
        require(expected != settlement.conditions(TRADE, DEADLINE, PAYMENT0, PAYMENT1), "chain binding");
        vm.chainId(1337);
        SettlementHarness other = new SettlementHarness(address(pool));
        require(expected != other.conditions(TRADE, DEADLINE, PAYMENT0, PAYMENT1), "adapter binding");
    }

    function testFuzzQuoteFieldsAreBound(bytes32 trade, uint64 deadline, bytes32 payment) public view {
        bytes32 expected = settlement.conditions(TRADE, DEADLINE, PAYMENT0, PAYMENT1);
        if (trade != TRADE) {
            require(expected != settlement.conditions(trade, DEADLINE, PAYMENT0, PAYMENT1), "trade binding");
        }
        if (deadline != DEADLINE) {
            require(expected != settlement.conditions(TRADE, deadline, PAYMENT0, PAYMENT1), "deadline binding");
        }
        if (payment != PAYMENT1) {
            require(expected != settlement.conditions(TRADE, DEADLINE, PAYMENT0, payment), "payment binding");
        }
    }

    function testPoolMustHaveCode() public {
        vm.expectRevert(FramePayPrivateSettlement.InvalidRailgun.selector);
        new SettlementHarness(address(0));
        vm.expectRevert(FramePayPrivateSettlement.InvalidRailgun.selector);
        new SettlementHarness(address(123));
    }
}
