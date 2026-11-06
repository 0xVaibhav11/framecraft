// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {AppTestToken} from "../src/AppTestToken.sol";
import {FramePayTransferGuard} from "../src/FramePayTransferGuard.sol";

interface GuardVm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
}
contract TransferGuardTest {
    GuardVm constant vm = GuardVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    AppTestToken token;
    FramePayTransferGuard guard;
    address constant recipient = address(0xB0B);
    function setUp() public {
        vm.warp(1000);
        token = new AppTestToken("Test USD", "USD", 6, 1000e6);
        guard = new FramePayTransferGuard();
        token.claim();
        token.approve(address(guard), 1000e6);
    }
    function testFaucetIsOneClaimPerAccount() public {
        vm.expectRevert(AppTestToken.AlreadyClaimed.selector);
        token.claim();
        vm.prank(recipient);
        token.claim();
        require(token.balanceOf(recipient) == 1000e6);
    }
    function testGuardedTokenTransfer() public {
        guard.transferToken(address(token), recipient, 10e6, 20e6, 10e6, 1100);
        require(token.balanceOf(recipient) == 10e6 && token.balanceOf(address(this)) == 990e6);
    }
    function testMaximumAndDeadlineRejectTransfers() public {
        vm.expectRevert(FramePayTransferGuard.AmountAboveLimit.selector);
        guard.transferToken(address(token), recipient, 10e6, 9e6, 10e6, 1100);
        vm.expectRevert(FramePayTransferGuard.Expired.selector);
        guard.transferToken(address(token), recipient, 10e6, 20e6, 10e6, 999);
        require(token.balanceOf(recipient) == 0);
    }
    function testPostTransferAssertionRollsBackTokenMovement() public {
        vm.expectRevert(FramePayTransferGuard.ReceivedBelowMinimum.selector);
        guard.transferToken(address(token), recipient, 10e6, 20e6, 11e6, 1100);
        require(token.balanceOf(recipient) == 0 && token.balanceOf(address(this)) == 1000e6);
    }
    function testNativeTransferAndCap() public {
        vm.deal(address(this), 1 ether);
        guard.transferNative{value: 0.01 ether}(payable(recipient), 0.02 ether, 1100);
        require(recipient.balance == 0.01 ether);
        vm.expectRevert(FramePayTransferGuard.AmountAboveLimit.selector);
        guard.transferNative{value: 0.03 ether}(payable(recipient), 0.02 ether, 1100);
    }
    function testSelfRecipientRejected() public {
        vm.expectRevert(FramePayTransferGuard.InvalidRecipient.selector);
        guard.transferToken(address(token), address(this), 10e6, 20e6, 10e6, 1100);
    }
}
