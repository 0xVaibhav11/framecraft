// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {PrivateDemoFaucet} from "../src/PrivateDemoFaucet.sol";
import {PrivateTestToken} from "../src/PrivateTestToken.sol";

interface FaucetVm { function warp(uint256) external; }
contract FaucetRecipient {}
contract PrivateDemoFaucetTest {
    FaucetVm constant vm = FaucetVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testGrantGoesToWalletAndCooldownIsPerRecipient() public {
        PrivateTestToken a = new PrivateTestToken("A", "A", address(this));
        PrivateTestToken b = new PrivateTestToken("B", "B", address(this));
        PrivateDemoFaucet faucet = new PrivateDemoFaucet(a, b);
        a.transfer(address(faucet), 3000 ether);
        b.transfer(address(faucet), 3000 ether);
        address wallet = address(new FaucetRecipient());
        faucet.claim(wallet);
        require(a.balanceOf(wallet) == 1000 ether && b.balanceOf(wallet) == 1000 ether, "grant destination");
        (bool repeated,) = address(faucet).call(abi.encodeCall(faucet.claim, (wallet)));
        require(!repeated, "cooldown");
        faucet.claim(address(new FaucetRecipient()));
        vm.warp(block.timestamp + 1 days);
        faucet.claim(wallet);
        require(a.balanceOf(wallet) == 2000 ether && b.balanceOf(wallet) == 2000 ether, "next day grant");
    }

    function testInsufficientBudgetRollsBackBothTransfersAndCooldown() public {
        PrivateTestToken a = new PrivateTestToken("A", "A", address(this));
        PrivateTestToken b = new PrivateTestToken("B", "B", address(this));
        PrivateDemoFaucet faucet = new PrivateDemoFaucet(a, b);
        a.transfer(address(faucet), 1000 ether);
        address wallet = address(new FaucetRecipient());
        (bool ok,) = address(faucet).call(abi.encodeCall(faucet.claim, (wallet)));
        require(!ok && a.balanceOf(wallet) == 0 && faucet.nextClaimAt(wallet) == 0, "atomic grant");
        (bool eoa,) = address(faucet).call(abi.encodeCall(faucet.claim, (address(0xbeef))));
        require(!eoa, "smart wallet required");
    }
}
