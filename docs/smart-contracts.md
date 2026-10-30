# Deploy a smart contract

AUREN runs an Ethereum-compatible virtual machine, so the tools you already know work.

## Connect your tools

| | Devnet | Testnet | Mainnet |
|---|---|---|---|
| RPC URL | `https://devnet.auren.im/rpc` | `https://testnet.auren.im/rpc` | `https://mainnet.auren.im/rpc` |
| Chain ID | 77001 | 77002 | 77000 |
| Currency | AUR | AUR | AUR |

In MetaMask: add a network with the RPC URL and chain ID above. Your Ethereum address (`0x…`) is also an AUREN account, so a key you use on Ethereum works here.

## Units

An EVM account balance is shown in **wei**. 1 AUR = 10^18 wei in the EVM, and 1 AUR = 10^9 sparks natively. The conversion is automatic: tools see 18 decimals.

## Hardhat

```js
// hardhat.config.js
module.exports = {
  solidity: '0.8.20',
  networks: { auren: { url: 'https://devnet.auren.im/rpc', chainId: 77001, accounts: [process.env.KEY] } },
};
```

```bash
npx hardhat run scripts/deploy.js --network auren
```

## ethers

```js
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://devnet.auren.im/rpc', 77001);
const signer = new ethers.Wallet(process.env.KEY, provider);
const factory = new ethers.ContractFactory(abi, bytecode, signer);
const contract = await factory.deploy();
await contract.waitForDeployment();
```

Fund the address first by sending it AUR from a wallet (an Ethereum address works as an AUREN account).

## From the command line

```bash
aurenctl evm deploy --data @contract.bin --from me
aurenctl evm call 0xCONTRACT --data 0xCALLDATA
aurenctl evm send 0xCONTRACT --data 0xCALLDATA --value 1 --from me
```

## What is supported

AUREN runs the Shanghai version of the Ethereum virtual machine. The standard precompiled contracts 1 to 5 and 9 are available; the pairing-curve precompiles (6 to 8) are not. The interpreter was compared against the reference implementation on thousands of programs. Details and limits: [EVM](evm.md).

## Fees

A contract call pays for the gas it uses, in AUR, at the current fee level. The wallet or tool estimates gas for you (`eth_estimateGas`). Unused gas is refunded. Fees are burned.

## Tips

- Test on the devnet first; it resets and is free.
- Verify addresses and chain ID before sending. A wrong chain ID makes a transaction invalid, which protects you from replay on other networks.
- Contract calls run one after another, not in parallel, so heavy use of contracts competes for the same block space.
