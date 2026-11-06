// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {FramePayQuantumWallet as Wallet, FramePayQuantumFactory} from "../src/FramePayQuantumWallet.sol";
import {ZKNOX_ethfalcon} from "@ethfalcon/ZKNOX_ethfalcon.sol";
import {AppTestToken} from "../src/AppTestToken.sol";
interface QuantumVm {
    function ffi(string[] calldata) external returns (bytes memory);
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function prank(address) external;
    function chainId(uint256) external;
    function deal(address, uint256) external;
}
contract QuantumWalletTest {
    QuantumVm constant vm = QuantumVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Wallet wallet;
    ZKNOX_ethfalcon verifier;
    uint256[] key;
    function falcon(bytes32 digest) internal returns (bytes memory salt, uint256[] memory signature, uint256[] memory publicKey) {
        string[] memory command = new string[](3);
        command[0] = "node"; command[1] = "../../scripts/quantum/test-sign.mjs";
        bytes memory h = new bytes(64); bytes16 digits = "0123456789abcdef";
        for (uint256 i; i < 32; ++i) { h[i*2] = digits[uint8(digest[i]) >> 4]; h[i*2+1] = digits[uint8(digest[i]) & 15]; }
        command[2] = string(h);
        return abi.decode(vm.ffi(command), (bytes, uint256[], uint256[]));
    }
    AppTestToken token;
    address constant recipient = address(0xB0B);
    function setUp() public {
        vm.warp(1000);
        verifier = new ZKNOX_ethfalcon();
        (,,key) = falcon(bytes32(0));
        wallet = new Wallet( keccak256("test-genesis"), address(verifier), key);
        token = new AppTestToken("USD", "USD", 6, 1000e6);
        vm.prank(address(wallet)); token.claim();
    }
    function batch() internal view returns (Wallet.Call[] memory calls) {
        calls = new Wallet.Call[](1);
        calls[0] = Wallet.Call(address(token), 0, abi.encodeCall(token.transfer, (recipient, 10e6)));
    }
    function sign(bytes32 digest) internal returns (Wallet.Auth memory a) {
        (a.falconSalt,a.falconSignature,) = falcon(digest);
    }
    function auth(Wallet.Call[] memory calls) internal returns (Wallet.Auth memory) {
        return sign(wallet.challenge(calls, 0, 1100));
    }
    function testFalconAloneTransfersTokensAndRejectsReplay() public {
        Wallet.Call[] memory calls = batch();
        Wallet.Auth memory a = auth(calls);
        require(wallet.verify(calls, 0, 1100, a));
        vm.prank(address(0xCAFE)); wallet.execute(calls, 0, 1100, a);
        require(token.balanceOf(recipient) == 10e6 && wallet.nonce() == 1);
        vm.expectRevert(Wallet.WrongNonce.selector); wallet.execute(calls, 0, 1100, a);
    }
    function testChangedRecipientAmountAndCalldataAreRejected() public {
        Wallet.Call[] memory calls = batch(); Wallet.Auth memory a = auth(calls);
        calls[0].data = abi.encodeCall(token.transfer, (address(0xBAD), 10e6));
        require(!wallet.verify(calls, 0, 1100, a));
        calls[0].data = abi.encodeCall(token.transfer, (recipient, 11e6));
        require(!wallet.verify(calls, 0, 1100, a));
        calls[0].value = 1;
        require(!wallet.verify(calls, 0, 1100, a));
        vm.expectRevert(Wallet.InvalidAuthorization.selector); wallet.execute(calls, 0, 1100, a);
    }
    function testExpiryNonceWalletNetworkAndChainAreBound() public {
        Wallet.Call[] memory calls = batch(); Wallet.Auth memory a = auth(calls);
        require(!wallet.verify(calls, 1, 1100, a) && !wallet.verify(calls, 0, 1101, a));
        Wallet other = new Wallet( keccak256("different-genesis"), address(verifier), key);
        require(!other.verify(calls, 0, 1100, a));
        vm.chainId(1); require(!wallet.verify(calls, 0, 1100, a)); vm.chainId(1337);
        vm.warp(1101); vm.expectRevert(Wallet.Expired.selector); wallet.execute(calls, 0, 1100, a);
    }
    function testBatchFailureRollsBackTransferAndNonce() public {
        Wallet.Call[] memory calls = new Wallet.Call[](2);
        calls[0] = batch()[0]; calls[1] = Wallet.Call(address(token), 0, hex"deadbeef");
        Wallet.Auth memory a = auth(calls);
        vm.expectRevert(abi.encodeWithSelector(Wallet.CallFailed.selector, 1, bytes(""))); wallet.execute(calls, 0, 1100, a);
        require(wallet.nonce() == 0 && token.balanceOf(recipient) == 0);
    }
    function testNativeValueComesFromWallet() public {
        vm.deal(address(wallet), 1 ether);
        Wallet.Call[] memory calls = new Wallet.Call[](1); calls[0] = Wallet.Call(recipient, 0.01 ether, "");
        wallet.execute(calls, 0, 1100, auth(calls));
        require(recipient.balance == 0.01 ether && address(wallet).balance == 0.99 ether);
    }
    function testFactoryIsDeterministicAndCannotReplaceOwner() public {
        FramePayQuantumFactory factory = new FramePayQuantumFactory(address(verifier));
        address predicted = factory.predict(keccak256("genesis"),bytes32(uint256(1)),key);
        address deployed = factory.createWallet(keccak256("genesis"),bytes32(uint256(1)),key);
        require(predicted == deployed && Wallet(payable(deployed)).falconKeyHash() == keccak256(abi.encode(key)));
        require(deployed == factory.createWallet(keccak256("genesis"),bytes32(uint256(1)),key));
    }
    function testInvalidAndMissingFalconSignatureRejected() public {
        Wallet.Call[] memory calls = batch(); Wallet.Auth memory a = auth(calls);
        a.falconSignature[0] ^= 1;
        require(!wallet.verify(calls, 0, 1100, a));
        vm.expectRevert(Wallet.InvalidAuthorization.selector); wallet.execute(calls, 0, 1100, a);
        a = auth(calls); a.falconSignature = new uint256[](0);
        require(!wallet.verify(calls, 0, 1100, a));
        require(token.balanceOf(recipient) == 0 && wallet.nonce() == 0);
    }
    function testFalconSignsExactChallengeAndRejectsMalformedEncoding() public {
        Wallet.Call[] memory calls = batch(); Wallet.Auth memory a = auth(calls);
        (a.falconSalt,a.falconSignature,) = falcon(bytes32(uint256(42)));
        require(!wallet.verify(calls, 0, 1100, a));
        a = auth(calls); a.falconSalt = new bytes(39);
        require(!wallet.verify(calls, 0, 1100, a));
        a = auth(calls); a.falconSignature[0] = (a.falconSignature[0] & ~uint256(0xffff)) | 12289;
        require(!wallet.verify(calls, 0, 1100, a));
    }
    function testInvalidPublicKeysCannotDeploy() public {
        uint256[] memory bad = new uint256[](32);
        vm.expectRevert(Wallet.InvalidConfiguration.selector);
        new Wallet(keccak256("genesis"),address(verifier),bad);
        bad[0] = 12289;
        vm.expectRevert(Wallet.InvalidConfiguration.selector);
        new Wallet(keccak256("genesis"),address(verifier),bad);
    }
    function testRealBrowserPrfSignatureMatchesOfficialVerifier() public {
        string[] memory command = new string[](3);
        command[0] = "node"; command[1] = "../../scripts/quantum/test-sign.mjs"; command[2] = "browser-fixture";
        (bytes32 digest, bytes memory salt, uint256[] memory signature, uint256[] memory publicKey) = abi.decode(vm.ffi(command), (bytes32, bytes, uint256[], uint256[]));
        require(verifier.verify(abi.encodePacked(digest), salt, signature, publicKey));
        require(!verifier.verify(abi.encodePacked(bytes32(uint256(digest) ^ 1)), salt, signature, publicKey));
    }
}
