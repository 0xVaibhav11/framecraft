// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity ^0.8.30;

// RAILGUN V2 ABI. Pool contracts and circuits remain unchanged.
interface IRailgun {
    struct G1 {
        uint256 x;
        uint256 y;
    }

    struct G2 {
        uint256[2] x;
        uint256[2] y;
    }

    struct Proof {
        G1 a;
        G2 b;
        G1 c;
    }

    struct Token {
        uint8 tokenType;
        address tokenAddress;
        uint256 tokenSubID;
    }

    struct Preimage {
        bytes32 npk;
        Token token;
        uint120 value;
    }

    struct Ciphertext {
        bytes32[4] ciphertext;
        bytes32 blindedSenderViewingKey;
        bytes32 blindedReceiverViewingKey;
        bytes annotationData;
        bytes memo;
    }

    struct BoundParams {
        uint16 treeNumber;
        uint72 minGasPrice;
        uint8 unshield;
        uint64 chainID;
        address adaptContract;
        bytes32 adaptParams;
        Ciphertext[] commitmentCiphertext;
    }

    struct Transaction {
        Proof proof;
        bytes32 merkleRoot;
        bytes32[] nullifiers;
        bytes32[] commitments;
        BoundParams boundParams;
        Preimage unshieldPreimage;
    }
    function transact(Transaction[] calldata transactions) external;
}
