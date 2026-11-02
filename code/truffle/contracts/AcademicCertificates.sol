// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

contract AcademicCertificates {
    struct Certificate {
        string uid;
        string candidateName;
        string courseName;
        string organizationName;
        string ipfsHash;
        string cgpa;
        uint16 completionYear;
    }

    mapping(string => Certificate) public certificates;

    event CertificateGenerated(string certificateId);

    // Function to generate a certificate
    function generateCertificate(
        string memory _certificateId,
        string memory _uid,
        string memory _candidateName,
        string memory _courseName,
        string memory _organizationName,
        string memory _ipfsHash,
        string memory _cgpa,
        uint16 _completionYear
    ) public {
        // Check if certificate with the given ID already exists
        require(
            bytes(certificates[_certificateId].ipfsHash).length == 0,
            "Certificate with this ID already exists"
        );

        // Create and store the certificate
        certificates[_certificateId] = Certificate({
            uid: _uid,
            candidateName: _candidateName,
            courseName: _courseName,
            organizationName: _organizationName,
            ipfsHash: _ipfsHash,
            cgpa: _cgpa,
            completionYear: _completionYear
        });

        // Emit an event
        emit CertificateGenerated(_certificateId);
    }

    // Function to get certificate details
    function getCertificate(
        string memory _certificateId
    )
        public
        view
        returns (
            string memory uid,
            string memory candidateName,
            string memory courseName,
            string memory organizationName,
            string memory ipfsHash,
            string memory cgpa,
            uint16 completionYear
        )
    {
        Certificate memory certificate = certificates[_certificateId];

        // Check if the certificate with the given ID exists
        require(
            bytes(certificate.ipfsHash).length != 0,
            "Certificate with this ID does not exist"
        );

        // Return the values from the certificate
        return (
            certificate.uid,
            certificate.candidateName,
            certificate.courseName,
            certificate.organizationName,
            certificate.ipfsHash,
            certificate.cgpa,
            certificate.completionYear
        );
    }

    function verifyCertificate(
        string memory _certificateId
    )
        public
        view
        returns (
            bool isValid,
            string memory candidateName,
            string memory courseName,
            string memory organizationName,
            string memory cgpa,
            uint16 completionYear
        )
    {
        Certificate memory certificate = certificates[_certificateId];

        // Check if the certificate exists
        bool exists = bytes(certificate.ipfsHash).length != 0;

        if (exists) {
            // If the certificate exists, return its details
            return (
                true,
                certificate.candidateName,
                certificate.courseName,
                certificate.organizationName,
                certificate.cgpa,
                certificate.completionYear
            );
        } else {
            // If the certificate does not exist, return false with empty details
            return (false, "", "", "", "", 0);
        }
    }
}
