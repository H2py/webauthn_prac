// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Script.sol";
import "../src/AccountWebAuthn.sol";
import "../src/AccountFactory.sol";
import "../src/MyNFT.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey;

        // Use Anvil's first default account if no private key is provided
        // Anvil account #0: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
        if (vm.envOr("PRIVATE_KEY", uint256(0)) == 0) {
            deployerPrivateKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
            console.log("Using Anvil default account");
        } else {
            deployerPrivateKey = vm.envUint("PRIVATE_KEY");
            console.log("Using provided private key");
        }

        vm.startBroadcast(deployerPrivateKey);

        // Deploy AccountWebAuthn implementation
        AccountWebAuthn accountImpl = new AccountWebAuthn();
        console.log("AccountWebAuthn implementation deployed at:", address(accountImpl));

        // Deploy AccountFactory with the implementation address
        AccountFactory accountFactory = new AccountFactory(address(accountImpl));
        console.log("AccountFactory deployed at:", address(accountFactory));

        // Deploy test NFT
        MyNFT nftContract = new MyNFT(vm.addr(deployerPrivateKey));
        console.log("AccountWebAuthn implementation deployed at:", address(nftContract));

        console.log("Deployed by:", vm.addr(deployerPrivateKey));

        vm.stopBroadcast();
    }
}