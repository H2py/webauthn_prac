// contracts/AccountFactory.sol
// SPDX-License-Identifier: MIT

pragma solidity ^0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @dev A factory contract to create accounts on demand.
 */
contract AccountFactory {
    using Clones for address;
    using Address for address;

    address private immutable _impl;

    constructor(address impl_) {
        require(impl_.code.length > 0);
        _impl = impl_;
    }

    /// @dev Predict the address of the account
    function predictAddress(bytes calldata callData) public view returns (address) {
        return _impl.predictDeterministicAddress(keccak256(callData), address(this));
    }

    /// @dev Create clone accounts on demand
    function cloneAndInitialize(bytes calldata callData) public returns (address) {
        address predicted = predictAddress(callData);
        if (predicted.code.length == 0) {
            _impl.cloneDeterministic(keccak256(callData));
            predicted.functionCall(callData);
        }
        return predicted;
    }
}