// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SwapVM} from "@1inch/swap-vm/contracts/SwapVM.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import {Context} from "@1inch/swap-vm/contracts/libs/VM.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Aqua-backed recurring limit buys executed by the official SwapVM settlement engine.
/// @dev This router deliberately accepts only one complete RecurringBuy instruction. No jumps,
/// hooks in generated orders, or optional adapter can bypass its capacity and pricing checks.
contract FramePayRecurringSwapVM is SwapVM {
    uint8 public constant RECURRING_BUY = 0xe0;

    struct Policy {
        address buyToken;
        // start: low 64 bits; period seconds: next 32; exclusive expiry: next 64.
        uint256 schedule;
        uint128 periodBudget;
        uint128 totalBudget;
        // Raw token units, accounting for each token's decimals. Maker receives at least
        // buyUnits for every spendUnits paid out. Rounding always favors the maker.
        uint128 buyUnits;
        uint128 spendUnits;
        bytes32 salt;
    }

    struct Usage {
        uint256 epoch;
        uint256 periodSpent;
        uint256 totalSpent;
    }

    mapping(bytes32 orderHash => Usage) public usage;

    error InvalidPolicy();
    error InvalidProgram();
    error WrongDirection();
    error ExactOutputRequired();
    error OutsideSchedule();
    error CapacityExceeded(uint256 requested, uint256 available);

    event RecurringBuyFilled(bytes32 indexed orderHash, uint256 indexed epoch, uint256 spent, uint256 bought);

    /// @param aqua Official Aqua deployment used for maker liquidity accounting and transfers.
    /// @param weth WETH-compatible token; native-token payments are not used by the demo.
    /// @param owner Owner of the inherited stuck-funds rescue facility only.
    constructor(address aqua, address weth, address owner)
        SwapVM(aqua, weth, owner, "FramePay Recurring Buy", "1") {}

    /// @notice Encode a start-anchored schedule with no unused-capacity carryover.
    function packSchedule(uint64 start, uint32 period, uint64 expiry) external pure returns (uint256) {
        return uint256(start) | (uint256(period) << 64) | (uint256(expiry) << 96);
    }

    /// @notice Build the canonical order. The maker must approve Aqua and ship abi.encode(order).
    /// @dev The order hash binds both tokens, every policy field and salt; the maker owns the funds.
    function buildOrder(address maker, address spendToken, Policy memory policy)
        external pure returns (ISwapVM.Order memory)
    {
        _validate(policy);
        if (maker == address(0) || spendToken == address(0) || spendToken == policy.buyToken) revert InvalidPolicy();
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        (args.tokenA, args.tokenB) = spendToken < policy.buyToken
            ? (spendToken, policy.buyToken) : (policy.buyToken, spendToken);
        args.useAquaInsteadOfSignature = true;
        args.program = bytes.concat(bytes1(RECURRING_BUY), bytes1(uint8(224)), abi.encode(policy));
        return MakerTraitsLib.build(args);
    }

    /// @notice Build exact-output taker data, capping the buy tokens the taker pays to the maker.
    /// @param maxInput Maximum raw buy-token amount; the requested swap amount is spend-token output.
    function buildTakerData(address buyToken, address spendToken, uint256 maxInput, uint40 deadline)
        external pure returns (bytes memory)
    {
        TakerTraitsLib.Args memory args;
        args.isAToB = buyToken < spendToken;
        args.useTransferFromAndAquaPush = true;
        args.isFirstTransferFromTaker = true;
        args.threshold = abi.encode(maxInput);
        args.deadline = deadline;
        return TakerTraitsLib.build(args);
    }

    function _validate(Policy memory p) private pure {
        uint64 start = uint64(p.schedule);
        uint32 period = uint32(p.schedule >> 64);
        uint64 expiry = uint64(p.schedule >> 96);
        if (p.buyToken == address(0) || p.schedule >> 160 != 0 || period == 0 || expiry <= start
            || p.periodBudget == 0 || p.totalBudget == 0 || p.periodBudget > p.totalBudget
            || p.buyUnits == 0 || p.spendUnits == 0) revert InvalidPolicy();
    }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode != RECURRING_BUY || args.length != 224 || ctx.program().length != 226
            || ctx.vm.nextPC != 226) revert InvalidProgram();
        Policy memory p = abi.decode(args, (Policy));
        _validate(p);
        if (ctx.query.tokenIn != p.buyToken) revert WrongDirection();
        if (ctx.query.isExactIn) revert ExactOutputRequired();
        uint64 start = uint64(p.schedule);
        if (block.timestamp < start || block.timestamp >= uint64(p.schedule >> 96)) revert OutsideSchedule();
        uint256 epoch = (block.timestamp - start) / uint32(p.schedule >> 64);
        Usage storage used = usage[ctx.query.orderHash];
        uint256 periodSpent = used.epoch == epoch ? used.periodSpent : 0;
        uint256 available = Math.min(p.periodBudget - periodSpent, p.totalBudget - used.totalSpent);
        available = Math.min(available, ctx.swap.balanceOut);
        uint256 spend = ctx.swap.amountOut;
        if (spend == 0 || spend > available) revert CapacityExceeded(spend, available);
        uint256 bought = Math.mulDiv(spend, p.buyUnits, p.spendUnits, Math.Rounding.Ceil);
        ctx.swap.amountIn = bought;
        if (!ctx.vm.isStaticContext) {
            // Effects before the official VM's token transfers. Any settlement failure rolls them back.
            used.epoch = epoch;
            used.periodSpent = periodSpent + spend;
            used.totalSpent += spend;
            emit RecurringBuyFilled(ctx.query.orderHash, epoch, spend, bought);
        }
    }
}
