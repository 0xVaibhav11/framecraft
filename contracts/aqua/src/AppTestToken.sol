// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Disposable app tokens: a fixed supply and one public faucet claim per account.
contract AppTestToken is ERC20 {
    uint8 private immutable TOKEN_DECIMALS;
    uint256 public immutable claimAmount;
    mapping(address => bool) public claimed;
    error AlreadyClaimed();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 claimAmount_)
        ERC20(name_, symbol_)
    {
        require(block.chainid == 1337 && claimAmount_ > 0, "Local test deployment only");
        TOKEN_DECIMALS = decimals_;
        claimAmount = claimAmount_;
        _mint(address(this), claimAmount_ * 10_000);
    }

    function decimals() public view override returns (uint8) { return TOKEN_DECIMALS; }

    /// @notice Claim test funds once. The caller can sponsor this call with a frame paymaster.
    function claim() external {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        claimed[msg.sender] = true;
        _transfer(address(this), msg.sender, claimAmount);
    }
}
