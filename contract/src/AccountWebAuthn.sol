// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {SignerWebAuthn} from "@openzeppelin/contracts/utils/cryptography/signers/SignerWebAuthn.sol";
import {SignerP256} from "@openzeppelin/contracts/utils/cryptography/signers/SignerP256.sol";


contract AccountWebAuthn is
    Initializable,
    Account,
    EIP712,
    ERC7739,
    ERC7821,
    SignerWebAuthn,
    ERC721Holder,
    ERC1155Holder
{
    constructor()
        EIP712("AccountWebAuthn", "1")
        SignerP256(
            0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
            0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
        )
    {}

    function initializeWebAuthn(bytes32 qx, bytes32 qy) public initializer {
        _setSigner(qx, qy);  // Set the P256 public key
    }

    /**
     * @dev Override to allow EntryPoint to execute transactions
     */
     function _erc7821AuthorizedExecutor(
         address caller,
         bytes32 mode,
         bytes calldata executionData
     ) internal view override returns (bool) {
         return
             caller == address(entryPoint()) ||
             super._erc7821AuthorizedExecutor(caller, mode, executionData);
     }
}