// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {FramePayPasskeyWallet as Wallet, FramePayPasskeyFactory} from "../src/FramePayPasskeyWallet.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {AppTestToken} from "../src/AppTestToken.sol";
interface PasskeyVm {
    function signP256(uint256 privateKey, bytes32 digest) external returns (bytes32 r, bytes32 s);
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function prank(address) external;
    function chainId(uint256) external;
    function deal(address, uint256) external;
}
contract PasskeyWalletTest {
    PasskeyVm constant vm = PasskeyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant X = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296;
    bytes32 constant Y = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5;
    uint256 constant N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    Wallet wallet;
    AppTestToken token;
    address constant recipient = address(0xB0B);
    function setUp() public {
        vm.warp(1000);
        wallet = new Wallet(X, Y, sha256("localhost"), keccak256("http://localhost:3000"), keccak256("test-genesis"));
        token = new AppTestToken("USD", "USD", 6, 1000e6);
        vm.prank(address(wallet)); token.claim();
    }
    function batch() internal view returns (Wallet.Call[] memory calls) {
        calls = new Wallet.Call[](1);
        calls[0] = Wallet.Call(address(token), 0, abi.encodeCall(token.transfer, (recipient, 10e6)));
    }
    function sign(bytes32 digest, bytes32 rp, string memory origin, bytes1 flags) internal returns (Wallet.Auth memory a) {
        string memory prefix = '{"type":"webauthn.get",';
        string memory withChallenge = string.concat(prefix, '"challenge":"', Base64.encodeURL(abi.encodePacked(digest)), '",');
        string memory withOrigin = string.concat(withChallenge, '"origin":"', origin, '",');
        a.originIndex = bytes(withChallenge).length;
        a.originLength = bytes(origin).length;
        a.crossOriginIndex = bytes(withOrigin).length;
        a.assertion.typeIndex = 1;
        a.assertion.challengeIndex = bytes(prefix).length;
        a.assertion.clientDataJSON = string.concat(withOrigin, '"crossOrigin":false}');
        a.assertion.authenticatorData = abi.encodePacked(rp, flags, uint32(0));
        (a.assertion.r, a.assertion.s) = vm.signP256(1, sha256(abi.encodePacked(a.assertion.authenticatorData, sha256(bytes(a.assertion.clientDataJSON)))));
        if (uint256(a.assertion.s) > N / 2) a.assertion.s = bytes32(N - uint256(a.assertion.s));
    }
    function auth(Wallet.Call[] memory calls) internal returns (Wallet.Auth memory) {
        return sign(wallet.challenge(calls, 0, 1100), sha256("localhost"), "http://localhost:3000", 0x05);
    }
    function testRealP256SignatureTransfersTokensAndRejectsReplay() public {
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
        Wallet other = new Wallet(X, Y, sha256("localhost"), keccak256("http://localhost:3000"), keccak256("different-genesis"));
        require(!other.verify(calls, 0, 1100, a));
        vm.chainId(1); require(!wallet.verify(calls, 0, 1100, a)); vm.chainId(1337);
        vm.warp(1101); vm.expectRevert(Wallet.Expired.selector); wallet.execute(calls, 0, 1100, a);
    }
    function testUserVerificationAndPresenceRequired() public {
        Wallet.Call[] memory calls = batch(); bytes32 digest = wallet.challenge(calls, 0, 1100);
        require(!wallet.verify(calls, 0, 1100, sign(digest, sha256("localhost"), "http://localhost:3000", 0x01)));
        require(!wallet.verify(calls, 0, 1100, sign(digest, sha256("localhost"), "http://localhost:3000", 0x04)));
        require(!wallet.verify(calls, 0, 1100, sign(digest, sha256("localhost"), "http://localhost:3000", 0x15)));
    }
    function testOriginAndRpIdCheckedBeyondValidSignature() public {
        Wallet.Call[] memory calls = batch(); bytes32 digest = wallet.challenge(calls, 0, 1100);
        require(!wallet.verify(calls, 0, 1100, sign(digest, sha256("evil.test"), "http://localhost:3000", 0x05)));
        require(!wallet.verify(calls, 0, 1100, sign(digest, sha256("localhost"), "http://evil.test:3000", 0x05)));
    }
    function testMalformedProofAndWrongSignatureAreRejected() public {
        Wallet.Call[] memory calls = batch(); Wallet.Auth memory a = auth(calls);
        a.assertion.r = bytes32(uint256(7)); require(!wallet.verify(calls, 0, 1100, a));
        a = auth(calls); a.assertion.authenticatorData = hex"01"; require(!wallet.verify(calls, 0, 1100, a));
        a = auth(calls); a.originIndex = type(uint256).max; require(!wallet.verify(calls, 0, 1100, a));
        a = auth(calls); a.crossOriginIndex = 0; require(!wallet.verify(calls, 0, 1100, a));
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
        FramePayPasskeyFactory factory = new FramePayPasskeyFactory();
        address predicted = factory.predict(X,Y,sha256("localhost"),keccak256("http://localhost:3000"),keccak256("genesis"),bytes32(uint256(1)));
        address deployed = factory.createWallet(X,Y,sha256("localhost"),keccak256("http://localhost:3000"),keccak256("genesis"),bytes32(uint256(1)));
        require(predicted == deployed && Wallet(payable(deployed)).qx() == X);
        require(deployed == factory.createWallet(X,Y,sha256("localhost"),keccak256("http://localhost:3000"),keccak256("genesis"),bytes32(uint256(1))));
    }
}
