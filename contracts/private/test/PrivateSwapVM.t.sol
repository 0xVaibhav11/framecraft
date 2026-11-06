// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {FramePayPrivateSwapVM} from "../src/FramePayPrivateSwapVM.sol";
import {Aqua} from "../src/OfficialAqua.sol";
import {PrivateTestToken} from "../src/PrivateTestToken.sol";
import {RailgunSettlementModel} from "framepay-test/FramePayPrivateSettlement.t.sol";

contract PrivateSwapVMTest {
    function testRealRouterFitsEIP170() public {
        Aqua aqua = new Aqua();
        PrivateTestToken token = new PrivateTestToken("Asset", "ASSET", address(this));
        RailgunSettlementModel pool = new RailgunSettlementModel();
        FramePayPrivateSwapVM router =
            new FramePayPrivateSwapVM(address(aqua), address(token), address(this), address(pool));
        require(address(router).code.length <= 24576, "EIP-170 limit");
        require(address(router.RAILGUN()) == address(pool), "pool binding");
    }
}
