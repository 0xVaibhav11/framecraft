// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Aqua} from "@1inch/aqua/contracts/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import {FramePayRecurringSwapVM} from "../src/FramePayRecurringSwapVM.sol";
import {DemoToken} from "../src/DemoToken.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

contract RecurringBuyTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant MAKER = address(0xA11CE);
    address constant TAKER = address(0xB0B);
    Aqua aqua;
    FramePayRecurringSwapVM router;
    DemoToken usd;
    DemoToken asset;
    ISwapVM.Order order;
    bytes32 orderHash;

    function setUp() public {
        vm.warp(1000);
        aqua = new Aqua();
        usd = new DemoToken("Test USD", "tUSD", 6, MAKER, 100e6);
        asset = new DemoToken("Test Asset", "tASSET", 18, TAKER, 100e18);
        router = new FramePayRecurringSwapVM(address(aqua), address(asset), address(this));
        order = router.buildOrder(MAKER, address(usd), policy());
        orderHash = router.hash(order);
        vm.prank(MAKER);
        usd.approve(address(aqua), 100e6);
        vm.prank(TAKER);
        asset.approve(address(router), 100e18);
        ship(order);
    }

    function policy() private view returns (FramePayRecurringSwapVM.Policy memory) {
        return FramePayRecurringSwapVM.Policy(address(asset), router.packSchedule(1000, 60, 2000),
            10e6, 25e6, 1e18, 10e6, bytes32(uint256(1)));
    }

    function ship(ISwapVM.Order memory target) private {
        address[] memory tokens = new address[](2);
        tokens[0] = address(asset);
        tokens[1] = address(usd);
        uint256[] memory amounts = new uint256[](2);
        amounts[1] = 25e6;
        vm.prank(MAKER);
        aqua.ship(address(router), abi.encode(target), tokens, amounts);
    }

    function data(uint256 maxInput) private view returns (bytes memory) {
        return router.buildTakerData(address(asset), address(usd), maxInput, 1999);
    }

    function fill(uint256 spend) private returns (uint256 bought) {
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        (bought,,) = router.swap(order, spend, takerData);
    }

    function testPartialFillsSettleThroughOfficialAqua() public {
        require(fill(6e6) == 0.6e18);
        require(fill(4e6) == 0.4e18);
        require(usd.balanceOf(MAKER) == 90e6 && usd.balanceOf(TAKER) == 10e6);
        require(asset.balanceOf(MAKER) == 1e18 && asset.balanceOf(TAKER) == 99e18);
        (uint256 received, uint256 remaining) = aqua.safeBalances(MAKER, address(router), orderHash, address(asset), address(usd));
        require(received == 1e18 && remaining == 15e6);
        (, uint256 spent, uint256 total) = router.usage(orderHash);
        require(spent == 10e6 && total == 10e6);
    }

    function testPeriodLimitCannotBeExceededBySecondFill() public {
        fill(6e6);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        vm.expectRevert();
        router.swap(order, 5e6, takerData);
        (, uint256 spent, uint256 total) = router.usage(orderHash);
        require(spent == 6e6 && total == 6e6);
    }

    function testPeriodResetsWithoutCarryover() public {
        fill(2e6);
        vm.warp(1180); // Three periods later: still only one period's capacity.
        fill(10e6);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        vm.expectRevert();
        router.swap(order, 1, takerData);
        (uint256 epoch, uint256 spent, uint256 total) = router.usage(orderHash);
        require(epoch == 3 && spent == 10e6 && total == 12e6);
    }

    function testTotalBudgetSurvivesPeriodResetsAndTopups() public {
        fill(10e6);
        vm.warp(1060);
        fill(10e6);
        vm.warp(1120);
        fill(5e6);
        vm.prank(MAKER);
        aqua.push(MAKER, address(router), orderHash, address(usd), 10e6);
        vm.warp(1180);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        vm.expectRevert();
        router.swap(order, 1, takerData);
    }

    function testStartAndExclusiveExpiryEnforced() public {
        bytes memory takerData = data(type(uint256).max);
        vm.warp(999);
        vm.prank(TAKER);
        vm.expectRevert(FramePayRecurringSwapVM.OutsideSchedule.selector);
        router.swap(order, 1e6, takerData);
        vm.warp(2000);
        vm.prank(TAKER);
        vm.expectRevert(FramePayRecurringSwapVM.OutsideSchedule.selector);
        router.swap(order, 1e6, takerData);
    }

    function testQuoteDoesNotConsumeCapacityAndSupportsStaticCall() public {
        (uint256 bought, uint256 spent, bytes32 hash) = ISwapVM(address(router)).quote(order, 4e6, data(1e18));
        require(bought == 0.4e18 && spent == 4e6 && hash == orderHash);
        (, uint256 used, uint256 total) = router.usage(orderHash);
        require(used == 0 && total == 0);
        fill(10e6);
    }

    function testTakerSlippageRevertsAndRollsBackCapacity() public {
        bytes memory takerData = data(0.3e18);
        vm.prank(TAKER);
        vm.expectRevert();
        router.swap(order, 4e6, takerData);
        (, uint256 spent, uint256 total) = router.usage(orderHash);
        require(spent == 0 && total == 0);
        require(asset.balanceOf(MAKER) == 0 && usd.balanceOf(TAKER) == 0);
    }

    function testSettlementFailureRollsBackCapacity() public {
        vm.prank(TAKER);
        asset.approve(address(router), 0);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        vm.expectRevert();
        router.swap(order, 4e6, takerData);
        (, uint256 spent, uint256 total) = router.usage(orderHash);
        require(spent == 0 && total == 0);
        require(asset.balanceOf(MAKER) == 0 && usd.balanceOf(TAKER) == 0);
    }

    function testDockCancelsFutureFills() public {
        fill(1e6);
        address[] memory tokens = new address[](2);
        tokens[0] = address(asset);
        tokens[1] = address(usd);
        vm.prank(MAKER);
        aqua.dock(address(router), orderHash, tokens);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        vm.expectRevert();
        router.swap(order, 1e6, takerData);
    }

    function testOutgoingFailureRollsBackIncomingAquaPush() public {
        vm.prank(MAKER);
        usd.approve(address(aqua), 0);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        vm.expectRevert();
        router.swap(order, 4e6, takerData);
        (, uint256 spent, uint256 total) = router.usage(orderHash);
        require(spent == 0 && total == 0);
        require(asset.balanceOf(MAKER) == 0 && asset.balanceOf(TAKER) == 100e18);
        (uint256 received, uint256 remaining) = aqua.safeBalances(MAKER, address(router), orderHash, address(asset), address(usd));
        require(received == 0 && remaining == 25e6);
    }

    function testDirectionAndExactInputAreRejected() public {
        bytes memory reverse = router.buildTakerData(address(usd), address(asset), 1e18, 1999);
        vm.prank(TAKER);
        vm.expectRevert(FramePayRecurringSwapVM.WrongDirection.selector);
        router.swap(order, 1e6, reverse);
        TakerTraitsLib.Args memory args;
        args.isAToB = address(asset) < address(usd);
        args.isExactIn = true;
        bytes memory exactIn = TakerTraitsLib.build(args);
        vm.prank(TAKER);
        vm.expectRevert(FramePayRecurringSwapVM.ExactOutputRequired.selector);
        router.swap(order, 1e18, exactIn);
    }

    function testProgramCannotAppendInstructionsToBypassAccounting() public {
        ISwapVM.Order memory modified = order;
        modified.data = bytes.concat(modified.data, hex"e000");
        ship(modified);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        vm.expectRevert(FramePayRecurringSwapVM.InvalidProgram.selector);
        router.swap(modified, 1e6, takerData);
    }

    function testInvalidPolicyRejectedAndSaltSeparatesPositions() public {
        FramePayRecurringSwapVM.Policy memory p = policy();
        p.buyUnits = 0;
        vm.expectRevert(FramePayRecurringSwapVM.InvalidPolicy.selector);
        router.buildOrder(MAKER, address(usd), p);
        p = policy();
        p.salt = bytes32(uint256(2));
        ISwapVM.Order memory other = router.buildOrder(MAKER, address(usd), p);
        require(router.hash(other) != orderHash);
        ship(other);
        fill(10e6);
        bytes memory takerData = data(type(uint256).max);
        vm.prank(TAKER);
        router.swap(other, 10e6, takerData);
    }

    function testFuzzRoundingNeverUnderpaysMaker(uint96 buy, uint96 spend, uint32 amount) public {
        FramePayRecurringSwapVM.Policy memory p = policy();
        p.buyUnits = uint128(buy) + 1;
        p.spendUnits = uint128(spend) + 1;
        ISwapVM.Order memory other = router.buildOrder(MAKER, address(usd), p);
        // This may be the original order only for its exact rate; fresh setUp has zero usage.
        if (router.hash(other) != orderHash) ship(other);
        uint256 output = uint256(amount) % 10e6 + 1;
        (uint256 input,,) = ISwapVM(address(router)).quote(other, output, data(type(uint256).max));
        require(input * p.spendUnits >= output * p.buyUnits);
        require((input - 1) * p.spendUnits < output * p.buyUnits);
    }
}
