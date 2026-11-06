// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply test token for the local demo. No external mint authority.
contract DemoToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name, string memory symbol, uint8 decimals_, address holder, uint256 supply)
        ERC20(name, symbol)
    {
        _decimals = decimals_;
        _mint(holder, supply);
    }

    function decimals() public view override returns (uint8) { return _decimals; }
}
