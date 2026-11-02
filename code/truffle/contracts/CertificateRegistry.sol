// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

// Stores only Merkle roots: certificate data stays off-chain as salted commitments.
// The hashing rules here must match client/src/certcrypto.mjs.
contract CertificateRegistry is Ownable, EIP712 {
    struct Issuer {
        string name;
        bool active;
    }

    struct Batch {
        address issuer;
        uint64 publishedAt;
        uint32 count;
    }

    struct Revocation {
        uint64 revokedAt;
        string reason;
    }

    bytes32 private constant BATCH_TYPEHASH =
        keccak256("Batch(bytes32 root,uint32 count)");

    mapping(address => Issuer) public issuers;
    mapping(bytes32 => Batch) public batches;
    // Keyed by batch root or certificate root
    mapping(bytes32 => Revocation) public revocations;

    event IssuerAdded(address indexed issuer, string name);
    event IssuerRemoved(address indexed issuer);
    event BatchPublished(bytes32 indexed root, address indexed issuer, uint32 count);
    event BatchRevoked(bytes32 indexed root, string reason);
    event CertificateRevoked(bytes32 indexed certRoot, bytes32 indexed batchRoot, string reason);

    constructor() EIP712("AcademicCertificates", "1") {}

    // Function to approve an issuer
    function addIssuer(address _issuer, string memory _name) public onlyOwner {
        require(_issuer != address(0), "Invalid issuer address");
        require(bytes(_name).length != 0, "Issuer name is required");
        issuers[_issuer] = Issuer({name: _name, active: true});
        emit IssuerAdded(_issuer, _name);
    }

    // Function to stop an issuer publishing. Its existing batches remain valid
    // unless they are revoked with revokeBatch.
    function removeIssuer(address _issuer) public onlyOwner {
        require(issuers[_issuer].active, "Issuer is not active");
        issuers[_issuer].active = false;
        emit IssuerRemoved(_issuer);
    }

    // Function to publish a batch. The signature decides who issued it, so any
    // account can submit the transaction and pay the gas.
    function publishBatch(
        bytes32 _root,
        uint32 _count,
        bytes memory _signature
    ) public {
        require(_root != bytes32(0), "Invalid batch root");
        require(_count != 0, "Batch is empty");
        require(batches[_root].publishedAt == 0, "Batch already published");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(BATCH_TYPEHASH, _root, _count))
        );
        address signer = ECDSA.recover(digest, _signature);
        require(issuers[signer].active, "Signer is not an approved issuer");

        batches[_root] = Batch({
            issuer: signer,
            publishedAt: uint64(block.timestamp),
            count: _count
        });

        emit BatchPublished(_root, signer, _count);
    }

    // Function to revoke one certificate. The proof stops an issuer revoking
    // a certificate that belongs to another issuer's batch.
    function revokeCertificate(
        bytes32 _batchRoot,
        bytes32 _certRoot,
        bytes32[] memory _proof,
        string memory _reason
    ) public {
        _requireBatchAuthority(_batchRoot);
        require(
            isIncluded(_batchRoot, _certRoot, _proof),
            "Certificate is not in this batch"
        );
        require(revocations[_certRoot].revokedAt == 0, "Already revoked");

        revocations[_certRoot] = Revocation({
            revokedAt: uint64(block.timestamp),
            reason: _reason
        });

        emit CertificateRevoked(_certRoot, _batchRoot, _reason);
    }

    // Function to revoke a whole batch, for example after an issuer key is stolen
    function revokeBatch(bytes32 _root, string memory _reason) public {
        _requireBatchAuthority(_root);
        require(revocations[_root].revokedAt == 0, "Already revoked");

        revocations[_root] = Revocation({
            revokedAt: uint64(block.timestamp),
            reason: _reason
        });

        emit BatchRevoked(_root, _reason);
    }

    // Function to check a certificate root against a batch root
    function isIncluded(
        bytes32 _batchRoot,
        bytes32 _certRoot,
        bytes32[] memory _proof
    ) public pure returns (bool) {
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0x02), _certRoot));
        for (uint256 i = 0; i < _proof.length; i++) {
            (bytes32 low, bytes32 high) = hash < _proof[i]
                ? (hash, _proof[i])
                : (_proof[i], hash);
            hash = keccak256(abi.encodePacked(bytes1(0x01), low, high));
        }
        return hash == _batchRoot;
    }

    function domainSeparator() public view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // The batch's issuer, or the owner if that issuer's key is lost or stolen
    function _requireBatchAuthority(bytes32 _root) private view {
        address issuer = batches[_root].issuer;
        require(issuer != address(0), "Batch does not exist");
        require(
            msg.sender == owner() ||
                (msg.sender == issuer && issuers[issuer].active),
            "Not allowed to revoke this batch"
        );
    }
}
